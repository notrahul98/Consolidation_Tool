import { html, render } from "../../vendor/lit-html.js";
import * as periodRepo from "../db/period-repo.js";
import * as entityRepo from "../db/entity-repo.js";
import * as groupCoaRepo from "../db/group-coa-repo.js";
import * as consolidatedRepo from "../db/consolidated-repo.js";
import { consolidatePeriod } from "../engines/consolidation.js";
import * as comparative from "../engines/comparative.js";
import { afterPaint, busyButton, pageHead, setPageWidth, updateNav } from "../layout.js";
import { router } from "../router.js";

function idr(value) {
  if (value === null || value === undefined) return "";
  const v = Number(value);
  const formatted = Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return v < 0 ? `(${formatted})` : formatted;
}

function key(groupAccountId, entityId) {
  return `${groupAccountId}:${entityId === null || entityId === undefined ? "null" : entityId}`;
}

function buildRows(periodId, entities) {
  const coaRows = groupCoaRepo.listAll();
  // Entity columns carry that entity's TB plus any adjustment booked against it; the
  // Adjustments column carries only group-level adjustments (which belong to no entity);
  // Total comes straight from the 'total' row, the same figure the P&L and BS read.
  const { byAccountEntity, groupAdjustment, total: totalByAccount } = consolidatedRepo.getBuckets(periodId);

  const rows = [];
  for (const row of coaRows) {
    const entityValues = entities.map((e) => {
      const v = byAccountEntity.get(key(row.group_account_id, e.entity_id));
      return v === undefined ? null : v;
    });
    const totalV = totalByAccount.get(row.group_account_id);
    const total = totalV === undefined ? null : totalV;
    if (row.is_header && total === null && !entityValues.some((v) => v !== null)) continue;
    const adjustment = groupAdjustment.has(row.group_account_id) ? groupAdjustment.get(row.group_account_id) : null;
    rows.push({ code: row.account_code, name: row.account_name, isHeader: !!row.is_header, entityValues, adjustment, total });
  }
  return rows;
}

const MONTH_ABBR = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (key) => `${MONTH_ABBR[parseInt(key.split("-")[1], 10)]}'${key.split("-")[0].slice(2)}`;

// The same accounts read across the year rather than across the entities: one column per month
// of the year to date, each holding that month's consolidated Total.
function buildMatrix(periodId) {
  const { context, columns, totalsByMonth } = comparative.consolidatedMatrix(periodId);
  const rows = [];
  for (const row of groupCoaRepo.listAll()) {
    const values = columns.map((c) => {
      const v = totalsByMonth.get(c).get(row.group_account_id);
      return v === undefined ? null : v;
    });
    if (!values.some((v) => v !== null)) continue;
    rows.push({ code: row.account_code, name: row.account_name, isHeader: !!row.is_header, values });
  }
  return { context, columns, rows };
}

export async function renderConsolidatedTb(mountEl, { period: periodStr }) {
  updateNav(periodStr);
  const period = periodRepo.getByStr(periodStr);
  if (!period) {
    router.navigate("/");
    return;
  }

  setPageWidth("wide");
  const entities = entityRepo.listAll();
  let rows = buildRows(period.period_id, entities);
  let flash = null;
  let busy = false;
  let mode = "single";

  const onRecalculate = () => {
    busy = true;
    view();
    afterPaint(runRecalculate);
  };

  const runRecalculate = () => {
    const result = consolidatePeriod(period.period_id);
    if (result.blocked) {
      if (result.reason === "locked") {
        flash = { kind: "error", message: `Period ${periodStr} is locked — unlock it first if you really need to re-consolidate` };
      } else {
        const names = result.unmappedMaterial.slice(0, 5).map(([n, b]) => `${n} (${idr(b)})`).join("; ");
        flash = { kind: "error", message: `Blocked — ${result.unmappedMaterial.length} uncategorized material ledger(s): ${names}` };
      }
    } else {
      flash = { kind: "success", message: `Consolidated: ${result.rowsWritten} rows written` };
    }
    rows = buildRows(period.period_id, entities);
    busy = false;
    view();
  };

  const singleTable = () => html`
    <table class="compact conso">
      <thead>
        <tr>
          <th>Code</th>
          <th>Account</th>
          ${entities.map((e) => html`<th class="num-col">${e.entity_code}</th>`)}
          <th class="num-col">Adjustments</th>
          <th class="num-col">Total</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (row) => html`
            <tr class=${row.isHeader ? "section" : ""}>
              <td class="num">${row.code}</td>
              <td>${row.name}</td>
              ${row.entityValues.map((v) => html`<td class="num ${v && v < 0 ? "neg" : ""}">${idr(v)}</td>`)}
              <td class="num ${row.adjustment && row.adjustment < 0 ? "neg" : ""}">${idr(row.adjustment)}</td>
              <td class="num ${row.total && row.total < 0 ? "neg" : ""}">${idr(row.total)}</td>
            </tr>
          `
        )}
      </tbody>
    </table>
  `;

  const matrixTable = (matrix) => html`
    <table class="compact conso">
      <thead>
        <tr>
          <th>Code</th>
          <th>Account</th>
          ${matrix.columns.map((c) => html`<th class="num-col">${monthLabel(c)}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${matrix.rows.map(
          (row) => html`
            <tr class=${row.isHeader ? "section" : ""}>
              <td class="num">${row.code}</td>
              <td>${row.name}</td>
              ${row.values.map(
                (v) => html`<td class="num ${v && v < 0 ? "neg" : ""}">
                  ${v === null ? html`<span class="dash">&mdash;</span>` : idr(v)}
                </td>`
              )}
            </tr>
          `
        )}
      </tbody>
    </table>
  `;

  const view = () => {
    const matrix = mode === "matrix" ? buildMatrix(period.period_id) : null;
    render(
      html`
        ${pageHead({
          title: "Consolidated Trial Balance",
          subtitle: matrix
            ? `Each account's consolidated Total, month by month across the year to date. Balances are raw
               Dr-positive, not statement-display sign. There is deliberately no year-to-date column - these rows mix
               balance sheet and P&L accounts, and summing a balance sheet account across months is meaningless.`
            : `Raw Dr-positive signed balances (matches Conso_TB_Matrix in the Excel pack), not statement-display
               sign. Entity columns already include adjustments booked against that entity; the Adjustments column
               holds only group-level ones, so every row reads across as entities + adjustments = total.`,
          actions: matrix
            ? html`<button class="btn btn-secondary" type="button" @click=${() => { mode = "single"; view(); }}>
                Single period
              </button>`
            : html`
                <button class="btn btn-secondary" type="button" @click=${() => { mode = "matrix"; view(); }}>
                  Monthly matrix
                </button>
                ${busyButton({ label: "Recalculate", busyLabel: "Consolidating…", busy, onClick: onRecalculate })}
              `,
        })}

        ${flash ? html`<div class="flash flash-${flash.kind}">${flash.message}</div>` : ""}
        ${matrix && matrix.context.missing.length
          ? html`<div class="flash flash-warn">
              No consolidated data for <strong>${matrix.context.missing.join(", ")}</strong> — those months have no
              column.
            </div>`
          : ""}
        ${matrix && matrix.context.openInRange.length
          ? html`<div class="flash flash-warn">
              Open (unlocked) periods in range: <strong>${matrix.context.openInRange.join(", ")}</strong>. These
              figures can still change.
            </div>`
          : ""}

        <div class="card">
          <div class="table-wrap sticky-wrap">
            ${matrix ? matrixTable(matrix) : singleTable()}
          </div>
        </div>
      `,
      mountEl
    );
  };

  view();
}
