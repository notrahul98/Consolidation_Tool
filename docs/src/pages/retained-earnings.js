// Port of src/web/routes/re_check.py + src/web/templates/retained_earnings.html
import { html, render } from "../../vendor/lit-html.js";
import * as periodRepo from "../db/period-repo.js";
import { run as reCheckRun } from "../engines/re-check.js";
import { updateNav } from "../layout.js";
import { router } from "../router.js";

const TOLERANCE_IDR = 1;

function idr(value) {
  if (value === null || value === undefined) return "";
  const v = Number(value);
  const formatted = Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return v < 0 ? `(${formatted})` : formatted;
}

export async function renderRetainedEarnings(mountEl, { period: periodStr }) {
  updateNav(periodStr);
  const period = periodRepo.getByStr(periodStr);
  if (!period) {
    router.navigate("/");
    return;
  }

  const result = reCheckRun(period.period_id);
  let groupRow = null;
  let entityRows = [];
  if (result.applicable) {
    groupRow = result.rows.find((r) => r.entityCode === null);
    entityRows = result.rows.filter((r) => r.entityCode !== null);
  }

  render(
    html`
      <h1>Retained Earnings Movement</h1>
      <p class="subtitle">
        Reconciles this period's Retained Earnings closing against the prior period's closing plus its net profit.
        Diagnostic only — never blocks locking a period.
      </p>

      ${!result.applicable
        ? html`<div class="card"><p class="empty">Not applicable: ${result.reason}.</p></div>`
        : html`
            <div class="card">
              <h2>Group Reconciliation</h2>
              <table class="waterfall">
                <tbody>
                  <tr>
                    <td>RE closing ${result.priorPeriodStr}</td>
                    <td class="num">${idr(groupRow.reClosingPrior)}</td>
                  </tr>
                  <tr>
                    <td>+ Net profit/(loss) ${result.priorPeriodStr}</td>
                    <td class="num ${groupRow.priorNetProfit < 0 ? "neg" : ""}">${idr(groupRow.priorNetProfit)}</td>
                  </tr>
                  <tr class="subtotal-row">
                    <td>= Expected RE closing ${periodStr}</td>
                    <td class="num">${idr(groupRow.expected)}</td>
                  </tr>
                  <tr>
                    <td>Actual RE closing ${periodStr}</td>
                    <td class="num">${idr(groupRow.reClosingCurrent)}</td>
                  </tr>
                  <tr class="total-row">
                    <td><strong>Gap</strong></td>
                    <td class="num">
                      <strong
                        ><span class="badge ${Math.abs(groupRow.gap) <= TOLERANCE_IDR ? "badge-pass" : "badge-warn"}">${idr(
                          groupRow.gap
                        )}</span></strong
                      >
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div class="card">
              <h2>Per-Entity Detail</h2>
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Entity</th>
                      <th class="num-col">RE Closing ${result.priorPeriodStr}</th>
                      <th class="num-col">Prior Net Profit</th>
                      <th class="num-col">Expected RE Closing</th>
                      <th class="num-col">Actual RE Closing ${periodStr}</th>
                      <th class="num-col">Gap</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${entityRows.map(
                      (row) => html`
                        <tr>
                          <td>${row.entityCode}</td>
                          <td class="num ${row.reClosingPrior < 0 ? "neg" : ""}">${idr(row.reClosingPrior)}</td>
                          <td class="num ${row.priorNetProfit < 0 ? "neg" : ""}">${idr(row.priorNetProfit)}</td>
                          <td class="num ${row.expected < 0 ? "neg" : ""}">${idr(row.expected)}</td>
                          <td class="num ${row.reClosingCurrent < 0 ? "neg" : ""}">${idr(row.reClosingCurrent)}</td>
                          <td class="num">
                            <span class="badge ${Math.abs(row.gap) <= TOLERANCE_IDR ? "badge-pass" : "badge-warn"}">${idr(row.gap)}</span>
                          </td>
                        </tr>
                      `
                    )}
                    <tr class="footer-row">
                      <td><strong>Total</strong></td>
                      <td class="num ${groupRow.reClosingPrior < 0 ? "neg" : ""}"><strong>${idr(groupRow.reClosingPrior)}</strong></td>
                      <td class="num ${groupRow.priorNetProfit < 0 ? "neg" : ""}"><strong>${idr(groupRow.priorNetProfit)}</strong></td>
                      <td class="num ${groupRow.expected < 0 ? "neg" : ""}"><strong>${idr(groupRow.expected)}</strong></td>
                      <td class="num ${groupRow.reClosingCurrent < 0 ? "neg" : ""}"><strong>${idr(groupRow.reClosingCurrent)}</strong></td>
                      <td class="num"><strong>${idr(groupRow.gap)}</strong></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="card">
              <h2>Linked Adjustments</h2>
              ${result.linkedAdjustments.length === 0
                ? html`<p class="empty">No adjustments touch Retained Earnings or any P&amp;L category in either period.</p>`
                : html`
                    <div class="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Ref</th>
                            <th>Period</th>
                            <th>Type</th>
                            <th>Entity</th>
                            <th>Category</th>
                            <th class="num-col">Dr</th>
                            <th class="num-col">Cr</th>
                            <th>Status</th>
                            <th>Narration</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${result.linkedAdjustments.map(
                            (adj) => html`
                              <tr>
                                <td>
                                  <a href="#/periods/${adj.periodStr}/adjustments/${adj.externalRef}/edit">${adj.externalRef}</a>
                                </td>
                                <td>${adj.periodStr}</td>
                                <td>${adj.type}</td>
                                <td>${adj.entityCode || "—"}</td>
                                <td>${adj.category}</td>
                                <td class="num">${idr(adj.debit)}</td>
                                <td class="num">${idr(adj.credit)}</td>
                                <td><span class="badge ${adj.status === "applied" ? "badge-pass" : "badge-warn"}">${adj.status}</span></td>
                                <td>${adj.narration}</td>
                              </tr>
                            `
                          )}
                        </tbody>
                      </table>
                    </div>
                  `}
            </div>
          `}
    `,
    mountEl
  );
}
