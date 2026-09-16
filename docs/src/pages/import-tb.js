import { html, render } from "../../vendor/lit-html.js";
import * as entityRepo from "../db/entity-repo.js";
import * as periodRepo from "../db/period-repo.js";
import * as tbRepo from "../db/tb-repo.js";
import * as mappingRepo from "../db/mapping-repo.js";
import { parseFile } from "../excel/tb-parser.js";
import { pageHead, updateNav } from "../layout.js";

function idr(value) {
  if (value === null || value === undefined) return "—";
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function whenImported(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export async function renderImportTb(mountEl, { period: periodStr }) {
  updateNav(periodStr);
  const entities = entityRepo.listAll();

  let flash = null;
  // entity_code -> "importing" while that row's file is being parsed, so each row shows its
  // own progress during a bulk upload instead of one global spinner.
  let busyCodes = new Set();
  // Per-entity result of the last upload: {lines, warnings, replaced}.
  let results = new Map();

  const periodId = () => {
    const [year, month] = periodRepo.parsePeriodStr(periodStr);
    return periodRepo.getOrCreate(year, month);
  };

  async function importOne(entity, file) {
    const pid = periodId();
    const replaced = tbRepo.getImportsForPeriod(pid).some((i) => i.entity_id === entity.entity_id);
    const buf = await file.arrayBuffer();
    const parsed = await parseFile(buf, file.name);
    tbRepo.importTb(pid, entity.entity_id, parsed, "browser-user");
    mappingRepo.ensureRowsExist(pid);
    return { lines: parsed.lines.length, warnings: parsed.warnings, replaced, filename: file.name };
  }

  // One entity's file, chosen on its own row.
  const onRowFile = async (entity, ev) => {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;

    busyCodes = new Set([...busyCodes, entity.entity_code]);
    flash = null;
    view();
    try {
      results.set(entity.entity_code, await importOne(entity, file));
      flash = { kind: "success", message: `Imported ${file.name} for ${entity.entity_code}.` };
    } catch (err) {
      flash = { kind: "error", message: `${entity.entity_code}: ${err.message}` };
      console.error(err);
    } finally {
      busyCodes.delete(entity.entity_code);
      view();
    }
  };

  // Several files at once. Each is matched to an entity by its code appearing in the filename
  // — "TB KDI May 26.xlsx" goes to KDI. Anything that matches nothing, or matches more than
  // one entity, is reported rather than guessed at: importing a TB against the wrong entity
  // is silent and expensive to unpick.
  const onBulkFiles = async (ev) => {
    const files = [...ev.target.files];
    ev.target.value = "";
    if (!files.length) return;

    const matched = [];
    const unmatched = [];
    for (const file of files) {
      const upper = file.name.toUpperCase();
      const hits = entities.filter((e) => upper.includes(e.entity_code.toUpperCase()));
      if (hits.length === 1) matched.push([hits[0], file]);
      else unmatched.push(`${file.name} (${hits.length === 0 ? "no entity code in filename" : "matches " + hits.map((h) => h.entity_code).join(", ")})`);
    }

    busyCodes = new Set(matched.map(([e]) => e.entity_code));
    flash = null;
    view();

    const failed = [];
    for (const [entity, file] of matched) {
      try {
        results.set(entity.entity_code, await importOne(entity, file));
      } catch (err) {
        failed.push(`${entity.entity_code}: ${err.message}`);
        console.error(err);
      }
      busyCodes.delete(entity.entity_code);
      view();
    }

    const parts = [`Imported ${matched.length - failed.length} of ${files.length} file(s).`];
    if (unmatched.length) parts.push(`Skipped: ${unmatched.join("; ")}.`);
    if (failed.length) parts.push(`Failed: ${failed.join("; ")}.`);
    flash = { kind: unmatched.length || failed.length ? "warn" : "success", message: parts.join(" ") };
    view();
  };

  const view = () => {
    const pid = periodRepo.getByStr(periodStr)?.period_id;
    const imports = pid ? tbRepo.getImportsForPeriod(pid) : [];
    const byEntity = new Map(imports.map((i) => [i.entity_id, i]));
    const locked = periodRepo.getByStr(periodStr)?.status === "locked";

    const row = (entity) => {
      const existing = byEntity.get(entity.entity_id);
      const busy = busyCodes.has(entity.entity_code);
      const result = results.get(entity.entity_code);
      const inputId = `file-${entity.entity_code}`;
      return html`
        <tr>
          <td>
            <strong>${entity.entity_code}</strong>
            <div class="row-sub">${entity.entity_name}</div>
          </td>
          <td>
            ${busy
              ? html`<span class="badge badge-info"><span class="spinner spinner-dark"></span>Importing…</span>`
              : existing
              ? html`<span class="badge badge-pass">Imported</span>`
              : html`<span class="badge badge-warn">Not imported</span>`}
          </td>
          <td>
            ${existing ? html`${existing.source_filename}<div class="row-sub">${whenImported(existing.imported_at)}</div>` : "—"}
          </td>
          <td class="num">${existing ? idr(existing.row_count) : "—"}</td>
          <td>
            ${result && result.warnings.length
              ? html`<span class="badge badge-warn">${result.warnings.length} warning(s)</span>
                  <ul class="row-warnings">
                    ${result.warnings.map((w) => html`<li>${w}</li>`)}
                  </ul>`
              : result
              ? html`<span class="badge badge-pass">${idr(result.lines)} lines${result.replaced ? ", replaced" : ""}</span>`
              : "—"}
          </td>
          <td class="num-col">
            <label class="btn btn-secondary btn-sm file-btn ${busy || locked ? "is-disabled" : ""}" for=${inputId}>
              ${existing ? "Replace" : "Upload"}
            </label>
            <input
              class="file-input"
              type="file"
              id=${inputId}
              accept=".xlsx"
              ?disabled=${busy || locked}
              @change=${(ev) => onRowFile(entity, ev)}
            />
          </td>
        </tr>
      `;
    };

    render(
      html`
        ${pageHead({
          title: "Import Trial Balance",
          subtitle: `Tally TB Excel exports for ${periodStr}, one per entity.`,
          actions: html`
            <label class="btn file-btn ${locked ? "is-disabled" : ""}" for="bulk-files">Upload several…</label>
            <input class="file-input" type="file" id="bulk-files" accept=".xlsx" multiple ?disabled=${locked} @change=${onBulkFiles} />
          `,
        })}

        ${locked
          ? html`<div class="flash flash-warn">
              ${periodStr} is locked. Unlock it from the dashboard before importing.
            </div>`
          : ""}
        ${imports.length
          ? html`<div class="flash flash-warn">
              Re-uploading an entity <strong>replaces</strong> its existing import for ${periodStr} and clears that
              entity's TB lines. Categorization is kept — it is stored per ledger name, not per import.
            </div>`
          : ""}
        ${flash
          ? html`<div class="flash flash-${flash.kind}">${flash.message}</div>`
          : ""}

        <div class="card">
          <table class="compact">
            <thead>
              <tr>
                <th>Entity</th>
                <th>Status</th>
                <th>Source file</th>
                <th class="num-col">Rows</th>
                <th>Upload result</th>
                <th class="num-col"></th>
              </tr>
            </thead>
            <tbody>
              ${entities.map(row)}
              <tr class="tally-row">
                <td>
                  <strong>Refresh from Tally</strong>
                  <div class="row-sub">All four entities, straight from TallyPrime</div>
                </td>
                <td><span class="badge badge-locked">Not connected</span></td>
                <td colspan="3" class="row-sub">
                  Needs the connector service on serverlt1 (Phase 8.3). Manual upload stays available either way.
                </td>
                <td class="num-col"><button class="btn btn-secondary btn-sm" disabled>Refresh</button></td>
              </tr>
            </tbody>
          </table>
        </div>

        <p class="subtitle">
          Bulk upload matches each file to an entity by the entity code in its filename, e.g.
          <code>TB KDI May 26.xlsx</code> → KDI. Files that match nothing, or more than one entity, are skipped and
          listed rather than guessed at.
        </p>
      `,
      mountEl
    );
  };

  view();
}
