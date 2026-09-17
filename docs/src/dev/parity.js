// Browser half of the Python/browser parity harness. See scripts/parity_snapshot.py for why
// this exists: the tool is two implementations of the same logic kept identical by hand, the
// project has no JavaScript test runner, and that has already failed once in production.
//
// Loads the same database the Python snapshot was built from, runs every browser engine over
// it, and compares the results value by value. Anything that differs is listed; nothing is
// summarised away.
import { persistence } from "../db/persistence.js";
import * as consolidatedRepo from "../db/consolidated-repo.js";
import * as groupCoaRepo from "../db/group-coa-repo.js";
import * as comparative from "../engines/comparative.js";
import { computeBs, computePl } from "../engines/statements.js";
import { runAll } from "../engines/validation.js";
import { run as reCheckRun } from "../engines/re-check.js";
import { buildExportPack } from "../excel/export-pack.js";

const PLACES = 4;
const round = (v, places = PLACES) =>
  v === null || v === undefined ? null : Math.round(Number(v) * 10 ** places) / 10 ** places;

const report = document.getElementById("report");
const diffs = [];
let compared = 0;

// Every comparison funnels through here so the count is honest: a section that silently
// checked nothing would otherwise look like a section that passed.
function expect(path, actual, wanted) {
  compared += 1;
  const a = JSON.stringify(actual);
  const b = JSON.stringify(wanted);
  if (a !== b) diffs.push({ path, js: a, py: b });
}

function expectNumber(path, actual, wanted, tolerance = 0.01) {
  compared += 1;
  if (actual === null || wanted === null || actual === undefined || wanted === undefined) {
    if ((actual ?? null) !== (wanted ?? null)) diffs.push({ path, js: String(actual), py: String(wanted) });
    return;
  }
  if (Math.abs(Number(actual) - Number(wanted)) > tolerance) {
    diffs.push({ path, js: String(actual), py: String(wanted) });
  }
}

function compareStatement(path, lines, wanted) {
  expect(`${path}.rowCount`, lines.length, wanted.length);
  const byLabel = new Map(wanted.map((w) => [w.label, w]));
  for (const line of lines) {
    const w = byLabel.get(line.label);
    if (!w) {
      diffs.push({ path: `${path}.${line.label}`, js: "present", py: "missing" });
      compared += 1;
      continue;
    }
    expect(`${path}.${line.label}.kind`, line.kind, w.kind);
    expect(`${path}.${line.label}.level`, line.level, w.level);
    expectNumber(`${path}.${line.label}.value`, round(line.value), w.value);
    expectNumber(`${path}.${line.label}.percent`, round(line.percent, 10), w.percent, 1e-9);
  }
}

function compareComparative(path, result, wanted) {
  expect(`${path}.columns`, result.columns, wanted.columns);
  expect(`${path}.withData`, result.columns.filter((c) => result.hasData(c)), wanted.withData);
  expect(`${path}.missing`, result.context.missing, wanted.missing);
  expect(`${path}.open`, result.context.openInRange, wanted.open);
  expect(`${path}.stale`, result.context.staleInRange, wanted.stale);
  expect(`${path}.lines`, result.lines.map((l) => [l.label, l.kind, l.level]), wanted.lines);

  for (const [column, values] of Object.entries(wanted.values)) {
    for (const [label, value] of Object.entries(values)) {
      expectNumber(`${path}.values[${column}][${label}]`, round(result.value(column, label)), value);
    }
  }
  for (const [column, percents] of Object.entries(wanted.percents)) {
    for (const [label, value] of Object.entries(percents)) {
      expectNumber(`${path}.percents[${column}][${label}]`, round(result.percent(column, label), 10), value, 1e-9);
    }
  }
  for (const [column, value] of Object.entries(wanted.totals)) {
    expectNumber(`${path}.totals[${column}]`, round(result.totalsByColumn.get(column)), value);
  }
}

function compareBuckets(path, periodId, wanted) {
  const { byAccountEntity, groupAdjustment, total } = consolidatedRepo.getBuckets(periodId);
  const asObject = (map, keyFn = (k) => String(k)) =>
    Object.fromEntries([...map].map(([k, v]) => [keyFn(k), round(v)]));
  // Python keys the entity bucket "<account>:<entity>" with a literal None for group rows;
  // the browser already uses that same string form.
  expect(`${path}.byAccountEntity`, asObject(byAccountEntity), wanted.byAccountEntity);
  expect(`${path}.groupAdjustment`, asObject(groupAdjustment), wanted.groupAdjustment);
  expect(`${path}.total`, asObject(total), wanted.total);
}

