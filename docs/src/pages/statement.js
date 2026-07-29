import { html, render } from "../../vendor/lit-html.js";
import * as periodRepo from "../db/period-repo.js";
import { computePl, computeBs } from "../engines/statements.js";
import { updateNav } from "../layout.js";
import { router } from "../router.js";

function idr(value) {
  if (value === null || value === undefined) return "";
  const v = Number(value);
  const formatted = Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return v < 0 ? `(${formatted})` : formatted;
}

function pct(value) {
  if (value === null || value === undefined) return "";
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function renderStatement(mountEl, periodStr, title, lines, showPercent) {
  render(
    html`
      <h1>${title}</h1>
      <p class="subtitle">${periodStr}</p>

      <div class="card">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Line Item</th>
                <th class="num-col">Amount (IDR)</th>
                ${showPercent ? html`<th class="num-col">% of Net Sales</th>` : ""}
              </tr>
            </thead>
            <tbody>
              ${lines.map((line) =>
                line.kind === "section"
                  ? html`<tr class="section"><td colspan=${showPercent ? 3 : 2}>${line.label}</td></tr>`
                  : html`
                      <tr class=${line.isSubtotal ? "subtotal" : ""}>
                        <td style="padding-left: ${14 + line.level * 24}px">${line.label}</td>
                        <td class="num ${line.value && line.value < 0 ? "neg" : ""}">${idr(line.value)}</td>
                        ${showPercent
                          ? html`<td class="num ${line.percent && line.percent < 0 ? "neg" : ""}">${pct(line.percent)}</td>`
                          : ""}
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

export async function renderPl(mountEl, { period: periodStr }) {
  updateNav(periodStr);
  const period = periodRepo.getByStr(periodStr);
  if (!period) {
    router.navigate("/");
    return;
  }
  const { lines } = computePl(period.period_id);
  renderStatement(mountEl, periodStr, "Profit & Loss", lines, true);
}

export async function renderBs(mountEl, { period: periodStr }) {
  updateNav(periodStr);
  const period = periodRepo.getByStr(periodStr);
  if (!period) {
    router.navigate("/");
    return;
  }
  const { lines } = computeBs(period.period_id);
  renderStatement(mountEl, periodStr, "Balance Sheet", lines, false);
}
