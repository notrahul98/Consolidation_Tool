import { html, render } from "../../vendor/lit-html.js";
import { persistence } from "../db/persistence.js";
import * as periodRepo from "../db/period-repo.js";
import { downloadExportPack } from "../excel/export-pack.js";
import { runAll } from "../engines/validation.js";
import { computePl, computeBs } from "../engines/statements.js";
import { updateNav } from "../layout.js";
import { router } from "../router.js";

function idr(value) {
  if (value === null || value === undefined) return "";
  const v = Number(value);
  const formatted = Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return v < 0 ? `(${formatted})` : formatted;
}

function renderPeriodPicker(mountEl, activePeriodStr) {
  const periods = periodRepo.listAll();

  const onCreate = (ev) => {
    ev.preventDefault();
    const input = ev.target.elements.period;
    const value = input.value.trim();
    if (!/^\d{4}-\d{2}$/.test(value)) return;
    const [year, month] = periodRepo.parsePeriodStr(value);
    periodRepo.getOrCreate(year, month);
    router.navigate(`/periods/${value}`);
  };

  render(
    html`
      <div class="card">
        <h2>Period</h2>
        <div class="period-picker">
          ${periods.map((p) => {
            const pstr = periodRepo.asStr(p);
            return html`<a
              class="btn btn-sm ${pstr !== activePeriodStr ? "btn-secondary" : ""}"
              href="#/periods/${pstr}"
              >${pstr} ${p.status === "locked" ? "🔒" : ""}</a
            >`;
          })}
        </div>
        <form class="field-row" @submit=${onCreate}>
          <div class="field" style="max-width:200px">
            <label for="period">New / existing period (YYYY-MM)</label>
            <input type="text" id="period" name="period" placeholder="2026-07" pattern="\\d{4}-\\d{2}" required />
          </div>
          <div class="field" style="align-self:flex-end">
            <button class="btn" type="submit">Open / Create</button>
          </div>
        </form>
      </div>
    `,
    mountEl
  );
}

export async function renderDashboardHome(mountEl) {
  updateNav(null);
  const periods = periodRepo.listAll();
  if (periods.length > 0) {
    router.navigate(`/periods/${periodRepo.asStr(periods[0])}`);
    return;
  }
  render(html`<h1>Tally Consolidation Tool</h1>`, mountEl);
  const wrap = document.createElement("div");
  mountEl.appendChild(wrap);
  renderPeriodPicker(wrap, null);
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = "No periods yet — create one above, then head to Import TB to get started.";
  mountEl.appendChild(empty);
}

export async function renderPeriodDashboard(mountEl, { period: periodStr }) {
  updateNav(periodStr);
  let periodRow = periodRepo.getByStr(periodStr);
  if (!periodRow) {
    router.navigate("/");
    return;
  }

  let flash = null;

  const view = () => {
    periodRow = periodRepo.getByStr(periodStr);
    const validations = runAll(periodRow.period_id);
    const allPass = validations.filter((v) => v.severity === "Error").every((v) => v.passed);
    const passedCount = validations.filter((v) => v.passed).length;

    const hasConsolidatedData = !!persistence.get(
      "SELECT 1 AS x FROM consolidated_tb WHERE period_id = ? AND source_type = 'total' LIMIT 1",
      [periodRow.period_id]
    );

    let kpis = null;
    if (hasConsolidatedData) {
      const { lines: plLines, netIncome } = computePl(periodRow.period_id);
      const { totalAssets, totalLe } = computeBs(periodRow.period_id);
      const totalSales = plLines.find((l) => l.label === "Total Sales")?.value ?? 0.0;
      kpis = { totalSales, netIncome, totalAssets, bsDiff: totalAssets - totalLe };
    }

    const onDownloadPack = (ev) => {
      ev.preventDefault();
      downloadExportPack(periodRow.period_id);
    };

    const onLock = (ev) => {
      ev.preventDefault();
      periodRepo.lock(periodRow.period_id, "browser-user");
      flash = { kind: "success", message: "Period locked" };
      view();
    };

    const onUnlock = (ev) => {
      ev.preventDefault();
      periodRepo.unlock(periodRow.period_id, "browser-user");
      flash = { kind: "success", message: "Period unlocked" };
      view();
    };

    render(
      html`
        <h1>Tally Consolidation Tool</h1>
        <p class="subtitle">Consolidated results for the selected period.</p>

        ${flash ? html`<div class="flash flash-${flash.kind}">${flash.message}</div>` : ""}

        <div id="picker-mount"></div>

        ${kpis
          ? html`
              <div class="kpis">
                <div class="kpi">
                  <p class="label">Total Sales</p>
                  <p class="value num">${idr(kpis.totalSales)}</p>
                </div>
                <div class="kpi">
                  <p class="label">Net Income / (Loss)</p>
                  <p class="value num ${kpis.netIncome < 0 ? "neg" : ""}">${idr(kpis.netIncome)}</p>
                </div>
                <div class="kpi">
                  <p class="label">Total Assets</p>
                  <p class="value num">${idr(kpis.totalAssets)}</p>
                </div>
                <div class="kpi">
                  <p class="label">Balance Sheet Check</p>
                  <p class="value num ${Math.abs(kpis.bsDiff) > 1 ? "neg" : ""}">${idr(kpis.bsDiff)}</p>
                </div>
              </div>
            `
          : html`<p class="empty">
              No consolidated data yet for ${periodStr} — start with
              <a href="#/periods/${periodStr}/import">Import TB</a>.
            </p>`}

        <div class="card">
          <h2>Validation status — ${passedCount}/${validations.length} passed</h2>
          <table>
            <thead><tr><th>Check</th><th>Description</th><th>Severity</th><th>Status</th></tr></thead>
            <tbody>
              ${validations.map(
                (v) => html`
                  <tr>
                    <td class="num">${v.checkId}</td>
                    <td>${v.description}</td>
                    <td>${v.severity}</td>
                    <td><span class="badge ${v.passed ? "badge-pass" : "badge-fail"}">${v.passed ? "Pass" : "Fail"}</span></td>
                  </tr>
                `
              )}
            </tbody>
          </table>
        </div>

        <div class="card">
          <h2>Period actions</h2>
          <div class="field-row">
            ${periodRow.status === "locked"
              ? html`<form @submit=${onUnlock}>
                  <button class="btn btn-secondary" type="submit">Unlock period (admin override, logged)</button>
                </form>`
              : html`<form @submit=${onLock}>
                  <button class="btn" type="submit" ?disabled=${!allPass}>Lock period</button>
                </form>`}
            <form @submit=${onDownloadPack}>
              <button class="btn btn-secondary" type="submit">Download Excel Pack</button>
            </form>
          </div>
          ${periodRow.status !== "locked" && !allPass
            ? html`<p class="subtitle" style="margin:8px 0 0">Fix failing Error-severity validations before locking.</p>`
            : ""}
        </div>
      `,
      mountEl
    );

    renderPeriodPicker(mountEl.querySelector("#picker-mount"), periodStr);
  };

  view();
}
