import { html, render } from "../../vendor/lit-html.js";
import * as periodRepo from "../db/period-repo.js";
import { runAll } from "../engines/validation.js";
import { updateNav } from "../layout.js";
import { router } from "../router.js";

export async function renderValidation(mountEl, { period: periodStr }) {
  updateNav(periodStr);
  const period = periodRepo.getByStr(periodStr);
  if (!period) {
    router.navigate("/");
    return;
  }

  const validations = runAll(period.period_id);
  const passedCount = validations.filter((v) => v.passed).length;

  render(
    html`
      <h1>Validation</h1>
      <p class="subtitle">${passedCount}/${validations.length} checks passed for ${periodStr}.</p>
      <p class="subtitle">
        <span class="badge badge-fail">Error</span> checks must pass before the period can be locked.
        <span class="badge badge-warn">Warning</span> checks are informational only and don't block locking.
      </p>

      <div class="card">
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Check</th><th>Description</th><th>Severity</th><th>Status</th><th>Details</th></tr>
            </thead>
            <tbody>
              ${validations.map(
                (v) => html`
                  <tr>
                    <td class="num">${v.checkId}</td>
                    <td>${v.description}</td>
                    <td><span class="badge ${v.severity === "Error" ? "badge-fail" : "badge-warn"}">${v.severity}</span></td>
                    <td><span class="badge ${v.passed ? "badge-pass" : "badge-fail"}">${v.passed ? "Pass" : "Fail"}</span></td>
                    <td>${v.details.map((d) => html`<div>${d}</div>`)}</td>
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
