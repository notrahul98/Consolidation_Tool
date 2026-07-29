import { html, render } from "../../vendor/lit-html.js";
import * as periodRepo from "../db/period-repo.js";
import * as mappingRepo from "../db/mapping-repo.js";
import * as groupCoaRepo from "../db/group-coa-repo.js";
import { updateNav } from "../layout.js";
import { router } from "../router.js";
import { codepointCompare } from "../utils.js";

function buildRows(periodId) {
  const ledgers = mappingRepo.distinctLedgersForPeriod(periodId);
  ledgers.sort((a, b) => codepointCompare(a.ledgerName, b.ledgerName));

  return ledgers.map((entry) => {
    let currentCategory = "";
    const multiple = entry.groupAccountIds.size > 1;
    if (entry.groupAccountIds.size === 1) {
      const cat = groupCoaRepo.getById(entry.groupAccountIds.values().next().value);
      currentCategory = cat ? cat.account_name : "";
    }
    return {
      ledgerName: entry.ledgerName,
      entities: Array.from(new Set(entry.entities)).sort().join(", "),
      primaryGroup: Array.from(entry.primaryGroups).sort().join(", "),
      balance: entry.totalBalance,
      currentCategory,
      check: entry.primaryGroups.size > 1 ? "differs across entities" : multiple ? "inconsistently categorized" : "",
    };
  });
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

    const form = ev.target;
    const ledgerNames = form.querySelectorAll('input[name="ledger_name"]');
    let applied = 0;
    ledgerNames.forEach((input) => {
      const select = input.nextElementSibling;
      const catName = select.value;
      if (!catName) return;
      const cat = groupCoaRepo.getByName(catName);
      if (!cat) return;
      mappingRepo.applyMapping(input.value, cat.group_account_id, "browser-user");
      applied++;
    });

    rows = buildRows(period.period_id);
    flash = { kind: "success", message: `Categorized ${applied} ledger(s)` };
    view();
  };

  const view = () =>
    render(
      html`
        <h1>Ledger Mapping</h1>
        <p class="subtitle">
          Categorize each distinct ledger into a fixed P&amp;L/Balance Sheet category. Changing a category and
          saving re-applies it to every entity that carries that ledger name.
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
                        ${rows.map(
                          (row) => html`
                            <tr>
                              <td>${row.ledgerName}</td>
                              <td>${row.entities}</td>
                              <td>${row.primaryGroup}</td>
                              <td class="num ${row.balance < 0 ? "neg" : ""}">${idr(row.balance)}</td>
                              <td>${row.check ? html`<span class="badge badge-warn">${row.check}</span>` : ""}</td>
                              <td>
                                <input type="hidden" name="ledger_name" .value=${row.ledgerName} />
                                <select>
                                  <option value="">— uncategorized —</option>
                                  ${categories.map(
                                    (c) => html`<option value=${c} ?selected=${c === row.currentCategory}>${c}</option>`
                                  )}
                                </select>
                              </td>
                            </tr>
                          `
                        )}
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
