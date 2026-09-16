// Port of src/web/routes/stock.py + src/web/templates/stock.html
//
// One entity at a time. Nine columns across four entities was a grid you had to read sideways
// to check a single figure; per-entity tabs give each one room to show what its number was
// derived from and whether it has been overridden.
//
// Edits live in `edits`, keyed by entity, not in the DOM — switching tabs unmounts the inputs,
// so anything typed on another tab would otherwise be silently discarded on save.
import { html, render } from "../../vendor/lit-html.js";
import * as periodRepo from "../db/period-repo.js";
import * as stockEngine from "../engines/stock.js";
import { pageHead, toast, updateNav } from "../layout.js";
import { router } from "../router.js";

function idr(value) {
  if (value === null || value === undefined) return "—";
  const v = Number(value);
  const formatted = Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return v < 0 ? `(${formatted})` : formatted;
}

const asString = (v) => (v === null || v === undefined ? "" : String(v));

export async function renderStock(mountEl, { period: periodStr }) {
  updateNav(periodStr);
  const period = periodRepo.getByStr(periodStr);
  if (!period) {
    router.navigate("/");
    return;
  }

  let rows = stockEngine.refresh(period.period_id);
  let flash = null;
  let activeCode = rows.length ? rows[0].entityCode : null;
  const edits = new Map(); // entityId -> {opening?, closing?, purchases?, balancingAccount?}
  const periodLocked = period.status === "locked";

  const fieldValue = (row, field) => {
    const edit = edits.get(row.entityId);
    if (edit && field in edit) return edit[field];
    if (field === "balancingAccount") return row.balancingAccount || "inventory";
    return asString(row[field]);
  };

  const setField = (row, field, value) => {
    const edit = edits.get(row.entityId) || {};
    edit[field] = value;
    edits.set(row.entityId, edit);
    view();
  };

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

    if (edits.size === 0) {
      toast("No changes to save", "warn");
      return;
    }

    const parseField = (raw) => {
      if (raw === "" || raw === null || raw === undefined) return { ok: true, value: null };
      const n = parseFloat(raw);
      return Number.isNaN(n) ? { ok: false } : { ok: true, value: n };
    };

    // Validate every edited entity before writing any of them, so a typo on one tab cannot
    // leave a half-saved set of figures behind.
    const writes = [];
    for (const row of rows) {
      if (!edits.has(row.entityId)) continue;
      const opening = parseField(fieldValue(row, "opening"));
      const closing = parseField(fieldValue(row, "closing"));
      const purchases = parseField(fieldValue(row, "purchases"));
      if (!opening.ok || !closing.ok || !purchases.ok) {
        flash = { kind: "error", message: `${row.entityCode}: figures must be numbers.` };
        activeCode = row.entityCode;
        view();
        return;
      }
      writes.push({
        entityId: row.entityId,
        opening: opening.value,
        closing: closing.value,
        purchases: purchases.value,
        balancingAccount: fieldValue(row, "balancingAccount") || null,
      });
    }

    for (const w of writes) {
      stockEngine.saveOverrides(period.period_id, w.entityId, {
        opening: w.opening,
        closing: w.closing,
        purchases: w.purchases,
        balancingAccount: w.balancingAccount,
        user: "browser-user",
      });
    }

    edits.clear();
    rows = stockEngine.refresh(period.period_id);
    flash = null;
    toast(`Saved ${writes.length} entit${writes.length === 1 ? "y" : "ies"}`);
    view();
  };

  const onGenerate = () => {
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

  // An overridden figure hides where the automatic one came from, so show it and offer the way
  // back. Clearing the input is what clears the override — the engine treats empty as "auto".
  const figureField = (row, field, label, autoValue, hasOverride) => html`
    <div class="field">
      <label for="${field}-${row.entityCode}">${label}</label>
      <input
        type="number"
        step="0.01"
        id="${field}-${row.entityCode}"
        ?disabled=${periodLocked}
        .value=${fieldValue(row, field)}
        @input=${(ev) => setField(row, field, ev.target.value)}
      />
      <div class="field-note">
        ${hasOverride
          ? html`<span class="badge badge-warn">Overridden</span>
              auto ${idr(autoValue)}
              ${periodLocked
                ? ""
                : html`<button type="button" class="linkish" @click=${() => setField(row, field, "")}>reset to auto</button>`}`
          : html`From ${field === "opening" ? "the prior period's closing balance sheet" : field === "closing" ? "this period's TB" : "COGS-mapped purchase ledgers"}`}
      </div>
    </div>
  `;

  const entityPanel = (row) => html`
    <div class="card">
      <div class="stock-grid">
        ${figureField(row, "opening", "Opening stock", row.openingAuto, row.openingOverride !== null && row.openingOverride !== undefined)}
        ${figureField(row, "purchases", "Purchases", row.purchasesAuto, row.purchasesOverride !== null && row.purchasesOverride !== undefined)}
        ${figureField(row, "closing", "Closing stock", row.closingAuto, row.closingOverride !== null && row.closingOverride !== undefined)}
        <div class="field">
          <label for="balancing-${row.entityCode}">Balancing account</label>
          <select
            id="balancing-${row.entityCode}"
            ?disabled=${periodLocked}
            .value=${fieldValue(row, "balancingAccount")}
            @change=${(ev) => setField(row, "balancingAccount", ev.target.value)}
          >
            <option value="inventory">Inventory</option>
            <option value="retained_earnings">Retained Earnings</option>
          </select>
          <div class="field-note">Where the adjustment's other side lands.</div>
        </div>
      </div>

      <div class="stock-result">
        <div>
          <p class="label">Computed COGS</p>
          <p class="value num ${row.computedCogs !== null && row.computedCogs < 0 ? "neg" : ""}">${idr(row.computedCogs)}</p>
          <p class="field-note">Opening + Purchases − Closing</p>
        </div>
        <div>
          <p class="label">COGS in TB</p>
          <p class="value num ${row.tbCogs < 0 ? "neg" : ""}">${idr(row.tbCogs)}</p>
        </div>
        <div>
          <p class="label">Adjustment needed</p>
          <p class="value num ${row.delta !== null && row.delta < 0 ? "neg" : ""}">
            ${row.delta !== null && row.delta !== 0 ? idr(row.delta) : "—"}
          </p>
        </div>
      </div>

      ${row.openingBreak !== 0 || row.purchaseLedgerCount === 0 || row.opening === null || row.opening === undefined
        ? html`<div class="stock-warnings">
            ${row.openingBreak !== 0
              ? html`<span class="badge badge-warn">Stock restated — opening break ${idr(row.openingBreak)}</span>`
              : ""}
            ${row.purchaseLedgerCount === 0 ? html`<span class="badge badge-warn">No purchase ledgers mapped to COGS</span>` : ""}
            ${row.opening === null || row.opening === undefined ? html`<span class="badge badge-info">No prior period to open from</span>` : ""}
          </div>`
        : ""}
    </div>
  `;

  const view = () => {
    const { totalComputedCogs, totalTbCogs } = totals();
    const active = rows.find((r) => r.entityCode === activeCode) || rows[0];

    render(
      html`
        ${pageHead({
          title: "Stock / COGS",
          subtitle: "Reconcile opening stock, purchases and closing stock to compute Cost of Goods Sold.",
          actions: periodLocked
            ? html`<span class="toolbar-note">${periodStr} is locked</span>`
            : html`
                ${edits.size ? html`<span class="toolbar-note">${edits.size} unsaved</span>` : ""}
                <button class="btn btn-secondary" type="button" @click=${onGenerate}>Generate adjustment</button>
                <button class="btn" type="submit" form="stock-form" ?disabled=${edits.size === 0}>Save figures</button>
              `,
        })}

        ${flash ? html`<div class="flash flash-${flash.kind}">${flash.message}</div>` : ""}

        ${rows.length === 0
          ? html`<p class="empty">No entities found — import TBs for ${periodStr} first.</p>`
          : html`
              <div class="tabs" role="tablist">
                ${rows.map(
                  (row) => html`
                    <button
                      type="button"
                      role="tab"
                      class="tab ${row.entityCode === active.entityCode ? "is-active" : ""}"
                      aria-selected=${row.entityCode === active.entityCode}
                      @click=${() => {
                        activeCode = row.entityCode;
                        view();
                      }}
                    >
                      ${row.entityCode}
                      ${edits.has(row.entityId) ? html`<span class="tab-dot" title="Unsaved changes">•</span>` : ""}
                      ${row.delta !== null && row.delta !== 0 ? html`<span class="tab-flag" title="Adjustment needed">!</span>` : ""}
                    </button>
                  `
                )}
              </div>

              <form id="stock-form" @submit=${onSave}>${entityPanel(active)}</form>

              <div class="card">
                <h2>All entities</h2>
                <table class="compact">
                  <thead>
                    <tr>
                      <th>Entity</th>
                      <th class="num-col">Opening</th>
                      <th class="num-col">Purchases</th>
                      <th class="num-col">Closing</th>
                      <th class="num-col">Computed COGS</th>
                      <th class="num-col">COGS in TB</th>
                      <th class="num-col">Adjustment</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${rows.map(
                      (row) => html`
                        <tr>
                          <td>${row.entityCode}</td>
                          <td class="num">${idr(row.opening)}</td>
                          <td class="num">${idr(row.purchases)}</td>
                          <td class="num">${idr(row.closing)}</td>
                          <td class="num ${row.computedCogs !== null && row.computedCogs < 0 ? "neg" : ""}">${idr(row.computedCogs)}</td>
                          <td class="num ${row.tbCogs < 0 ? "neg" : ""}">${idr(row.tbCogs)}</td>
                          <td class="num ${row.delta !== null && row.delta < 0 ? "neg" : ""}">
                            ${row.delta !== null && row.delta !== 0 ? idr(row.delta) : "—"}
                          </td>
                        </tr>
                      `
                    )}
                    <tr class="subtotal">
                      <td colspan="4"><strong>Total</strong></td>
                      <td class="num ${totalComputedCogs < 0 ? "neg" : ""}"><strong>${idr(totalComputedCogs)}</strong></td>
                      <td class="num ${totalTbCogs < 0 ? "neg" : ""}"><strong>${idr(totalTbCogs)}</strong></td>
                      <td></td>
                    </tr>
                  </tbody>
                </table>
                <p class="subtitle action-note">
                  Validation <strong>V19</strong> checks that this movement has been booked —
                  <a href="#/periods/${periodStr}/validation">see it on the Validation page</a>.
                </p>
              </div>
            `}
      `,
      mountEl
    );
  };

  view();
}
