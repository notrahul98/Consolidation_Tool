import { html, render } from "../../vendor/lit-html.js";
import * as periodRepo from "../db/period-repo.js";
import * as adjustmentRepo from "../db/adjustment-repo.js";
import * as groupCoaRepo from "../db/group-coa-repo.js";
import { persistence } from "../db/persistence.js";
import { copyPriorMonth } from "../engines/adjustments.js";
import { filterPills, pageHead, toast, updateNav } from "../layout.js";
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
  let filter = "all";
  let search = "";
  // Lines are hidden until asked for: with a dozen adjustments the old one-card-each layout
  // meant scrolling past every journal to find the one you wanted.
  const expanded = new Set();
  const prior = periodRepo.getPrior(period.period_id);
  const hasPrior = !!prior;

  const refresh = () => {
    adjustments = buildAdjustments(period.period_id);
    // Re-run so the stale-consolidation banner picks up changes from actions that mutate
    // adjustments without a full page navigation (updateNav only runs automatically on
    // route change, not on in-page state updates).
    updateNav(periodStr);
  };

  const onApplyAll = () => {
    try {
      const n = adjustmentRepo.applyAll(period.period_id, "browser-user");
      flash = null;
      toast(n ? `Applied ${n} draft${n === 1 ? "" : "s"} — re-run Consolidate to see the effect` : "No drafts to apply", n ? "success" : "warn");
    } catch (err) {
      flash = { kind: "error", message: err.message };
    }
    refresh();
    view();
  };

  const onCopyPrior = () => {
    try {
      const n = copyPriorMonth(period.period_id, "browser-user");
      flash = null;
      toast(`Copied ${n} adjustment${n === 1 ? "" : "s"} from the prior period as drafts`);
    } catch (err) {
      flash = { kind: "error", message: err.message };
    }
    refresh();
    view();
  };

  const toggle = (ref) => {
    if (expanded.has(ref)) expanded.delete(ref);
    else expanded.add(ref);
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
        flash = null;
        toast(`Deleted ${ref}`);
      } catch (err) {
        flash = { kind: "error", message: err.message };
      }
    } else {
      flash = { kind: "error", message: `No adjustment ${ref} found` };
    }
    refresh();
    view();
  };

  const adjustmentRow = (adj) => {
    const isOpen = expanded.has(adj.ref);
    return html`
      <div class="adj ${adj.status === "applied" ? "is-applied" : "is-draft"}">
        <div class="adj-head">
          <button type="button" class="adj-toggle" @click=${() => toggle(adj.ref)} aria-expanded=${isOpen}>
            <span class="disclosure">${isOpen ? "▾" : "▸"}</span>
            <strong class="num">${adj.ref}</strong>
          </button>
          <span class="badge badge-${adj.status === "applied" ? "applied" : "draft"}">${adj.status}</span>
          <span class="adj-type">${adj.type}</span>
          <span class="adj-narration" title=${adj.narration}>${adj.narration}</span>
          <span class="num adj-total">${idr(adj.total)}</span>
          <span class="adj-actions">
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
          </span>
        </div>

        ${pendingDeleteRef === adj.ref
          ? html`<div class="flash flash-error adj-confirm">
              Delete ${adj.ref}? This cannot be undone.
              <button class="btn btn-danger btn-sm" @click=${() => onConfirmDelete(adj.ref)}>Confirm delete</button>
              <button class="btn btn-secondary btn-sm" @click=${onCancelDelete}>Cancel</button>
            </div>`
          : ""}

        ${isOpen
          ? html`
              <div class="adj-lines">
                <table class="compact">
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
          : ""}
      </div>
    `;
  };

  const view = () => {
    const counts = {
      all: adjustments.length,
      draft: adjustments.filter((a) => a.status !== "applied").length,
      applied: adjustments.filter((a) => a.status === "applied").length,
    };
    const needle = search.trim().toLowerCase();
    const shown = adjustments.filter((a) => {
      if (filter === "draft" && a.status === "applied") return false;
      if (filter === "applied" && a.status !== "applied") return false;
      if (needle && !`${a.ref} ${a.type} ${a.narration}`.toLowerCase().includes(needle)) return false;
      return true;
    });

    render(
      html`
        ${pageHead({
          title: "Adjustments",
          subtitle: "Structured journal entries replacing manual TB edits. Every entry must balance and carry a narration.",
          actions: html`
            ${hasPrior
              ? html`<button class="btn btn-secondary" type="button" @click=${onCopyPrior}>Copy from prior period</button>`
              : ""}
            <button class="btn btn-secondary" type="button" ?disabled=${counts.draft === 0} @click=${onApplyAll}>
              Apply all drafts
            </button>
            <a class="btn" href="#/periods/${periodStr}/adjustments/new">+ New adjustment</a>
          `,
        })}

        ${flash ? html`<div class="flash flash-${flash.kind}">${flash.message}</div>` : ""}

        ${adjustments.length === 0
          ? html`<p class="empty">No adjustments yet for ${periodStr}.</p>`
          : html`
              <div class="toolbar">
                ${filterPills(
                  [
                    { key: "all", label: "All", count: counts.all },
                    { key: "draft", label: "Draft", count: counts.draft },
                    { key: "applied", label: "Applied", count: counts.applied },
                  ],
                  filter,
                  (key) => {
                    filter = key;
                    view();
                  }
                )}
                <input
                  type="search"
                  placeholder="Search ref, type or narration…"
                  .value=${search}
                  @input=${(ev) => {
                    search = ev.target.value;
                    view();
                  }}
                />
                <span class="toolbar-spacer"></span>
                <span class="toolbar-note">${shown.length} of ${counts.all} shown</span>
              </div>

              <div class="card adj-list">
                ${shown.length === 0 ? html`<p class="empty">Nothing matches this filter.</p>` : shown.map(adjustmentRow)}
              </div>
            `}
      `,
      mountEl
    );
  };

  view();
}
