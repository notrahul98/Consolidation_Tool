import { html, render } from "../../vendor/lit-html.js";
import * as periodRepo from "../db/period-repo.js";
import * as entityRepo from "../db/entity-repo.js";
import * as groupCoaRepo from "../db/group-coa-repo.js";
import * as adjustmentRepo from "../db/adjustment-repo.js";
import { VALID_TYPES } from "../db/adjustment-repo.js";
import { createAdjustment, updateAdjustment } from "../engines/adjustments.js";
import { updateNav } from "../layout.js";
import { router } from "../router.js";

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
      <h1>${mode === "edit" ? `Edit Adjustment ${ref}` : "New Adjustment"}</h1>
      <p class="subtitle">
        ${mode === "edit"
          ? "Editing resets this adjustment to draft — re-apply it and re-run Consolidate afterward. The ref can't be changed here; delete and recreate to rename."
          : "A double-entry journal — debits must equal credits, at least 2 lines, narration required."}
      </p>

      <div id="error-box"></div>

      <form id="adj-form">
        <div class="card">
          <div class="field-row">
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
            <textarea id="narration" name="narration" rows="2" required>${mode === "edit" ? existingAdj.narration : ""}</textarea>
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
        </div>

        <button class="btn" type="submit">${mode === "edit" ? "Save changes" : "Create as draft"}</button>
      </form>
    `,
    mountEl
  );

  const linesEl = mountEl.querySelector("#lines");
  const errorBox = mountEl.querySelector("#error-box");
  const form = mountEl.querySelector("#adj-form");

  function wireRemoveButton(btn) {
    btn.addEventListener("click", () => btn.closest(".je-line").remove());
  }
  linesEl.querySelectorAll("[data-remove-line]").forEach(wireRemoveButton);

  mountEl.querySelector("#add-line").addEventListener("click", () => {
    const wrap = document.createElement("div");
    render(lineRowTemplate(entities, categories), wrap);
    const rowEl = wrap.firstElementChild;
    linesEl.appendChild(rowEl);
    wireRemoveButton(rowEl.querySelector("[data-remove-line]"));
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
