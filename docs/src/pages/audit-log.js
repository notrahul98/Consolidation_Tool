import { html, render } from "../../vendor/lit-html.js";
import { persistence } from "../db/persistence.js";
import * as periodRepo from "../db/period-repo.js";
import { updateNav } from "../layout.js";
import { router } from "../router.js";

export async function renderAuditLog(mountEl, { period: periodStr }) {
  updateNav(periodStr);
  const period = periodRepo.getByStr(periodStr);
  if (!period) {
    router.navigate("/");
    return;
  }

  const rows = persistence.all("SELECT * FROM audit_log ORDER BY log_id DESC LIMIT 500");

  render(
    html`
      <h1>Audit Log</h1>
      <p class="subtitle">
        Most recent 500 actions across the whole database (not filtered to ${periodStr} — the audit log isn't
        period-scoped).
      </p>

      <div class="card">
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Timestamp</th><th>User</th><th>Action</th><th>Table</th><th>Record</th><th>Old</th><th>New</th></tr>
            </thead>
            <tbody>
              ${rows.map(
                (r) => html`
                  <tr>
                    <td class="num">${r.timestamp}</td>
                    <td>${r.user}</td>
                    <td>${r.action}</td>
                    <td>${r.table_name}</td>
                    <td class="num">${r.record_id}</td>
                    <td>${r.old_value}</td>
                    <td>${r.new_value}</td>
                  </tr>
                `
              )}
            </tbody>
          </table>
        </div>
      </div>
    `,
    mountEl
  );
}
