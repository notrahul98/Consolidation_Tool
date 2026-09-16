import { html, render } from "../../vendor/lit-html.js";
import * as periodRepo from "../db/period-repo.js";
import * as comparative from "../engines/comparative.js";
import { computePl, computeBs } from "../engines/statements.js";
import { pageHead, setPageWidth, updateNav } from "../layout.js";
import { router } from "../router.js";

const MONTH_ABBR = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The hash router matches whole paths and carries no query string, so the two view options
// live here rather than in the URL. Keyed by statement so switching between P&L and BS does
// not silently carry the other one's choice over.
const viewState = {
  pl: { view: "comparative", months: "present" },
  bs: { view: "comparative", months: "present" },
};

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

// "2026-08" -> "Aug'26"
function monthLabel(key) {
  const [year, month] = key.split("-");
  return `${MONTH_ABBR[parseInt(month, 10)]}'${year.slice(2)}`;
}

function renderStatement(mountEl, periodStr, title, lines, showPercent, onComparative) {
  render(
    html`
      ${pageHead({
        title,
        subtitle: periodStr,
        actions: html`<button class="btn" @click=${onComparative}>Comparative view</button>`,
      })}

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

// Columns are ordered as the reference workbook orders them: the two YTD columns pinned first
// (P&L only), then each month of the year immediately followed by the same month of the prior
// year.
//
// `months === "present"` drops a month pair only when *neither* year has data. On a fully
// loaded year that hides nothing and the layout matches the workbook exactly; on the live
// database, which holds May-Aug 2026 and no 2025 at all, it is the difference between four
// readable columns and twenty columns of dashes to scroll past.
function buildColumns(result, months) {
  const ctx = result.context;
  const columns = [];
  let hiddenMonths = 0;

  if (result.columns.includes(comparative.YTD_CURRENT)) {
    const priorAnchor = comparative.monthKey(ctx.anchorYear - 1, ctx.anchorMonth);
    columns.push({ key: comparative.YTD_CURRENT, label: `YTD ${monthLabel(ctx.anchorKey)}`, pinned: true });
    columns.push({ key: comparative.YTD_PRIOR, label: `YTD ${monthLabel(priorAnchor)}`, pinned: true });
  }

  for (const [current, prior] of ctx.monthPairs) {
    const keys = [current, prior].map(([y, m]) => comparative.monthKey(y, m));
    if (months !== "all" && !keys.some((k) => result.hasData(k))) {
      hiddenMonths += 1;
      continue;
    }
    for (const key of keys) columns.push({ key, label: monthLabel(key), pinned: false });
  }

  for (const column of columns) column.hasData = result.hasData(column.key);
  return { columns, hiddenMonths };
}

function renderComparative(mountEl, periodStr, statement, title, result, showPercent, rerender) {
  const state = viewState[statement];
  const ctx = result.context;
  const { columns, hiddenMonths } = buildColumns(result, state.months);
  const lastDay = new Date(ctx.anchorYear, ctx.anchorMonth, 0).getDate();
  const columnSpan = columns.length * (showPercent ? 2 : 1) + 1;

  const setState = (patch) => {
    Object.assign(state, patch);
    rerender();
  };

  const cell = (column, line, kind) => {
    const raw = kind === "pct" ? result.percent(column.key, line.label) : result.value(column.key, line.label);
    // A missing month and a month that genuinely netted to zero must not look alike.
    const body = raw === null || raw === undefined ? html`<span class="dash">&mdash;</span>` : kind === "pct" ? pct(raw) : idr(raw);
    const classes = ["num", kind === "pct" ? "pct" : "", column.pinned ? "pinned" : "", raw && raw < 0 ? "neg" : ""];
    return html`<td class=${classes.filter(Boolean).join(" ")}>${body}</td>`;
  };

  render(
    html`
      ${pageHead({
        title,
        subtitle: `period ended ${lastDay} ${MONTH_ABBR[ctx.anchorMonth]} ${ctx.anchorYear}${
          hiddenMonths ? ` · ${hiddenMonths} month${hiddenMonths === 1 ? "" : "s"} with no data in either year hidden` : ""
        }`,
        actions: html`
          ${hiddenMonths
            ? html`<button class="btn btn-secondary" @click=${() => setState({ months: "all" })}>Show all 12 months</button>`
            : state.months === "all"
            ? html`<button class="btn btn-secondary" @click=${() => setState({ months: "present" })}>Hide empty months</button>`
            : ""}
          <button class="btn" @click=${() => setState({ view: "simple" })}>Single period view</button>
        `,
      })}

      ${ctx.missing.length
        ? html`<div class="flash flash-warn">
            ${ctx.missing.length} month${ctx.missing.length === 1 ? "" : "s"} in the year to date
            ${ctx.missing.length === 1 ? "has" : "have"} no consolidated data:
            <strong>${ctx.missing.join(", ")}</strong>.
            ${showPercent
              ? "The year-to-date column covers only the months that are loaded."
              : "Those columns are blank; each column here is a month-end position, so the others are unaffected."}
          </div>`
        : ""}
      ${ctx.openInRange.length
        ? html`<div class="flash flash-warn">
            Open (unlocked) periods in range: <strong>${ctx.openInRange.join(", ")}</strong>. These figures can still change.
          </div>`
        : ""}
      ${ctx.staleInRange.length
        ? html`<div class="flash flash-warn">
            Adjustments changed since the last consolidation for <strong>${ctx.staleInRange.join(", ")}</strong>. Re-run Consolidate.
          </div>`
        : ""}

      <div class="card">
        <div class="table-wrap comparative-wrap">
          <table class="comparative">
            <thead>
              <tr>
                <th class="sticky-col">Line Item</th>
                ${columns.map(
                  (c) => html`<th
                    class="num-col ${c.pinned ? "pinned" : ""} ${c.hasData ? "" : "empty-col"}"
                    colspan=${showPercent ? 2 : 1}
                  >${c.label}</th>`
                )}
              </tr>
              ${showPercent
                ? html`<tr class="subhead">
                    <th class="sticky-col"></th>
                    ${columns.map(
                      (c) => html`
                        <th class="num-col ${c.pinned ? "pinned" : ""} ${c.hasData ? "" : "empty-col"}">IDR</th>
                        <th class="num-col ${c.pinned ? "pinned" : ""} ${c.hasData ? "" : "empty-col"}">%</th>
                      `
                    )}
                  </tr>`
                : ""}
            </thead>
            <tbody>
              ${result.lines.map((line) =>
                line.kind === "section"
                  ? html`<tr class="section"><td class="sticky-col" colspan=${columnSpan}>${line.label}</td></tr>`
                  : html`
                      <tr class=${line.kind === "subtotal" ? "subtotal" : ""}>
                        <td class="sticky-col" style="padding-left: ${14 + line.level * 24}px">${line.label}</td>
                        ${columns.map((c) => (showPercent ? html`${cell(c, line, "idr")}${cell(c, line, "pct")}` : cell(c, line, "idr")))}
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

function statementPage(statement, title, showPercent, computeSingle, computeComparative) {
  return async function renderPage(mountEl, { period: periodStr }) {
    updateNav(periodStr);
    const period = periodRepo.getByStr(periodStr);
    if (!period) {
      router.navigate("/");
      return;
    }

    const draw = () => {
      const state = viewState[statement];
      // 26 columns of figures need the room; the single-period view does not.
      setPageWidth(state.view === "simple" ? "default" : "wide");
      if (state.view === "simple") {
        const { lines } = computeSingle(period.period_id);
        renderStatement(mountEl, periodStr, title, lines, showPercent, () => {
          state.view = "comparative";
          draw();
        });
        return;
      }
      renderComparative(mountEl, periodStr, statement, title, computeComparative(period.period_id), showPercent, draw);
    };
    draw();
  };
}

export const renderPl = statementPage("pl", "Profit and Loss", true, computePl, comparative.computePlComparative);
export const renderBs = statementPage("bs", "Balance Sheet", false, computeBs, comparative.computeBsComparative);
