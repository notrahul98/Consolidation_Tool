import { html, render } from "../../vendor/lit-html.js";
import * as periodRepo from "../db/period-repo.js";
import * as entityRepo from "../db/entity-repo.js";
import * as groupCoaRepo from "../db/group-coa-repo.js";
import * as adjustmentRepo from "../db/adjustment-repo.js";
import { VALID_TYPES } from "../db/adjustment-repo.js";
import { createAdjustment, updateAdjustment } from "../engines/adjustments.js";
import { pageHead, updateNav } from "../layout.js";
import { router } from "../router.js";

function idr(value) {
  const v = Number(value) || 0;
  const formatted = Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2 });
  return v < 0 ? `(${formatted})` : formatted;
}

function lineRowTemplate(entities, categories, prefill = null) {
  return html`
    <div class="je-line">
      <div class="field">
        <select name="entity_code">
          <option value="">(group-level)</option>
          ${entities.map((e) => html`<option value=${e.entity_code} ?selected=${prefill && e.entity_code === prefill.entityCode}>${e.entity_code}</option>`)}
        </select>
      </div>
      <div class="field">
        <select name="category">
          <option value=""></option>
          ${categories.map((c) => html`<option value=${c} ?selected=${prefill && c === prefill.category}>${c}</option>`)}
        </select>
      </div>
      <div class="field"><input type="number" step="0.01" name="debit" .value=${prefill && prefill.debit ? prefill.debit : ""} /></div>
      <div class="field"><input type="number" step="0.01" name="credit" .value=${prefill && prefill.credit ? prefill.credit : ""} /></div>
      <button type="button" class="btn btn-secondary btn-sm" data-remove-line>&times;</button>
    </div>
  `;
}

