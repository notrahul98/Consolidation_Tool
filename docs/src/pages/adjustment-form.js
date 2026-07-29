import { html, render } from "../../vendor/lit-html.js";
import * as periodRepo from "../db/period-repo.js";
import * as entityRepo from "../db/entity-repo.js";
import * as groupCoaRepo from "../db/group-coa-repo.js";
import { VALID_TYPES } from "../db/adjustment-repo.js";
import { createAdjustment } from "../engines/adjustments.js";
import { updateNav } from "../layout.js";
import { router } from "../router.js";

function lineRowTemplate(entities, categories) {
  return html`
    <div class="je-line">
      <div class="field">
        <select name="entity_code">
          <option value="">(group-level)</option>
          ${entities.map((e) => html`<option value=${e.entity_code}>${e.entity_code}</option>`)}
        </select>
      </div>
      <div class="field">
        <select name="category">
          <option value=""></option>
          ${categories.map((c) => html`<option value=${c}>${c}</option>`)}
        </select>
      </div>
      <div class="field"><input type="number" step="0.01" name="debit" /></div>
      <div class="field"><input type="number" step="0.01" name="credit" /></div>
      <button type="button" class="btn btn-secondary btn-sm" data-remove-line>&times;</button>
    </div>
  `;
}

export async function renderAdjustmentForm(mountEl, { period: periodStr }) {
  updateNav(periodStr);
  const period = periodRepo.getByStr(periodStr);
  if (!period) {
    router.navigate("/");
    return;
  }

  const entities = entityRepo.listAll();
  const categories = groupCoaRepo.listLeafCategories().map((c) => c.account_name);
  const types = Array.from(VALID_TYPES).sort();

  render(
    html`
      <h1>New Adjustment</h1>
      <p class="subtitle">A double-entry journal — debits must equal credits, at least 2 lines, narration required.</p>

      <div id="error-box"></div>

      <form id="adj-form">
        <div class="card">
          <div class="field-row">
            <div class="field">
              <label for="external_ref">Adjustment Ref</label>
              <input type="text" id="external_ref" name="external_ref" required placeholder="ADJ-${periodStr}-001" />
            </div>
            <div class="field">
              <label for="adjustment_type">Type</label>
              <select id="adjustment_type" name="adjustment_type">
                ${types.map((t) => html`<option value=${t} ?selected=${t === "other"}>${t}</option>`)}
              </select>
            </div>
          </div>
          <div class="field">
            <label for="narration">Narration</label>
            <textarea id="narration" name="narration" rows="2" required></textarea>
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
            ${lineRowTemplate(entities, categories)}${lineRowTemplate(entities, categories)}
          </div>
          <button type="button" class="btn btn-secondary btn-sm" id="add-line">+ Add line</button>
        </div>

        <button class="btn" type="submit">Create as draft</button>
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
    const externalRef = form.elements.external_ref.value;
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
        createAdjustment(period.period_id, externalRef, adjustmentType, narration, lines, "browser-user");
        router.navigate(`/periods/${periodStr}/adjustments`);
        return;
      } catch (err) {
        errors.push(...err.message.split("\n"));
      }
    }

    render(
      html`<div class="flash flash-error">${errors.map((e) => html`<div>${e}</div>`)}</div>`,
      errorBox
    );
  });
}
