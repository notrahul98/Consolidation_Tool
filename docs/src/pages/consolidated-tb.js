import { html, render } from "../../vendor/lit-html.js";
import * as periodRepo from "../db/period-repo.js";
import * as entityRepo from "../db/entity-repo.js";
import * as groupCoaRepo from "../db/group-coa-repo.js";
import * as consolidatedRepo from "../db/consolidated-repo.js";
import { consolidatePeriod } from "../engines/consolidation.js";
import { updateNav } from "../layout.js";
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

export async function renderConsolidatedTb(mountEl, { period: periodStr }) {
  updateNav(periodStr);
  const period = periodRepo.getByStr(periodStr);
  if (!period) {
    router.navigate("/");
    return;
  }

  const entities = entityRepo.listAll();
  let rows = buildRows(period.period_id, entities);
  let flash = null;

  const onRecalculate = (ev) => {
    ev.preventDefault();
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
    view();
  };

  const view = () =>
    render(
      html`
        <h1>Consolidated Trial Balance</h1>
        <p class="subtitle">
          Raw Dr-positive signed balances (matches Conso_TB_Matrix in the Excel pack), not statement-display sign.
          Entity columns already include adjustments booked against that entity; the Adjustments column holds only
          group-level ones, so every row reads across as entities + adjustments = total.
        </p>

        ${flash ? html`<div class="flash flash-${flash.kind}">${flash.message}</div>` : ""}

        <form style="margin-bottom:16px" @submit=${onRecalculate}>
          <button class="btn" type="submit">Recalculate</button>
        </form>

        <div class="card">
          <div class="table-wrap">
            <table>
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
                      ${row.entityValues.map(
                        (v) => html`<td class="num ${v && v < 0 ? "neg" : ""}">${idr(v)}</td>`
                      )}
                      <td class="num ${row.adjustment && row.adjustment < 0 ? "neg" : ""}">${idr(row.adjustment)}</td>
                      <td class="num ${row.total && row.total < 0 ? "neg" : ""}">${idr(row.total)}</td>
                    </tr>
                  `
                )}
              </tbody>
            </table>
          </div>
        </div>
      `,
      mountEl
    );

  view();
}