export async function renderAdjustmentForm(mountEl, { period: periodStr, ref }) {
  updateNav(periodStr);
  const period = periodRepo.getByStr(periodStr);
  if (!period) {
    router.navigate("/");
    return;
  }

  const mode = ref ? "edit" : "new";
  let existingAdj = null;
  let existingLines = null;

  if (mode === "edit") {
    existingAdj = persistenceLookupAdjustment(period.period_id, ref);
    if (!existingAdj) {
      router.navigate(`/periods/${periodStr}/adjustments`);
      return;
    }
    existingLines = adjustmentRepo.getLines(existingAdj.adjustment_id).map((l) => {
      let entityCode = "";
      if (l.entity_id) {
        const e = entityRepo.listAll().find((en) => en.entity_id === l.entity_id);
        entityCode = e ? e.entity_code : "";
      }
      const cat = groupCoaRepo.getById(l.group_account_id);
      return {
        entityCode,
        category: cat ? cat.account_name : "",
        debit: l.debit_amount || "",
        credit: l.credit_amount || "",
      };
    });
  }

  const entities = entityRepo.listAll();
  const categories = groupCoaRepo.listLeafCategories().map((c) => c.account_name);
  const types = Array.from(VALID_TYPES).sort();

  const lineRows = mode === "edit" && existingLines.length > 0
    ? existingLines.map((l) => lineRowTemplate(entities, categories, l))
    : [lineRowTemplate(entities, categories), lineRowTemplate(entities, categories)];

  render(
    html`
      ${pageHead({
        title: mode === "edit" ? `Edit Adjustment ${ref}` : "New Adjustment",
        subtitle: "A double-entry journal — debits must equal credits, at least two lines, narration required.",
        actions: html`
          <a class="btn btn-secondary" href="#/periods/${periodStr}/adjustments">Cancel</a>
          <button class="btn" type="submit" form="adj-form">${mode === "edit" ? "Save changes" : "Create as draft"}</button>
        `,
      })}

      ${mode === "edit"
        ? html`
            <div class="callout">
              <h3>Editing takes three steps</h3>
              <ol>
                <li><strong>Save changes</strong> here — this resets the adjustment to draft, so it stops affecting the numbers.</li>
                <li><strong>Apply</strong> it again from the adjustments list.</li>
                <li><strong>Re-run Consolidate</strong> so the statements pick it up.</li>
              </ol>
              <p>The ref can't be changed here — delete and recreate to rename.</p>
            </div>
          `
        : ""}

      <div id="error-box"></div>

      <form id="adj-form">
        <div class="card">
          <div class="form-grid">
            <div>
              <div class="field">
                <label for="external_ref">Adjustment Ref</label>
                ${mode === "edit"
                  ? html`<input type="text" id="external_ref" .value=${existingAdj.external_ref} readonly disabled />`
                  : html`<input type="text" id="external_ref" name="external_ref" required placeholder="ADJ-${periodStr}-001" />`}
              </div>
              <div class="field">
                <label for="adjustment_type">Type</label>
                <select id="adjustment_type" name="adjustment_type">
                  ${types.map(
                    (t) => html`<option value=${t} ?selected=${mode === "edit" ? t === existingAdj.adjustment_type : t === "other"}>${t}</option>`
                  )}
                </select>
              </div>
            </div>
            <div class="field">
              <label for="narration">Narration</label>
              <textarea id="narration" name="narration" rows="6" required>${mode === "edit" ? existingAdj.narration : ""}</textarea>
              <div class="field-note">What this entry is for, in enough detail that it still makes sense at audit.</div>
            </div>
          </div>
        </div>

        <div class="card">
          <h2>Lines</h2>
          <div id="lines">
            <div class="je-line">
              <div><label>Entity</label></div>
              <div><label>Category</label></div>
              <div><label>Debit</label></div>
              <div><label>Credit</label></div>
              <div></div>
            </div>
            ${lineRows}
          </div>
          <button type="button" class="btn btn-secondary btn-sm" id="add-line">+ Add line</button>
          <!-- Running totals: the entry is refused unless it balances, so show the difference
               as it is typed rather than only on submit. -->
          <div class="je-total" id="je-total"></div>
        </div>
      </form>
    `,
    mountEl
  );

  const linesEl = mountEl.querySelector("#lines");
  const errorBox = mountEl.querySelector("#error-box");
  const form = mountEl.querySelector("#adj-form");

  const totalEl = mountEl.querySelector("#je-total");

  function updateTotals() {
    let dr = 0;
    let cr = 0;
    for (const row of linesEl.querySelectorAll(".je-line")) {
      const drEl = row.querySelector("input[name=debit]");
      const crEl = row.querySelector("input[name=credit]");
      if (!drEl || !crEl) continue; // the header row
      dr += parseFloat(drEl.value) || 0;
      cr += parseFloat(crEl.value) || 0;
    }
    const diff = dr - cr;
    render(
      html`
        <span>Debits <strong class="num">${idr(dr)}</strong></span>
        <span>Credits <strong class="num">${idr(cr)}</strong></span>
        <span class=${Math.abs(diff) < 0.005 ? "je-balanced" : "je-unbalanced"}>
          ${Math.abs(diff) < 0.005 ? "Balanced" : html`Out by <strong class="num">${idr(diff)}</strong>`}
        </span>
      `,
      totalEl
    );
  }

  function wireRemoveButton(btn) {
    btn.addEventListener("click", () => {
      btn.closest(".je-line").remove();
      updateTotals();
    });
  }
  linesEl.querySelectorAll("[data-remove-line]").forEach(wireRemoveButton);
  linesEl.addEventListener("input", updateTotals);
  updateTotals();

  mountEl.querySelector("#add-line").addEventListener("click", () => {
    const wrap = document.createElement("div");
    render(lineRowTemplate(entities, categories), wrap);
    const rowEl = wrap.firstElementChild;
    linesEl.appendChild(rowEl);
    wireRemoveButton(rowEl.querySelector("[data-remove-line]"));
    updateTotals();
  });

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const externalRef = mode === "edit" ? existingAdj.external_ref : form.elements.external_ref.value;
    const adjustmentType = form.elements.adjustment_type.value;
    const narration = form.elements.narration.value;

    const rows = Array.from(linesEl.querySelectorAll(".je-line")).filter((row) => row.querySelector("select[name=category]"));
    const errors = [];
    const lines = [];
    rows.forEach((row, i) => {
      const ecode = row.querySelector("select[name=entity_code]").value;
      const catName = row.querySelector("select[name=category]").value;
      const dr = row.querySelector("input[name=debit]").value;
      const cr = row.querySelector("input[name=credit]").value;
      if (!catName) return;
      const cat = groupCoaRepo.getByName(catName);
      if (!cat) {
        errors.push(`Line ${i + 1}: unknown category '${catName}'`);
        return;
      }
      let entityId = null;
      if (ecode) {
        const e = entityRepo.getByCode(ecode);
        if (!e) {
          errors.push(`Line ${i + 1}: unknown entity '${ecode}'`);
          return;
        }
        entityId = e.entity_id;
      }
      lines.push({ entityId, groupAccountId: cat.group_account_id, debitAmount: parseFloat(dr) || 0, creditAmount: parseFloat(cr) || 0 });
    });

    if (errors.length === 0) {
      try {
        if (mode === "edit") {
          updateAdjustment(period.period_id, existingAdj.adjustment_id, adjustmentType, narration, lines, "browser-user");
        } else {
          createAdjustment(period.period_id, externalRef, adjustmentType, narration, lines, "browser-user");
        }
        router.navigate(`/periods/${periodStr}/adjustments`);
        return;
      } catch (err) {
        errors.push(...err.message.split("\n"));
      }
    }

    render(html`<div class="flash flash-error">${errors.map((e) => html`<div>${e}</div>`)}</div>`, errorBox);
  });
}

function persistenceLookupAdjustment(periodId, ref) {
  return adjustmentRepo.listForPeriod(periodId).find((a) => a.external_ref === ref) || null;
}
