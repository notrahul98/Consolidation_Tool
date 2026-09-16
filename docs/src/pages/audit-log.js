import { html, render } from "../../vendor/lit-html.js";
import { persistence } from "../db/persistence.js";
import * as periodRepo from "../db/period-repo.js";
import { pageHead, setPageWidth, updateNav } from "../layout.js";
import { router } from "../router.js";

// Old/new values are stored as JSON strings for some actions and bare text for others. Pretty-
// print whatever parses and leave the rest alone, rather than assuming a shape that isn't
// guaranteed.
function prettyValue(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return String(raw);
  }
}

function summarize(raw, limit = 60) {
  if (raw === null || raw === undefined || raw === "") return "";
  const text = String(raw).replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function localDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

// "2026-09-16T04:12:33.000Z" -> "2026-09-16", for comparing against a date input.
function isoDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function renderAuditLog(mountEl, { period: periodStr }) {
  updateNav(periodStr);
  setPageWidth("wide");
  const period = periodRepo.getByStr(periodStr);
  if (!period) {
    router.navigate("/");
    return;
  }

  const rows = persistence.all("SELECT * FROM audit_log ORDER BY log_id DESC LIMIT 500");
  const actions = [...new Set(rows.map((r) => r.action))].sort();
  const tables = [...new Set(rows.map((r) => r.table_name))].sort();

  let action = "";
  let table = "";
  let from = "";
  let to = "";
  let search = "";
  const expanded = new Set();

  const matches = (r) => {
    if (action && r.action !== action) return false;
    if (table && r.table_name !== table) return false;
    const day = isoDay(r.timestamp);
    if (from && day < from) return false;
    if (to && day > to) return false;
    if (search) {
      const needle = search.toLowerCase();
      const haystack = `${r.action} ${r.table_name} ${r.record_id} ${r.user} ${r.old_value || ""} ${r.new_value || ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  };

  const toggle = (logId) => {
    if (expanded.has(logId)) expanded.delete(logId);
    else expanded.add(logId);
    view();
  };

  const entryRow = (r) => {
    const oldPretty = prettyValue(r.old_value);
    const newPretty = prettyValue(r.new_value);
    const hasDetail = oldPretty !== null || newPretty !== null;
    const isOpen = expanded.has(r.log_id);
    return html`
      <tr class=${hasDetail ? "is-expandable" : ""} @click=${hasDetail ? () => toggle(r.log_id) : null}>
        <td class="num">${localDate(r.timestamp)}</td>
        <td>${r.user}</td>
        <td><span class="badge badge-info">${r.action}</span></td>
        <td>${r.table_name}</td>
        <td class="num">${r.record_id}</td>
        <td class="audit-summary">
          ${hasDetail
            ? html`<span class="disclosure">${isOpen ? "▾" : "▸"}</span>
                ${summarize(r.new_value || r.old_value)}`
            : ""}
        </td>
      </tr>
      ${isOpen
        ? html`
            <tr class="audit-detail">
              <td colspan="6">
                <div class="diff">
                  <div>
                    <h3>Before</h3>
                    <pre>${oldPretty ?? "—"}</pre>
                  </div>
                  <div>
                    <h3>After</h3>
                    <pre>${newPretty ?? "—"}</pre>
                  </div>
                </div>
              </td>
            </tr>
          `
        : ""}
    `;
  };

  const view = () => {
    const shown = rows.filter(matches);
    render(
      html`
        ${pageHead({
          title: "Audit Log",
          subtitle: `The most recent 500 actions across the whole database. Not scoped to ${periodStr} — the audit
            log records the database, not one period.`,
          actions: shown.length !== rows.length
            ? html`<button
                class="btn btn-secondary"
                @click=${() => {
                  action = "";
                  table = "";
                  from = "";
                  to = "";
                  search = "";
                  view();
                }}
              >
                Clear filters
              </button>`
            : "",
        })}

        <div class="toolbar">
          <select aria-label="Action" .value=${action} @change=${(ev) => { action = ev.target.value; view(); }}>
            <option value="">All actions</option>
            ${actions.map((a) => html`<option value=${a}>${a}</option>`)}
          </select>
          <select aria-label="Table" .value=${table} @change=${(ev) => { table = ev.target.value; view(); }}>
            <option value="">All tables</option>
            ${tables.map((t) => html`<option value=${t}>${t}</option>`)}
          </select>
          <input type="date" aria-label="From" .value=${from} @change=${(ev) => { from = ev.target.value; view(); }} />
          <input type="date" aria-label="To" .value=${to} @change=${(ev) => { to = ev.target.value; view(); }} />
          <input
            type="search"
            placeholder="Search…"
            .value=${search}
            @input=${(ev) => { search = ev.target.value; view(); }}
          />
          <span class="toolbar-spacer"></span>
          <span class="toolbar-note">${shown.length} of ${rows.length} entries</span>
        </div>

        <div class="card">
          <div class="table-wrap sticky-wrap">
            <table class="compact audit">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>User</th>
                  <th>Action</th>
                  <th>Table</th>
                  <th>Record</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                ${shown.length === 0
                  ? html`<tr><td colspan="6"><p class="empty">Nothing matches these filters.</p></td></tr>`
                  : shown.map(entryRow)}
              </tbody>
            </table>
          </div>
        </div>
      `,
      mountEl
    );
  };

  view();
}
