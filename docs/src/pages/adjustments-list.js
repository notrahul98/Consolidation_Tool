import { html, render } from "../../vendor/lit-html.js";
import * as periodRepo from "../db/period-repo.js";
import * as adjustmentRepo from "../db/adjustment-repo.js";
import * as groupCoaRepo from "../db/group-coa-repo.js";
import { persistence } from "../db/persistence.js";
import { copyPriorMonth } from "../engines/adjustments.js";
import { updateNav } from "../layout.js";
import { router } from "../router.js";

function idr(value) {
  if (value === null || value === undefined) return "";
  const v = Number(value);
  const formatted = Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2 });
  return v < 0 ? `(${formatted})` : formatted;
}

function buildAdjustments(periodId) {
  return adjustmentRepo.listForPeriod(periodId).map((adj) => {
    const lines = adjustmentRepo.getLines(adj.adjustment_id);
    const totalDr = lines.reduce((s, l) => s + (l.debit_amount || 0), 0);
    const lineSummaries = lines.map((l) => {
      const cat = groupCoaRepo.getById(l.group_account_id);
      let entityCode = "";
      if (l.entity_id) {
        const e = persistence.get("SELECT entity_code FROM entities WHERE entity_id = ?", [l.entity_id]);
        entityCode = e ? e.entity_code : "";
      }
      return {
        entity: entityCode || "(group)",
        category: cat ? cat.account_name : "?",
        debit: l.debit_amount,
        credit: l.credit_amount,
      };
    });
    return { ref: adj.external_ref, type: adj.adjustment_type, narration: adj.narration, status: adj.status, total: totalDr, lines: lineSummaries };
  });
}

export async function renderAdjustmentsList(mountEl, { period: periodStr }) {
  updateNav(periodStr);
  const period = periodRepo.getByStr(periodStr);
  if (!period) {
    router.navigate("/");
    return;
  }

  let adjustments = buildAdjustments(period.period_id);
  let flash = null;
  let pendingDeleteRef = null;
  const prior = periodRepo.getPrior(period.period_id);
  const hasPrior = !!prior;

  const refresh = () => {
    adjustments = buildAdjustments(period.period_id);
    // Re-run so the stale-consolidation banner picks up changes from actions that mutate
    // adjustments without a full page navigation (updateNav only runs automatically on
    // route change, not on in-page state updates).
    updateNav(periodStr);
  };

  const onApplyAll = (ev) => {
    ev.preventDefault();
    try {
      const n = adjustmentRepo.applyAll(period.period_id, "browser-user");
      flash = { kind: "success", message: `Applied ${n} draft adjustment(s) — re-run Consolidate to see the effect` };
    } catch (err) {
      flash = { kind: "error", message: err.message };
    }
    refresh();
    view();
  };

  const onCopyPrior = (ev) => {
    ev.preventDefault();
    try {
      const n = copyPriorMonth(period.period_id, "browser-user");
      flash = { kind: "success", message: `Copied ${n} adjustment(s) from the prior period as drafts` };
    } catch (err) {
      flash = { kind: "error", message: err.message };
    }
    refresh();
    view();
  };

  const onDeleteClick = (ref) => {
    pendingDeleteRef = ref;
    view();
  };

  const onCancelDelete = () => {
    pendingDeleteRef = null;
    view();
  };

  const onConfirmDelete = (ref) => {
    const row = persistence.get("SELECT adjustment_id FROM adjustments WHERE period_id = ? AND external_ref = ?", [
      period.period_id,
      ref,
    ]);
    pendingDeleteRef = null;
    if (row) {
      try {
        adjustmentRepo.deleteAdjustment(period.period_id, row.adjustment_id, "browser-user");
        flash = { kind: "success", message: `Deleted ${ref}` };
      } catch (err) {
        flash = { kind: "error", message: err.message };
      }
    } else {
      flash = { kind: "error", message: `No adjustment ${ref} found` };
    }
    refresh();
    view();
  };

  const view = () =>
    render(
      html`
        <h1>Adjustments</h1>
        <p class="subtitle">Structured journal entries replacing manual TB edits. Every entry must balance and carry a narration.</p>

        ${flash ? html`<div class="flash flash-${flash.kind}">${flash.message}</div>` : ""}

        <div class="field-row" style="margin-bottom:20px">
          <a class="btn" href="#/periods/${periodStr}/adjustments/new">+ New adjustment</a>
          <form class="inline" @submit=${onApplyAll}>
            <button class="btn btn-secondary" type="submit">Apply all drafts</button>
          </form>
          ${hasPrior
            ? html`<form class="inline" @submit=${onCopyPrior}>
                <button class="btn btn-secondary" type="submit">Copy from prior period</button>
              </form>`
            : ""}
        </div>

        ${adjustments.length === 0
          ? html`<p class="empty">No adjustments yet for ${periodStr}.</p>`
          : adjustments.map(
              (adj) => html`
                <div class="card">
                  <div class="field-row" style="justify-content:space-between;align-items:center;margin-bottom:10px">
                    <div>
                      <strong class="num">${adj.ref}</strong>
                      <span class="badge badge-${adj.status === "applied" ? "applied" : "draft"}">${adj.status}</span>
                      <span class="subtitle" style="display:inline;margin-left:8px">${adj.type}</span>
                    </div>
                    <div class="field-row">
                      ${period.status !== "locked"
                        ? html`<a class="btn btn-secondary btn-sm" href="#/periods/${periodStr}/adjustments/${adj.ref}/edit">Edit</a>`
                        : ""}
                      <button
                        class="btn btn-danger btn-sm"
                        type="button"
                        ?disabled=${period.status === "locked"}
                        @click=${() => onDeleteClick(adj.ref)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  ${pendingDeleteRef === adj.ref
                    ? html`<div class="flash flash-error">
                        Delete ${adj.ref}?
                        <button class="btn btn-danger btn-sm" style="margin-left:10px" @click=${() => onConfirmDelete(adj.ref)}>
                          Confirm delete
                        </button>
                        <button class="btn btn-secondary btn-sm" style="margin-left:6px" @click=${onCancelDelete}>Cancel</button>
                      </div>`
                    : ""}
                  <p style="margin:0 0 10px">${adj.narration}</p>
                  <table>
                    <thead>
                      <tr><th>Entity</th><th>Category</th><th class="num-col">Debit</th><th class="num-col">Credit</th></tr>
                    </thead>
                    <tbody>
                      ${adj.lines.map(
                        (l) => html`<tr>
                          <td>${l.entity}</td>
                          <td>${l.category}</td>
                          <td class="num">${idr(l.debit)}</td>
                          <td class="num">${idr(l.credit)}</td>
                        </tr>`
                      )}
                    </tbody>
                  </table>
                </div>
              `
            )}
      `,
      mountEl
    );

  view();
}
