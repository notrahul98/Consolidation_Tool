import { html, render } from "../../vendor/lit-html.js";
import * as periodRepo from "../db/period-repo.js";
import { runAll } from "../engines/validation.js";
import { filterPills, pageHead, updateNav } from "../layout.js";
import { router } from "../router.js";

// Where each check is actually fixed. A failing check that only tells you it failed makes you
// go hunting for the screen that puts it right; this is that screen.
const FIX_TARGET = {
  "V1": ["/import", "Re-import the TB"],
  "V2": ["/adjustments", "Review adjustments"],
  "V3/V12": ["/mapping", "Categorize ledgers"],
  "V5": ["/consolidated", "Re-consolidate"],
  "V6": ["/bs", "Open the Balance Sheet"],
  "V7": ["/pl", "Open the P&L"],
  "V8": ["/consolidated", "Re-consolidate"],
  "V9": ["/import", "Re-import the TB"],
  "V14": ["/adjustments", "Apply draft adjustments"],
  "V18": ["/adjustments", "Apply draft adjustments"],
  "V19": ["/stock", "Open Stock / COGS"],
  "V20": ["/retained-earnings", "Open the RE movement check"],
};

export async function renderValidation(mountEl, { period: periodStr }) {
  updateNav(periodStr);
  const period = periodRepo.getByStr(periodStr);
  if (!period) {
    router.navigate("/");
    return;
  }

  const validations = runAll(period.period_id);
  let filter = "failing";

  const counts = {
    all: validations.length,
    failing: validations.filter((v) => !v.passed).length,
    errors: validations.filter((v) => v.severity === "Error").length,
    warnings: validations.filter((v) => v.severity === "Warning").length,
  };
  // Land on whatever needs attention; if nothing does, show everything rather than an empty
  // screen that looks like the checks did not run.
  if (counts.failing === 0) filter = "all";

  const matches = (v) => {
    if (filter === "failing") return !v.passed;
    if (filter === "errors") return v.severity === "Error";
    if (filter === "warnings") return v.severity === "Warning";
    return true;
  };

  const checkRow = (v) => {
    const [suffix, label] = FIX_TARGET[v.checkId] || [];
    return html`
      <div class="check ${v.passed ? "is-pass" : v.severity === "Error" ? "is-error" : "is-warn"}">
        <div class="check-head">
          <span class="badge ${v.passed ? "badge-pass" : v.severity === "Error" ? "badge-fail" : "badge-warn"}">
            ${v.passed ? "Pass" : v.severity}
          </span>
          <span class="check-id num">${v.checkId}</span>
          <span class="check-desc">${v.description}</span>
          ${!v.passed && suffix
            ? html`<a class="btn btn-secondary btn-sm" href="#/periods/${periodStr}${suffix}">${label}</a>`
            : ""}
        </div>
        ${v.details.length
          ? html`<ul class="check-details">
              ${v.details.map((d) => html`<li>${d}</li>`)}
            </ul>`
          : ""}
      </div>
    `;
  };

  const view = () => {
    const shown = validations.filter(matches);
    // Grouped by severity so the blocking problems are read first: an Error stops the period
    // being locked, a Warning never does.
    const groups = [
      ["Errors", shown.filter((v) => v.severity === "Error")],
      ["Warnings", shown.filter((v) => v.severity === "Warning")],
    ];

    render(
      html`
        ${pageHead({
          title: "Validation",
          subtitle: `${counts.all - counts.failing} of ${counts.all} checks pass for ${periodStr}. Error checks must
            pass before the period can be locked; Warning checks are diagnostic and never block it.`,
        })}

        <div class="toolbar">
          ${filterPills(
            [
              { key: "failing", label: "Failing", count: counts.failing },
              { key: "all", label: "All", count: counts.all },
              { key: "errors", label: "Errors", count: counts.errors },
              { key: "warnings", label: "Warnings", count: counts.warnings },
            ],
            filter,
            (key) => {
              filter = key;
              view();
            }
          )}
        </div>

        ${shown.length === 0
          ? html`<p class="empty">Nothing matches this filter.</p>`
          : groups.map(([label, items]) =>
              items.length
                ? html`
                    <div class="section-label">${label}</div>
                    <div class="card check-list">${items.map(checkRow)}</div>
                  `
                : ""
            )}
      `,
      mountEl
    );
  };

  view();
}
