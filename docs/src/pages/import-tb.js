import { html, render } from "../../vendor/lit-html.js";
import * as entityRepo from "../db/entity-repo.js";
import * as periodRepo from "../db/period-repo.js";
import * as tbRepo from "../db/tb-repo.js";
import * as mappingRepo from "../db/mapping-repo.js";
import { parseFile } from "../excel/tb-parser.js";
import { updateNav } from "../layout.js";

export async function renderImportTb(mountEl, { period: periodStr }) {
  updateNav(periodStr);
  const entities = entityRepo.listAll();
  let flash = null; // {kind, message}
  let busy = false;

  const onSubmit = async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const entityCode = form.elements.entity_code.value;
    const file = form.elements.file.files[0];
    if (!file) return;

    const entity = entityRepo.getByCode(entityCode);
    if (!entity) {
      flash = { kind: "error", message: `Unknown entity ${entityCode}` };
      view();
      return;
    }

    busy = true;
    view();
    try {
      const [year, month] = periodRepo.parsePeriodStr(periodStr);
      const periodId = periodRepo.getOrCreate(year, month);

      const buf = await file.arrayBuffer();
      const parsed = await parseFile(buf, file.name);

      tbRepo.importTb(periodId, entity.entity_id, parsed, "browser-user");
      mappingRepo.ensureRowsExist(periodId);

      let msg = `Imported ${file.name}: ${parsed.lines.length} lines`;
      if (parsed.warnings.length) msg += `, ${parsed.warnings.length} warning(s)`;
      flash = { kind: "success", message: msg, warnings: parsed.warnings };
    } catch (err) {
      flash = { kind: "error", message: err.message };
      console.error(err);
    } finally {
      busy = false;
      form.reset();
      view();
    }
  };

  const view = () =>
    render(
      html`
        <h1>Import Trial Balance</h1>
        <p class="subtitle">
          Upload one entity's Tally TB Excel export for ${periodStr}. Re-uploading an entity replaces its prior
          import for this period.
        </p>

        ${flash
          ? html`
              <div class="flash flash-${flash.kind}">
                ${flash.message}
                ${flash.warnings && flash.warnings.length
                  ? html`<ul>
                      ${flash.warnings.map((w) => html`<li>${w}</li>`)}
                    </ul>`
                  : ""}
              </div>
            `
          : ""}

        <div class="card" style="max-width:460px">
          <form @submit=${onSubmit}>
            <div class="field">
              <label for="entity_code">Entity</label>
              <select id="entity_code" name="entity_code" required>
                ${entities.map((e) => html`<option value=${e.entity_code}>${e.entity_code} — ${e.entity_name}</option>`)}
              </select>
            </div>
            <div class="field">
              <label for="file">Tally TB Excel export</label>
              <input type="file" id="file" name="file" accept=".xlsx" required />
            </div>
            <button class="btn" type="submit" ?disabled=${busy}>${busy ? "Importing…" : "Import"}</button>
          </form>
        </div>
      `,
      mountEl
    );

  view();
}