function compareValidations(path, periodId, wanted) {
  const actual = runAll(periodId).map((v) => ({
    checkId: v.checkId, description: v.description, severity: v.severity,
    passed: v.passed, details: v.details,
  }));
  expect(`${path}.checkIds`, actual.map((v) => v.checkId), wanted.map((v) => v.checkId));
  const byId = new Map(wanted.map((v) => [v.checkId, v]));
  for (const v of actual) {
    const w = byId.get(v.checkId);
    if (!w) continue;
    expect(`${path}.${v.checkId}.passed`, v.passed, w.passed);
    expect(`${path}.${v.checkId}.severity`, v.severity, w.severity);
    expect(`${path}.${v.checkId}.details`, v.details, w.details);
  }
}

function compareReCheck(path, periodId, wanted) {
  const result = reCheckRun(periodId);
  expect(`${path}.applicable`, result.applicable, wanted.applicable);
  expect(`${path}.reason`, result.reason, wanted.reason);
  expect(`${path}.priorPeriodStr`, result.priorPeriodStr, wanted.priorPeriodStr);
  expect(`${path}.rowCount`, result.rows.length, wanted.rows.length);
  expect(`${path}.linkedAdjustmentCount`, result.linkedAdjustments.length, wanted.linkedAdjustmentCount);
  result.rows.forEach((row, i) => {
    const w = wanted.rows[i];
    if (!w) return;
    expect(`${path}.rows[${i}].entityCode`, row.entityCode, w.entityCode);
    expectNumber(`${path}.rows[${i}].reClosingPrior`, round(row.reClosingPrior), w.reClosingPrior);
    expectNumber(`${path}.rows[${i}].priorNetProfit`, round(row.priorNetProfit), w.priorNetProfit);
    expectNumber(`${path}.rows[${i}].reClosingCurrent`, round(row.reClosingCurrent), w.reClosingCurrent);
    expectNumber(`${path}.rows[${i}].gap`, round(row.gap), w.gap);
  });
}

function compareMatrix(path, periodId, wanted) {
  const { context, columns, totalsByMonth } = comparative.consolidatedMatrix(periodId);
  expect(`${path}.columns`, columns, wanted.columns);
  expect(`${path}.missing`, context.missing, wanted.missing);
  expect(`${path}.open`, context.openInRange, wanted.open);
  const byCode = new Map(groupCoaRepo.listAll().map((r) => [r.group_account_id, r.account_code]));
  for (const column of wanted.columns) {
    const actual = {};
    for (const [accountId, v] of totalsByMonth.get(column) || []) {
      const code = byCode.get(accountId);
      if (code) actual[code] = round(v);
    }
    expect(`${path}.cells[${column}]`, actual, wanted.cells[column]);
  }
}

function comparePack(path, periodId, wanted) {
  const { workbook } = buildExportPack(periodId);
  expect(`${path}.sheetNames`, workbook.worksheets.map((w) => w.name), wanted.sheetNames);

  for (const [name, cells] of Object.entries(wanted.cells)) {
    const ws = workbook.getWorksheet(name);
    if (!ws) {
      diffs.push({ path: `${path}.${name}`, js: "sheet missing", py: "present" });
      compared += 1;
      continue;
    }
    const actual = {};
    ws.eachRow({ includeEmpty: false }, (row) =>
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        if (v === null || v === undefined) return;
        if (typeof v === "object" && v.formula !== undefined) actual[cell.address] = { f: v.formula };
        else if (typeof v === "number") actual[cell.address] = { v: round(v) };
        else actual[cell.address] = { s: String(v) };
      })
    );
    for (const [address, want] of Object.entries(cells)) {
      const got = actual[address];
      compared += 1;
      if (!got) {
        diffs.push({ path: `${path}.${name}!${address}`, js: "empty", py: JSON.stringify(want) });
      } else if (want.f !== undefined || got.f !== undefined) {
        if (want.f !== got.f) diffs.push({ path: `${path}.${name}!${address}`, js: got.f, py: want.f });
      } else if (want.v !== undefined || got.v !== undefined) {
        if (Math.abs((got.v ?? 0) - (want.v ?? 0)) > 0.01) {
          diffs.push({ path: `${path}.${name}!${address}`, js: String(got.v), py: String(want.v) });
        }
      } else if (want.s !== got.s) {
        // ExcelJS materialises a spacer as "" where openpyxl leaves the cell absent; both
        // render blank, so an empty string against nothing is not a difference.
        if (!(got.s === "" && want.s === undefined)) {
          diffs.push({ path: `${path}.${name}!${address}`, js: got.s, py: want.s });
        }
      }
    }
  }
}

