// Port of src/web/routes/mapping.py + src/web/templates/mapping.html.
//
// A ledger name that is booked differently across entities (different Tally primary group,
// or already mapped to different categories) is rendered as a parent row plus one editable
// child row per entity, and can ONLY be saved per entity. Saving one category across every
// entity carrying that name is refused for such ledgers — that whole-ledger write is what
// silently flattened the per-entity split and, for example, moved VKS's shareholder-loan
// interest out of the P&L into a balance sheet liability.
import { html, render } from "../../vendor/lit-html.js";
import * as periodRepo from "../db/period-repo.js";
import * as mappingRepo from "../db/mapping-repo.js";
import * as entityRepo from "../db/entity-repo.js";
import * as groupCoaRepo from "../db/group-coa-repo.js";
import { updateNav } from "../layout.js";
import { router } from "../router.js";
import { codepointCompare } from "../utils.js";

function buildRows(periodId) {
  const ledgers = mappingRepo.ledgerRowsForPeriod(periodId);
  ledgers.sort((a, b) => codepointCompare(a.ledgerName, b.ledgerName));

  const rows = [];
  for (const entry of ledgers) {
    if (entry.needsSplit) {
      rows.push({
        kind: "parent",
        ledgerName: entry.ledgerName,
        totalBalance: entry.totalBalance,
        badge: "Split across entities",
      });
      for (const ent of entry.entities) {
        rows.push({
          kind: "child",
          ledgerName: entry.ledgerName,
          entityCode: ent.entityCode,
          primaryGroup: ent.primaryGroup,
          balance: ent.balance,
          currentCategory: ent.categoryName || "",
        });
      }
    } else {
      const first = entry.entities[0];
      rows.push({
        kind: "simple",
        ledgerName: entry.ledgerName,
        entityCode: first ? first.entityCode : "",
        primaryGroup: first ? first.primaryGroup : "",
        totalBalance: entry.totalBalance,
        currentCategory: entry.uniformCategory || "",
      });
    }
  }
  return rows;
}

function idr(value) {
  if (value === null || value === undefined) return "";
  const v = Number(value);
  const formatted = Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return v < 0 ? `(${formatted})` : formatted;
}

export async function renderMapping(mountEl, { period: periodStr }) {
  updateNav(periodStr);
  const period = periodRepo.getByStr(periodStr);
  if (!period) {
    router.navigate("/");
    return;
  }
  mappingRepo.ensureRowsExist(period.period_id);

  let rows = buildRows(period.period_id);
  const categories = groupCoaRepo.listLeafCategories().map((c) => c.account_name);
  let flash = null;

  const onSubmit = (ev) => {
    ev.preventDefault();
    try {
      periodRepo.requireOpen(period.period_id, "change categorization");
    } catch (err) {
      flash = { kind: "error", message: err.message };
      view();
      return;
    }

    // Recomputed here, not trusted from the rendered rows, so a ledger that became split
    // since this page was drawn still can't be written across all entities.
    const splitLedgers = new Set(
      mappingRepo.ledgerRowsForPeriod(period.period_id).filter((r) => r.needsSplit).map((r) => r.ledgerName)
    );

    const pending = [];
    for (const tr of ev.target.querySelectorAll("tr[data-ledger]")) {
      const catName = tr.querySelector("select").value;
      if (!catName) continue;
      const cat = groupCoaRepo.getByName(catName);
      if (!cat) continue;
      const ledgerName = tr.dataset.ledger;
      const entityCode = tr.dataset.entity || "";

      if (splitLedgers.has(ledgerName) && !entityCode) {
        flash = {
          kind: "error",
          message:
            `Cannot apply a single category to '${ledgerName}' across all entities — ` +
            `it has different mappings. Update each entity separately.`,
        };
        view();
        return;
      }
      pending.push({ ledgerName, entityCode, groupAccountId: cat.group_account_id });
    }

    // Nothing is written until every row has passed the guard above, so a rejected save
    // leaves the existing mappings completely untouched.
    let applied = 0;
    for (const p of pending) {
      if (p.entityCode) {
        const entity = entityRepo.getByCode(p.entityCode);
        if (!entity) continue;
        mappingRepo.applyMappingForEntity(entity.entity_id, p.ledgerName, p.groupAccountId, "browser-user");
      } else {
        mappingRepo.applyMapping(p.ledgerName, p.groupAccountId, "browser-user");
      }
      applied++;
    }

    rows = buildRows(period.period_id);
    flash = { kind: "success", message: `Categorized ${applied} ledger(s)` };
    view();
  };

  const categoryCell = (row) => html`
    <select>
      <option value="">— uncategorized —</option>
      ${categories.map((c) => html`<option value=${c} ?selected=${c === row.currentCategory}>${c}</option>`)}
    </select>
  `;

  const renderRow = (row) => {
    if (row.kind === "parent") {
      return html`
        <tr class="parent-row">
          <td><strong>${row.ledgerName}</strong></td>
          <td></td>
          <td></td>
          <td class="num ${row.totalBalance < 0 ? "neg" : ""}"><strong>${idr(row.totalBalance)}</strong></td>
          <td><span class="badge badge-warn">${row.badge}</span></td>
          <td></td>
        </tr>
      `;
    }
    if (row.kind === "child") {
      return html`
        <tr class="child-row" style="background:#fafafa" data-ledger=${row.ledgerName} data-entity=${row.entityCode}>
          <td style="padding-left:2em">↳</td>
          <td>${row.entityCode}</td>
          <td>${row.primaryGroup}</td>
          <td class="num ${row.balance < 0 ? "neg" : ""}">${idr(row.balance)}</td>
          <td></td>
          <td>${categoryCell(row)}</td>
        </tr>
      `;
    }
    return html`
      <tr data-ledger=${row.ledgerName} data-entity="">
        <td>${row.ledgerName}</td>
        <td>${row.entityCode}</td>
        <td>${row.primaryGroup}</td>
        <td class="num ${row.totalBalance < 0 ? "neg" : ""}">${idr(row.totalBalance)}</td>
        <td></td>
        <td>${categoryCell(row)}</td>
      </tr>
    `;
  };

  const view = () =>
    render(
      html`
        <h1>Ledger Mapping</h1>
        <p class="subtitle">
          Categorize each distinct ledger into a fixed P&amp;L/Balance Sheet category. Ledgers that appear in
          different entities with different mappings are categorized per entity.
        </p>

        ${flash ? html`<div class="flash flash-${flash.kind}">${flash.message}</div>` : ""}

        ${rows.length === 0
          ? html`<p class="empty">No ledgers found — import TBs for ${periodStr} first.</p>`
          : html`
              <form @submit=${onSubmit}>
                <div class="card">
                  <div class="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Ledger Name</th>
                          <th>Entities</th>
                          <th>Tally Primary Group</th>
                          <th class="num-col">Balance</th>
                          <th>Check</th>
                          <th style="min-width:260px">Category</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${rows.map(renderRow)}
                      </tbody>
                    </table>
                  </div>
                </div>
                <button class="btn" type="submit">Save categorization</button>
              </form>
            `}
      `,
      mountEl
    );

  view();
}
