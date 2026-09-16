import { html, render } from "../../vendor/lit-html.js";
import { persistence } from "../db/persistence.js";
import * as entityRepo from "../db/entity-repo.js";
import * as periodRepo from "../db/period-repo.js";
import * as tbRepo from "../db/tb-repo.js";
import { downloadExportPack } from "../excel/export-pack.js";
import { runAll } from "../engines/validation.js";
import { computeBs } from "../engines/statements.js";
import * as comparative from "../engines/comparative.js";
import { afterPaint, busyButton, pageHead, updateNav } from "../layout.js";
import { router } from "../router.js";

function idr(value) {
  if (value === null || value === undefined) return "—";
  const v = Number(value);
  const formatted = Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return v < 0 ? `(${formatted})` : formatted;
}

function pct(value) {
  if (value === null || value === undefined) return "—";
  const v = Number(value) * 100;
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

// Year-on-year only means something when there is a prior-year figure to compare against and
// it is not zero. On this database the prior year is entirely absent, so this is the normal
// case rather than an edge case.
function yoy(current, prior) {
  if (current === null || prior === null || prior === undefined || current === undefined) return null;
  if (prior === 0) return null;
  return (current - prior) / Math.abs(prior);
}

// Ledgers with a balance that have no category yet. Reads entity_coa_mapping directly rather
// than trial_balance_lines.mapped_group_account_id, because that column is a cache refreshed
// during consolidate — after a categorization change it is stale, and a checklist that lies
// about being complete is worse than no checklist.
function unmappedLedgerCount(periodId) {
  const row = persistence.get(
    `SELECT COUNT(*) AS n FROM (
        SELECT tbl.entity_ledger_name, tbi.entity_id
          FROM trial_balance_lines tbl
          JOIN trial_balance_imports tbi ON tbl.import_id = tbi.import_id
          LEFT JOIN entity_coa_mapping ecm
                 ON ecm.entity_id = tbi.entity_id
                AND ecm.entity_ledger_name = tbl.entity_ledger_name
         WHERE tbi.period_id = ?
           AND ecm.group_account_id IS NULL
           AND (tbl.closing_dr - tbl.closing_cr) != 0
         GROUP BY tbl.entity_ledger_name, tbi.entity_id
     )`,
    [periodId]
  );
  return row ? row.n : 0;
}

function adjustmentCounts(periodId) {
  const row = persistence.get(
    `SELECT SUM(CASE WHEN status = 'applied' THEN 1 ELSE 0 END) AS applied,
            SUM(CASE WHEN status != 'applied' THEN 1 ELSE 0 END) AS draft,
            COUNT(*) AS total
       FROM adjustments WHERE period_id = ?`,
    [periodId]
  );
  return { applied: row?.applied || 0, draft: row?.draft || 0, total: row?.total || 0 };
}

function renderPeriodPicker(activePeriodStr) {
  const periods = periodRepo.listAll();

  const onSelect = (ev) => {
    const value = ev.target.value;
    if (value) router.navigate(`/periods/${value}`);
  };

  const onCreate = (ev) => {
    ev.preventDefault();
    const input = ev.target.elements.period;
    const value = input.value.trim();
    if (!/^\d{4}-\d{2}$/.test(value)) return;
    const [year, month] = periodRepo.parsePeriodStr(value);
    periodRepo.getOrCreate(year, month);
    router.navigate(`/periods/${value}`);
  };

  return html`
    <div class="period-select">
      <select aria-label="Period" @change=${onSelect}>
        ${periods.map((p) => {
          const pstr = periodRepo.asStr(p);
          return html`<option value=${pstr} ?selected=${pstr === activePeriodStr}>
            ${pstr}${p.status === "locked" ? " · locked" : ""}
          </option>`;
        })}
      </select>
      <form class="period-create" @submit=${onCreate}>
        <input type="text" name="period" placeholder="YYYY-MM" pattern="\\d{4}-\\d{2}" required aria-label="New period" />
        <button class="btn btn-secondary btn-sm" type="submit">Add</button>
      </form>
    </div>
  `;
}

function statusStrip({ importedCount, entityCount, consolidated, stale, passedCount, checkCount, errorFailures }) {
  const chip = (tone, label, value) => html`<div class="chip chip-${tone}"><span>${label}</span><strong>${value}</strong></div>`;
  return html`
    <div class="status-strip">
      ${chip(importedCount === entityCount ? "good" : "warn", "Trial balances", `${importedCount}/${entityCount}`)}
      ${consolidated
        ? chip(stale ? "warn" : "good", "Consolidation", stale ? "Stale" : "Done")
        : chip("warn", "Consolidation", "Not run")}
      ${chip(errorFailures === 0 ? "good" : "bad", "Validations", `${passedCount}/${checkCount}`)}
    </div>
  `;
}

// Current month, year to date, the same period last year, and the change between the two YTD
// figures. Everything but the month column comes from the comparative engine, so these cards
// and the P&L screen cannot disagree.
function kpiCard({ label, month, ytd, ytdPrior, negativeIsBad = false, monthOnly = false }) {
  const change = monthOnly ? null : yoy(ytd, ytdPrior);
  return html`
    <div class="kpi">
      <p class="label">${label}</p>
      <p class="value num ${negativeIsBad && month !== null && month < 0 ? "neg" : ""}">${idr(month)}</p>
      <dl class="kpi-compare">
        <div><dt>YTD</dt><dd class="num">${idr(ytd)}</dd></div>
        ${monthOnly
          ? ""
          : html`
              <div><dt>Prior YTD</dt><dd class="num">${idr(ytdPrior)}</dd></div>
              <div>
                <dt>YoY</dt>
                <dd class="num ${change !== null && change < 0 ? "neg" : ""}">${pct(change)}</dd>
              </div>
            `}
      </dl>
    </div>
  `;
}

function checklist(steps) {
  return html`
    <ol class="checklist">
      ${steps.map(
        (step) => html`
          <li class="checklist-item is-${step.state}">
            <span class="checklist-mark" aria-hidden="true">${step.state === "done" ? "✓" : step.state === "warn" ? "!" : ""}</span>
            <div>
              <a href=${step.href}>${step.label}</a>
              <p class="checklist-note">${step.note}</p>
            </div>
          </li>
        `
      )}
    </ol>
  `;
}

export async function renderDashboardHome(mountEl) {
  updateNav(null);
  const periods = periodRepo.listAll();
  if (periods.length > 0) {
    router.navigate(`/periods/${periodRepo.asStr(periods[0])}`);
    return;
  }
  render(
    html`
      ${pageHead({
        title: "Tally Consolidation Tool",
        subtitle: "No periods yet — create one to get started.",
      })}
      <div class="card">${renderPeriodPicker(null)}</div>
      <p class="empty">Create a period above, then head to Import TB.</p>
    `,
    mountEl
  );
}

export async function renderPeriodDashboard(mountEl, { period: periodStr }) {
  updateNav(periodStr);
  let periodRow = periodRepo.getByStr(periodStr);
  if (!periodRow) {
    router.navigate("/");
    return;
  }

  let flash = null;
  let exporting = false;

  const onDownloadPack = () => {
    exporting = true;
    view();
    afterPaint(async () => {
      try {
        await downloadExportPack(periodRow.period_id);
      } catch (err) {
        flash = { kind: "error", message: `Export failed: ${err.message}` };
        console.error(err);
      } finally {
        exporting = false;
        view();
      }
    });
  };

  const view = () => {
    periodRow = periodRepo.getByStr(periodStr);
    const periodId = periodRow.period_id;

    const validations = runAll(periodId);
    const errorFailures = validations.filter((v) => v.severity === "Error" && !v.passed);
    const failures = validations.filter((v) => !v.passed);
    const passedCount = validations.filter((v) => v.passed).length;

    const entities = entityRepo.listAll();
    const imports = tbRepo.getImportsForPeriod(periodId);
    const unmapped = unmappedLedgerCount(periodId);
    const adjustments = adjustmentCounts(periodId);
    const stale = periodRepo.isConsolidationStale(periodId);

    const hasConsolidatedData = !!persistence.get(
      "SELECT 1 AS x FROM consolidated_tb WHERE period_id = ? AND source_type = 'total' LIMIT 1",
      [periodId]
    );

    let kpis = null;
    if (hasConsolidatedData) {
      const pl = comparative.computePlComparative(periodId);
      const monthKey = comparative.monthKey(periodRow.year, periodRow.month);
      const read = (column, label) => pl.value(column, label);
      const { totalAssets, totalLe } = computeBs(periodId);
      kpis = {
        netSales: {
          month: read(monthKey, "Net Sales"),
          ytd: read(comparative.YTD_CURRENT, "Net Sales"),
          ytdPrior: read(comparative.YTD_PRIOR, "Net Sales"),
        },
        grossProfit: {
          month: read(monthKey, "Gross Profit"),
          ytd: read(comparative.YTD_CURRENT, "Gross Profit"),
          ytdPrior: read(comparative.YTD_PRIOR, "Gross Profit"),
        },
        netIncome: {
          month: pl.totalsByColumn.get(monthKey) ?? null,
          ytd: pl.totalsByColumn.get(comparative.YTD_CURRENT) ?? null,
          ytdPrior: pl.totalsByColumn.get(comparative.YTD_PRIOR) ?? null,
        },
        // A balance sheet check is a point-in-time identity, so there is no year-to-date
        // version of it to show.
        bsCheck: totalLe - totalAssets,
        ytdMissing: pl.context.missing,
      };
    }

    const onLock = () => {
      periodRepo.lock(periodId, "browser-user");
      flash = { kind: "success", message: "Period locked" };
      view();
    };

    const onUnlock = () => {
      periodRepo.unlock(periodId, "browser-user");
      flash = { kind: "success", message: "Period unlocked" };
      view();
    };

    const steps = [
      {
        label: "Import trial balances",
        href: `#/periods/${periodStr}/import`,
        state: imports.length === entities.length ? "done" : imports.length ? "warn" : "todo",
        note: `${imports.length} of ${entities.length} entities imported`,
      },
      {
        label: "Categorize ledgers",
        href: `#/periods/${periodStr}/mapping`,
        state: imports.length === 0 ? "todo" : unmapped === 0 ? "done" : "warn",
        note: unmapped === 0 ? "Every ledger with a balance has a category" : `${unmapped} ledger(s) with a balance still uncategorized`,
      },
      {
        label: "Book adjustments",
        href: `#/periods/${periodStr}/adjustments`,
        state: adjustments.draft > 0 ? "warn" : "done",
        note: adjustments.total === 0
          ? "None for this period"
          : `${adjustments.applied} applied${adjustments.draft ? `, ${adjustments.draft} still draft` : ""}`,
      },
      {
        label: "Consolidate",
        href: `#/periods/${periodStr}/consolidated`,
        state: !hasConsolidatedData ? "todo" : stale ? "warn" : "done",
        note: !hasConsolidatedData
          ? "Not run for this period yet"
          : stale
          ? "Adjustments changed since the last run — re-run it"
          : "Up to date",
      },
      {
        label: "Review validations",
        href: `#/periods/${periodStr}/validation`,
        state: errorFailures.length ? "warn" : "done",
        note: errorFailures.length
          ? `${errorFailures.length} error-severity check(s) failing`
          : `${passedCount} of ${validations.length} checks passing`,
      },
      {
        label: "Lock the period",
        href: `#/periods/${periodStr}`,
        state: periodRow.status === "locked" ? "done" : "todo",
        note: periodRow.status === "locked" ? "Locked — no further changes" : "Open; figures can still change",
      },
    ];

    render(
      html`
        ${pageHead({
          title: "Dashboard",
          subtitle: `Consolidated results for ${periodStr}.`,
          actions: renderPeriodPicker(periodStr),
        })}

        ${flash ? html`<div class="flash flash-${flash.kind}">${flash.message}</div>` : ""}

        ${statusStrip({
          importedCount: imports.length,
          entityCount: entities.length,
          consolidated: hasConsolidatedData,
          stale,
          passedCount,
          checkCount: validations.length,
          errorFailures: errorFailures.length,
        })}

        ${kpis
          ? html`
              <div class="kpis">
                ${kpiCard({ label: "Net Sales", month: kpis.netSales.month, ytd: kpis.netSales.ytd, ytdPrior: kpis.netSales.ytdPrior })}
                ${kpiCard({
                  label: "Gross Profit",
                  month: kpis.grossProfit.month,
                  ytd: kpis.grossProfit.ytd,
                  ytdPrior: kpis.grossProfit.ytdPrior,
                  negativeIsBad: true,
                })}
                ${kpiCard({
                  label: "Net Income / (Loss)",
                  month: kpis.netIncome.month,
                  ytd: kpis.netIncome.ytd,
                  ytdPrior: kpis.netIncome.ytdPrior,
                  negativeIsBad: true,
                })}
                <div class="kpi">
                  <p class="label">Balance Sheet Check</p>
                  <p class="value num ${Math.abs(kpis.bsCheck) > 1 ? "neg" : ""}">${idr(kpis.bsCheck)}</p>
                  <dl class="kpi-compare">
                    <div><dt>At</dt><dd>${periodStr} month-end</dd></div>
                  </dl>
                </div>
              </div>
              ${kpis.ytdMissing.length
                ? html`<p class="subtitle kpi-footnote">
                    Year-to-date covers only the months loaded — ${kpis.ytdMissing.join(", ")}
                    ${kpis.ytdMissing.length === 1 ? "is" : "are"} missing.
                  </p>`
                : ""}
            `
          : html`<p class="empty">
              No consolidated data yet for ${periodStr} — start with
              <a href="#/periods/${periodStr}/import">Import TB</a>.
            </p>`}

        <div class="dash-columns">
          <div class="card">
            <h2>Close checklist</h2>
            ${checklist(steps)}
          </div>

          <div class="card">
            <h2>Actions</h2>
            <div class="action-panel">
              ${periodRow.status === "locked"
                ? busyButton({ label: "Unlock period", kind: "btn btn-secondary", busy: false, onClick: onUnlock })
                : busyButton({
                    label: "Lock period",
                    busy: false,
                    disabled: errorFailures.length > 0,
                    onClick: onLock,
                  })}
              ${busyButton({
                label: "Download Excel Pack",
                busyLabel: "Building workbook…",
                kind: "btn btn-secondary",
                busy: exporting,
                onClick: onDownloadPack,
              })}
            </div>
            ${periodRow.status === "locked"
              ? html`<p class="subtitle action-note">Unlocking is an admin override and is written to the audit log.</p>`
              : errorFailures.length
              ? html`<p class="subtitle action-note">Fix the failing error-severity validations before locking.</p>`
              : ""}

            ${failures.length
              ? html`
                  <h2 class="action-subhead">Failing checks</h2>
                  <table class="compact">
                    <tbody>
                      ${failures.map(
                        (v) => html`
                          <tr>
                            <td class="num">${v.checkId}</td>
                            <td>${v.description}</td>
                            <td><span class="badge ${v.severity === "Error" ? "badge-fail" : "badge-warn"}">${v.severity}</span></td>
                          </tr>
                        `
                      )}
                    </tbody>
                  </table>
                  <p class="subtitle action-note">
                    <a href="#/periods/${periodStr}/validation">See all ${validations.length} checks</a>
                  </p>
                `
              : html`<p class="subtitle action-note">
                  All ${validations.length} checks pass.
                  <a href="#/periods/${periodStr}/validation">See details</a>
                </p>`}
          </div>
        </div>
      `,
      mountEl
    );
  };

  view();
}