function render(summary) {
  const ok = diffs.length === 0;
  report.innerHTML = `
    <div class="flash ${ok ? "flash-success" : "flash-error"}">
      <strong>${ok ? "Parity holds" : `${diffs.length} difference${diffs.length === 1 ? "" : "s"}`}</strong>
      — ${compared.toLocaleString()} comparisons across ${summary.periods} period(s) from
      <code>${summary.source}</code>.
    </div>
    ${ok ? "" : `
      <div class="card">
        <table class="compact">
          <thead><tr><th>Where</th><th>Browser</th><th>Python</th></tr></thead>
          <tbody>
            ${diffs.slice(0, 200).map((d) => `
              <tr>
                <td>${d.path}</td>
                <td class="num neg">${(d.js ?? "").toString().slice(0, 90)}</td>
                <td class="num">${(d.py ?? "").toString().slice(0, 90)}</td>
              </tr>`).join("")}
          </tbody>
        </table>
        ${diffs.length > 200 ? `<p class="subtitle">…and ${diffs.length - 200} more.</p>` : ""}
      </div>`}
    <div class="card">
      <h2>What was compared</h2>
      <ul class="check-details">${summary.sections.map((s) => `<li>${s}</li>`).join("")}</ul>
    </div>`;
}

async function main() {
  let expected;
  try {
    expected = await (await fetch(`_parity/expected.json?t=${Date.now()}`)).json();
  } catch {
    report.innerHTML = `<div class="flash flash-warn">
      No snapshot found. Run <code>python scripts/parity_snapshot.py &lt;database&gt;</code> first —
      it writes <code>docs/_parity/expected.json</code> and copies the database next to it.
    </div>`;
    return;
  }

  // Loads into the same in-memory database the app uses, so the engines run exactly as they do
  // in the app rather than against some parallel setup.
  await persistence.init("");
  const fixture = await (await fetch(`_parity/fixture.db?t=${Date.now()}`)).blob();
  await persistence.loadBackupFile(fixture, "");

  const sections = [];
  for (const period of expected.periods) {
    const id = period.periodId;
    const p = `${period.label}`;
    const pl = computePl(id);
    compareStatement(`${p}.pl`, pl.lines, period.pl.lines);
    expectNumber(`${p}.pl.netIncome`, round(pl.netIncome), period.pl.netIncome);

    const bs = computeBs(id);
    compareStatement(`${p}.bs`, bs.lines, period.bs.lines);
    expectNumber(`${p}.bs.totalAssets`, round(bs.totalAssets), period.bs.totalAssets);
    expectNumber(`${p}.bs.totalLe`, round(bs.totalLe), period.bs.totalLe);

    compareBuckets(`${p}.buckets`, id, period.buckets);
    compareComparative(`${p}.plComparative`, comparative.computePlComparative(id), period.plComparative);
    compareComparative(`${p}.bsComparative`, comparative.computeBsComparative(id), period.bsComparative);
    compareMatrix(`${p}.matrix`, id, period.matrix);
    compareValidations(`${p}.validations`, id, period.validations);
    compareReCheck(`${p}.reCheck`, id, period.reCheck);
    sections.push(`${p}: statements, buckets, comparatives, matrix, validations, RE check`);
  }

  if (expected.pack) {
    comparePack("pack", expected.pack.periodId, expected.pack);
    const cells = Object.values(expected.pack.cells).reduce((n, c) => n + Object.keys(c).length, 0);
    sections.push(`Excel pack: ${cells} cells across ${Object.keys(expected.pack.cells).length} sheets, formulas as text`);
  }

  render({ periods: expected.periods.length, source: expected.generatedFrom, sections });
  // So a caller driving this page can read the outcome without scraping the DOM.
  window.__parity = { compared, diffs };
}

main().catch((err) => {
  report.innerHTML = `<div class="flash flash-error">Parity run failed: ${err.message}</div>`;
  console.error(err);
});
