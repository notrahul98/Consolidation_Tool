// Always-visible backup download/load controls, living in the topbar rather than any one
// page — this is a browser-only concern the original Python tool doesn't need (it just has
// one file on disk), so it isn't modeled on any Python source.
import { html, render } from "../vendor/lit-html.js";
import { persistence } from "./db/persistence.js";

export function initBackupControls() {
  const controlsEl = document.getElementById("backup-controls");
  const panelEl = document.getElementById("load-backup-panel");
  let pendingFile = null;

  const onDownload = () => persistence.downloadBackup();

  const onFilePicked = (ev) => {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    pendingFile = file;
    viewPanel();
  };

  const onCancelLoad = () => {
    pendingFile = null;
    viewPanel();
  };

  const onConfirmLoad = async () => {
    const file = pendingFile;
    pendingFile = null;
    await persistence.loadBackupFile(file, "");
    viewPanel();
    location.reload();
  };

  const viewControls = () =>
    render(
      html`
        <button class="btn btn-secondary btn-sm" @click=${onDownload}>Download backup (.db)</button>
        <label style="display:inline-block;margin-left:8px;">
          <span class="btn btn-secondary btn-sm" style="cursor:pointer;">Load backup (.db)</span>
          <input type="file" accept=".db" style="display:none" @change=${onFilePicked} />
        </label>
      `,
      controlsEl
    );

  const viewPanel = () =>
    render(
      pendingFile
        ? html`
            <div class="flash flash-error">
              Loading <strong>${pendingFile.name}</strong> replaces all data currently in this browser.
              This cannot be undone unless you've downloaded a backup of the current data.
              <div style="margin-top:10px;">
                <button class="btn btn-danger btn-sm" @click=${onConfirmLoad}>Confirm &amp; load</button>
                <button class="btn btn-secondary btn-sm" @click=${onCancelLoad} style="margin-left:8px;">Cancel</button>
              </div>
            </div>
          `
        : "",
      panelEl
    );

  viewControls();
  viewPanel();
}
