// Port of src/web/routes/stock.py + src/web/templates/stock.html
import { html, render } from "../../vendor/lit-html.js";
import * as periodRepo from "../db/period-repo.js";
import * as stockEngine from "../engines/stock.js";
import { updateNav } from "../layout.js";
import { router } from "../router.js";

function idr(value) {
  if (value === null || value === undefined) return "";
  const v = Number(value);
  const formatted = Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return v < 0 ? `(${formatted})` : formatted;
}

export async function renderStock(mountEl, { period: periodStr }) {
  updateNav(periodStr);
  const period = periodRepo.getByStr(periodStr);
  if (!period) {
    router.navigate("/");
    return;
  }

  let rows = stockEngine.refresh(period.period_id);
  let flash = null;
  const periodLocked = period.status === "locked";

  const totals = () => {
    let totalComputedCogs = 0.0;
    let totalTbCogs = 0.0;
    for (const row of rows) {
      if (row.computedCogs !== null) totalComputedCogs += row.computedCogs;
      totalTbCogs += row.tbCogs;
    }
    return { totalComputedCogs, totalTbCogs };
  };

  const onSave = (ev) => {
    ev.preventDefault();
    try {
      periodRepo.requireOpen(period.period_id, "change stock figures");
    } catch (err) {
      flash = { kind: "error", message: err.message };
      view();
      return;
    }

    const form = ev.target;
    const entityRows = form.querySelectorAll("[data-entity-id]");
    let saved = 0;
    entityRows.forEach((rowEl) => {
      const entityId = parseInt(rowEl.dataset.entityId, 10);
      const openStr = rowEl.querySelector('input[name="opening"]').value;
      const closeStr = rowEl.querySelector('input[name="closing"]').value;
      const purchStr = rowEl.querySelector('input[name="purchases"]').value;
      const balStr = rowEl.querySelector('select[name="balancing"]').value;

      const openVal = openStr ? parseFloat(openStr) : null;
      const closeVal = closeStr ? parseFloat(closeStr) : null;
      const purchVal = purchStr ? parseFloat(purchStr) : null;
      if ((openStr && Number.isNaN(openVal)) || (closeStr && Number.isNaN(closeVal)) || (purchStr && Number.isNaN(purchVal))) {
        return;
      }

      stockEngine.saveOverrides(period.period_id, entityId, {
        opening: openVal,
        closing: closeVal,
        purchases: purchVal,
        balancingAccount: balStr || null,
        user: "browser-user",
      });
      saved++;
    });

    rows = stockEngine.refresh(period.period_id);
    flash = { kind: "success", message: `Saved ${saved} entity(ies)` };
    view();
  };

  const onGenerate = (ev) => {
    ev.preventDefault();
    try {
      periodRepo.requireOpen(period.period_id, "generate stock adjustment");
    } catch (err) {
      flash = { kind: "error", message: err.message };
      view();
      return;
    }

    const ref = `ADJ-${period.year}-${String(period.month).padStart(2, "0")}-STOCK`;
    try {
      stockEngine.generateAdjustment(period.period_id, ref, "browser-user");
    } catch (err) {
      flash = { kind: "error", message: `Error generating adjustment: ${err.message}` };
      view();
      return;
    }
    router.navigate(`/periods/${periodStr}/adjustments`);
  };

  const view = () => {
    const { totalComputedCogs, totalTbCogs } = totals();
    render(
      html`
        <h1>Stock / COGS</h1>
        <p class="subtitle">Reconcile opening stock, closing stock, and purchases to compute Cost of Goods Sold.</p>

        ${flash ? html`<div class="flash flash-${flash.kind}">${flash.message}</div>` : ""}

        ${rows.length === 0
          ? html`<p class="empty">No entities found — import TBs for ${periodStr} first.</p>`
          : html`
              <form @submit=${onSave}>
                <div class="card">
                  <div class="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Entity</th>
                          <th class="num-col">Opening Stock</th>
                          <th class="num-col">Closing Stock</th>
                          <th class="num-col">Purchases</th>
                          <th class="num-col">Computed COGS</th>
                          <th class="num-col">COGS in TB</th>
                          <th class="num-col">Adjustment</th>
                          <th>Balancing A/c</th>
                          <th>Warnings</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${rows.map((row) => {
                          const openingHasOverride = row.openingOverride !== null && row.openingOverride !== undefined;
                          const closingHasOverride = row.closingOverride !== null && row.closingOverride !== undefined;
                          const purchasesHasOverride = row.purchasesOverride !== null && row.purchasesOverride !== undefined;
                          return html`
                            <tr data-entity-id=${row.entityId}>
                              <td>${row.entityCode}</td>
                              <td class="num">
                                <input type="number" step="0.01" name="opening" ?disabled=${periodLocked} .value=${row.opening ?? ""} />
                                ${openingHasOverride
                                  ? html`<br /><small class="reset-link">auto: ${idr(row.openingAuto)}</small>`
                                  : ""}
                              </td>
                              <td class="num">
                                <input type="number" step="0.01" name="closing" ?disabled=${periodLocked} .value=${row.closing ?? ""} />
                                ${closingHasOverride
                                  ? html`<br /><small class="reset-link">auto: ${idr(row.closingAuto)}</small>`
                                  : ""}
                              </td>
                              <td class="num">
                                <input type="number" step="0.01" name="purchases" ?disabled=${periodLocked} .value=${row.purchases ?? ""} />
                                ${purchasesHasOverride
                                  ? html`<br /><small class="reset-link">auto: ${idr(row.purchasesAuto)}</small>`
                                  : ""}
                              </td>
                              <td class="num ${row.computedCogs !== null && row.computedCogs < 0 ? "neg" : ""}">
                                ${row.computedCogs !== null ? idr(row.computedCogs) : "—"}
                              </td>
                              <td class="num ${row.tbCogs < 0 ? "neg" : ""}">${idr(row.tbCogs)}</td>
                              <td class="num ${row.delta !== null && row.delta < 0 ? "neg" : ""}">
                                ${row.delta !== null && row.delta !== 0 ? idr(row.delta) : "—"}
                              </td>
                              <td>
                                <select name="balancing" ?disabled=${periodLocked}>
                                  <option value="inventory" ?selected=${row.balancingAccount === "inventory"}>Inventory</option>
                                  <option value="retained_earnings" ?selected=${row.balancingAccount === "retained_earnings"}>
                                    Retained Earnings
                                  </option>
                                </select>
                              </td>
                              <td>
                                ${row.openingBreak !== 0
                                  ? html`<span class="badge badge-warn">Stock restated (break: ${idr(row.openingBreak)})</span><br />`
                                  : ""}
                                ${row.purchaseLedgerCount === 0
                                  ? html`<span class="badge badge-warn">No purchases mapped</span><br />`
                                  : ""}
                                ${row.opening === null || row.opening === undefined
                                  ? html`<span class="badge badge-info">No prior period</span>`
                                  : ""}
                                ${row.openingBreak === 0 && row.purchaseLedgerCount !== 0 && (row.opening !== null && row.opening !== undefined)
                                  ? "—"
                                  : ""}
                              </td>
                            </tr>
                          `;
                        })}
                        <tr class="footer-row">
                          <td><strong>Total</strong></td>
                          <td colspan="2"></td>
                          <td></td>
                          <td class="num ${totalComputedCogs < 0 ? "neg" : ""}"><strong>${idr(totalComputedCogs)}</strong></td>
                          <td class="num ${totalTbCogs < 0 ? "neg" : ""}"><strong>${idr(totalTbCogs)}</strong></td>
                          <td colspan="3"></td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
                ${periodLocked ? "" : html`<button class="btn" type="submit">Save figures</button>`}
              </form>

              ${periodLocked
                ? ""
                : html`
                    <form style="margin-top: 1em;" @submit=${onGenerate}>
                      <button class="btn btn-secondary" type="submit">Generate adjustment</button>
                    </form>
                  `}
            `}
      `,
      mountEl
    );
  };

  view();
}
