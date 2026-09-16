# Tally Consolidation Tool — Progress Report

**As of:** 15 September 2026
**Code state:** commit `953a8ed` on `master`, identical to `main` on GitHub, deployed live
**Tests:** 120 passing (Python). There are **no** JavaScript tests.

This report records what has been built, what was fixed, what was verified and how, and what
is still open. It is written to be handed to a new session or another tool (for example
Cursor) as the starting context for the next upgrade.

> ⚠️ **`HANDOVER.md` is out of date.** It predates all of Phase 7 and the September fixes: it
> still says 57 tests, two periods, and describes the stock/COGS adjustment as unbooked. Treat
> this report as current and `HANDOVER.md` as background only. `PLAN_PHASE7.md` is the design
> spec Phase 7 was built from; section 9 below lists where the build departs from it.

---

## Contents

1. [What the tool is](#1-what-the-tool-is)
2. [Where things live](#2-where-things-live)
3. [Timeline](#3-timeline)
4. [Phase 7 — features delivered](#4-phase-7--features-delivered)
5. [September — defects found and fixed](#5-september--defects-found-and-fixed)
6. [Tooling added](#6-tooling-added)
7. [Work done on the live data](#7-work-done-on-the-live-data)
8. [Verification evidence](#8-verification-evidence)
9. [Gaps against the Phase 7 plan](#9-gaps-against-the-phase-7-plan)
10. [Open accounting items](#10-open-accounting-items)
11. [Traps for whoever works on this next](#11-traps-for-whoever-works-on-this-next)
12. [Recommended next upgrades](#12-recommended-next-upgrades)

---

## 1. What the tool is

Consolidates monthly Tally trial balance exports from four wholly-owned Indonesian
subsidiaries into a group P&L and Balance Sheet.

| Code | Entity |
|------|--------|
| BII | PT Bahan Indonesia Indah |
| KDI | PT Klasik Distribusi Indonesia |
| KNS | PT Kreasi Nusantara Sejati |
| VKS | VKS Co (Batik & Non-Batik) |

Monthly flow: import four TBs → categorise ledgers into a fixed 98-row category list → enter
adjustments → book stock/COGS → consolidate → review validations → export the Excel pack →
lock the period.

### Three interfaces over one design

| Interface | How to run | Storage | Size |
|---|---|---|---|
| Python web dashboard | `python -m src.web` | `data\consolidation.db` (SQLite) | ~4,400 lines of Python across `src/` |
| Python CLI | `python -m src.cli <command>` | same file | shared with the above |
| **Browser app (in daily use)** | https://notrahul98.github.io/Consolidation_Tool/ | browser IndexedDB via `sql.js` | ~4,600 lines of JavaScript in `docs/src/` |

The browser app is a from-scratch JavaScript port, not a wrapper. Both codebases implement the
same engines separately, and **must be kept logically identical by hand**. Most defects found in
September were places where that parity had broken or where a port was never verified.

Nothing is sent to any server. Moving data between the browser and the Python tool is manual,
through the Download backup / Load backup buttons.

---

## 2. Where things live

### Repository

| Path | Contents |
|---|---|
| `src/engines/` | `consolidation_engine.py`, `adjustment_engine.py`, `statement_generator.py`, `validation_engine.py`, `stock_engine.py`, `re_check.py` |
| `src/db/repositories/` | data access; `consolidated_repo.get_buckets` is the shared aggregation (see §5) |
| `src/db/migrations/` | `001`–`005`; the browser app lists the same files in `docs/src/db/persistence.js` |
| `src/exporters/` | `excel_pack_generator.py`, `adjustment_workbook.py`, `mapping_workbook.py` |
| `src/web/` | FastAPI routes and Jinja templates |
| `docs/` | the browser app; `docs/src/` mirrors `src/` |
| `scripts/audit_split_ledgers.py` | read-only sweep for mis-mapped ledgers (§6) |
| `tests/` | 120 tests; `tests/fixtures/` holds the real May and June TBs |
| `config/group_coa_fixed.json` | the fixed category list |

### Git and deployment

| Remote | Points at | Status |
|---|---|---|
| `github` | https://github.com/notrahul98/Consolidation_Tool.git | **the real remote** |
| `origin` | `D:\Projects\GitHub\Tally Consolidation Tool` | an obsolete local mirror, 20 commits behind; ignore it |

Local branch `master` is pushed to `main` on GitHub with `git push github HEAD:main`. GitHub
Pages serves `main:/docs` and redeploys within about a minute of a push; no Actions workflow is
involved. The local branch `phase7-bcd` tracks `github/main` and is kept level with it.

### Live data and outputs

| Item | Location |
|---|---|
| Browser data | the browser's IndexedDB — **the live working copy** |
| August backup (May–Aug) | `D:\KNS Group\Monthly Tasks\2026\8. Aug\consolidation - Aug.db` |
| July backup (May–Jul) | `D:\KNS Group\Monthly Tasks\2026\7. July\Financials\consolidation 07-26 V3.db` |
| Repaired August database | `D:\KNS Group\Monthly Tasks\2026\8. Aug\consolidation - Aug (KDI fix, reconsolidated).db` |
| Corrected July pack | `D:\KNS Group\Monthly Tasks\2026\7. July\Financials\Consolidated Pack 2026-07 (corrected).xlsx` |
| Corrected August pack | `D:\KNS Group\Monthly Tasks\2026\8. Aug\Consolidated Pack 2026-08 (corrected).xlsx` |

`data\consolidation.db` inside the repository is stale: it holds only May and June.

---

## 3. Timeline

| Date | Work | Commits |
|---|---|---|
| 27 Jul | Phases 1 and 2 complete: import, mapping, consolidation, adjustments, validations, Excel pack, locking, Python web dashboard | `4b51955` |
| 29 Jul | Browser app built and deployed to GitHub Pages | `b5deb86`, `6b54f63` |
| 12–13 Aug | Phase 7.1–7.4 in Python: per-entity mapping, stock/COGS, Retained Earnings check, editable adjustments | `cd220f9`, `6eda738`, `a094cbb`, `1dda529` |
| 13–14 Aug | Phase 7.5: ports of stock/COGS, Retained Earnings check and editable adjustments to the browser app, plus two bug fixes | `3cda5de`, `04521af`, `63ff8eb`, `c9da5c3` |
| 9 Sep | Excel pack and Consolidated TB defects fixed; branch divergence reconciled; mapping page ported; sweep script | `283e8e9`, `f521c51`, `324ca1c`, `5169e4d` |
| 10 Sep | Retained Earnings check defect fixed | `953a8ed` |

> **History note.** Phase 7.2–7.5 exist twice in the log with different hashes (for example
> `6eda738` and `b4042c8`). Those commits were rebased onto `main` without Phase 7.1, so the
> two branches diverged. `f521c51` reconciles them with a `-s ours` merge, which kept master's
> content byte-for-byte and preserved main's history without a force push. Seeing the duplicates
> is expected; nothing is lost or doubled in the code.

---

## 4. Phase 7 — features delivered

Specified in `PLAN_PHASE7.md`. Each is present in both the Python tool and the browser app
unless stated.

### A. Per-entity ledger mapping

A ledger name can legitimately mean different things in different entities. `12% Interest on
Shareholders Loan A/c` is an expense in VKS and a liability in KDI.

- A ledger whose Tally primary group or category differs across entities renders as a parent
  row with one editable child row per entity.
- Saves for such a ledger go through `apply_mapping_for_entity`.
- A whole-ledger write against a split ledger is **refused**, and the refusal is atomic: if any
  row in a submission fails, nothing in that submission is written.
- Files: `src/web/routes/mapping.py`, `src/db/repositories/mapping_repo.py`,
  `docs/src/pages/mapping.js`, `docs/src/db/mapping-repo.js`.

Built in Python on 12 August. The browser port was **missed** in Phase 7.5 and only completed on
9 September (`324ca1c`), so the browser app, the one in daily use, kept flattening splits until
then. The Mapping.xlsx import is still unprotected; see §9.

### B. Stock / COGS

`COGS = Opening Stock + Purchases − Closing Stock`, per entity.

- New **Stock** page. Opening stock is pulled from the prior period's post-adjustment Inventory;
  closing stock from the current TB; purchases from ledgers mapped to `COGS before Direct Cost &
  Forex Gain/Loss`.
- Every figure is editable. Auto-pulled and overridden values are stored separately (migration
  `004`, table `stock_movement`), so re-pulling never discards a typed figure.
- A per-entity choice of balancing account, Inventory or Retained Earnings, for cases where Tally
  restated stock without a journal.
- **Generate adjustment** builds a draft `inventory_movement` entry through the normal validated
  adjustment path.
- Validation **V19** (warning) flags a period with inventory but no applied stock adjustment, or
  one whose figures changed after it was generated.
- Python only: the plan's `stock-show`, `stock-set` and `stock-generate` CLI commands were not
  built. See §9.

### C. Retained Earnings movement check

`expected RE = prior RE + prior month net profit`; the gap is `actual RE − expected`.

- New **Retained Earnings** page: a reconciliation, a per-entity table, and a table of linked
  adjustments from both months that touch Retained Earnings or any P&L category, each linking to
  that adjustment's edit page.
- Validation **V20** is a warning by design and never blocks locking.
- Diagnostic rather than prescriptive, because it was not known whether these books update
  Retained Earnings monthly. On the live data they do not; see §10.

### D. Editing applied adjustments

- An Edit button on every adjustment, draft or applied, hidden when the period is locked.
- Editing returns the adjustment to draft, so it must be re-applied and the period
  re-consolidated. The external reference cannot be changed by editing.
- The audit log stores a JSON snapshot of the adjustment **before and after** each edit.
- A **stale consolidation banner** appears on every period page once adjustments change after the
  last consolidation. Migration `005` moved the marker from timestamps to the audit log's
  monotonic ID, because timestamps could collide or compare out of order under rapid edits.
- CLI: `edit-adjustment`.

### E. Browser port

Stock, Retained Earnings and editable adjustments were ported in August. The mapping page was
ported in September, completing the workstream.

---

## 5. September — defects found and fixed

Found while investigating a report that the exported August Balance Sheet did not match the
tool's screen.

### The common root cause

A **group-level adjustment**, one with no entity, is stored with `entity_id IS NULL`. So is the
consolidated `total` row. Any code that groups consolidated rows by entity alone either loses
group-level adjustments or merges them with the total. That single trap produced three of the
four defects below.

**The fix for the class**: one shared aggregation, `consolidated_repo.get_buckets` in Python and
`getBuckets` in the browser app. It separates by row type first and returns three buckets:
entity figures (TB plus adjustments booked against that entity), group-level adjustments, and the
authoritative total. The Consolidated TB page and the Excel exporter both use it now, so they
cannot drift apart again.

### The four defects

| # | Defect | Effect | Fixed in |
|---|---|---|---|
| 1 | Excel pack: the matrix Total summed only the entity columns, excluding the Adjustments column | Group-level adjustments **dropped** from the workbook. Six Balance Sheet lines wrong while Total Assets, Total Liabilities and Equity, and Check all still tied, because a balanced journal hides inside the totals | `283e8e9`, both languages |
| 2 | Consolidated TB page grouped rows by entity alone | Group-level adjustments **double-counted** in the Total column | `283e8e9`, both languages |
| 3 | Browser Mapping page never ported (Phase 7.1) | Saving flattened per-entity splits in the app in daily use | `324ca1c` |
| 4 | Retained Earnings check built its group row from per-entity figures | Group-level adjustments dropped from Retained Earnings but kept in net profit, so the reported gap was wrong by exactly those adjustments | `953a8ed`, both languages |

### Impact on the real August pack (defect 1)

Two group-level adjustments, both copied forward monthly, were missing from the workbook:

- `ADJ-07-04` — shareholder loan reclass from Retained Earnings, 13,608,330,781
- `ADJ-07-06` — reclass between Other Payables and Accounts Payable, 395,512,578

| Balance Sheet line | Old pack | Tool |
|---|---|---|
| Accounts Payable | 1,268,911 | (394,243,667) |
| Loans & Advances taken | 82,589,308,094 | 96,197,638,875 |
| Other Payables | (4,748,437,636) | (4,352,925,058) |
| Total Short Term Liabilities | 77,933,693,235 | 91,542,024,016 |
| Retained Earnings | (57,518,131,913) | (71,126,462,694) |
| Total Equity | (53,518,131,913) | (67,126,462,694) |

Every pack containing a group-level adjustment was affected, which includes July.

### Impact on the Retained Earnings check (defect 4)

On July, the check reported a gap of 6,602,843,699. The correct figure is 20,211,174,480, the
difference being exactly `ADJ-07-04`.

---

## 6. Tooling added

### `scripts/audit_split_ledgers.py`

A read-only sweep, opening the database with `mode=ro`, that reports per period:

| Section | Meaning |
|---|---|
| **FLATTENED** | Tally group differs across entities, yet every entity shares one category. The fingerprint of a whole-ledger save. Re-consolidating does not repair it, because the mapping itself was overwritten |
| SPLIT | groups and categories both differ; already handled |
| INCONSISTENT | same group, different categories; may be deliberate |
| MISMATCH | Tally group implies one statement, the category sits on the other. Heuristic with expected false positives: Tally's own `Profit & Loss A/c` correctly maps to Retained Earnings |

```bash
python scripts/audit_split_ledgers.py --db "path/to/backup.db"
python scripts/audit_split_ledgers.py --period 2026-08 --strict
```

`--strict` exits with status 1 when anything is flattened.

### Regression tests

| File | Tests | Guards |
|---|---|---|
| `tests/test_excel_pack.py` | 10 | Evaluates the workbook's whole formula chain and diffs every line against `compute_pl` and `compute_bs`. Covers group-level, entity-specific and mixed adjustments. Seven fail if the defect 1 fix is reverted |
| `tests/test_audit_split_ledgers.py` | 16 | Flattened versus split classification, plus an end-to-end run with `--strict` |
| `tests/test_re_check.py` | +1 | Group-level Retained Earnings adjustments reach the group row. Returns 0.0 instead of the adjustment if the fix is reverted |

Every fix in September was checked by reverting it and confirming its test fails.

---

## 7. Work done on the live data

All work was done on copies. The original backups were never opened for writing.

### Sweep of May–August

- **One** flattened ledger in all four months: `12% Interest on Shareholders Loan A/c`, with both
  KDI and VKS on the P&L category.
- The damage was **3 rupiah** a month: KDI's balance of 3 sitting in the P&L instead of the
  Balance Sheet.
- The interest expense itself was always correctly in the P&L. An earlier report that it was not
  came from a collapsed Mapping screen rather than from the statements.
- No inconsistent mappings in the live data.

### Repair

KDI's ledger was pointed back to `Loans & Advances taken`, and all four periods re-consolidated.
My change moved exactly 3 rupiah; this was confirmed by diffing the Balance Sheet before and after
on the same file. The sweep then reported zero flattened ledgers.

| Period | Net income after repair | Change |
|---|---|---|
| 2026-05 | 3,715,138,060 | 0 |
| 2026-06 | (1,763,426,354) | 0 |
| 2026-07 | (709,158,980) | 3 |
| 2026-08 | (1,010,193,883) | 3 |

> ⚠️ **The repair is not in the browser.** It exists only in the repaired database file. Loading
> that file replaces everything in the browser, and it was built from the 9 September backup, so
> later work would be lost. The recommended route is to repeat the repair in the app instead: on
> Mapping, set KDI's row for that ledger to `Loans & Advances taken`, save, and recalculate all
> four periods.

### Corrected packs

Generated from the repaired database. Each workbook's formula chain was evaluated and every line
diffed against the tool: **zero differences** in both statements for both months.

| Line | July | August |
|---|---|---|
| Total Sales | 571,744,894 | 369,732,525 |
| Gross Profit | 314,912,221 | 18,383,591 |
| Interest on Shareholder loan | 283,297,540 | 285,836,718 |
| Net income after tax | (709,158,980) | (1,010,193,883) |
| Total Assets | 22,634,497,123 | 24,415,561,322 |
| Loans & Advances taken | 89,138,161,486 | 91,838,584,598 |
| Total Short Term Liabilities | 88,750,765,931 | 91,542,024,013 |
| Check | 0 | 1 |

The August pack differs from the one reported in more than the exporter fix. **`ADJ-08-01`**,
booked on 9 September at 09:44 after the old pack was exported, moves 4,359,054,274 from Other
Payables into Loans & Advances taken in VKS. It is a legitimate entry appearing in the pack for
the first time, not a regression.

If the browser has been used since 9 September, these packs are behind the live data and should
be re-exported from the app.

---

## 8. Verification evidence

| Claim | How it was verified |
|---|---|
| Excel pack matches the tool | Formula chain evaluated in Python, since no Excel or Node is available; every line diffed against the statement engine; on test fixtures and on all four live periods |
| Browser app matches Python | Live browser sessions against a database holding both kinds of adjustment: identical buckets, exporter formula `=SUM(D16:H16)`, identical Consolidated TB rows, identical Retained Earnings figures to the rupiah across four months |
| Mapping port behaves correctly | In the browser: split renders as parent and children with correct preselection; per-entity save changes only that entity; whole-ledger write refused and an unrelated edit in the same submission not written; ordinary save still works |
| Tests catch the defects | Each fix reverted, the relevant tests confirmed failing, fix restored |
| Deployment is live | Deployed files fetched from GitHub Pages and checked for the new code |
| Repair moved only 3 rupiah | Balance Sheet diffed before and after on the same database |

---

## 9. Gaps against the Phase 7 plan

| Plan section | Item | Status |
|---|---|---|
| §1.3 | Mapping.xlsx `Entity Code` column, with the split guard on import | **Not built. A live risk.** `import_mapping_workbook` still calls whole-ledger `apply_mapping` with no guard, so running `python -m src.cli import-mapping` can still flatten per-entity splits. The browser app has no workbook import and is unaffected |
| §1.5 | Data repair and sweep | Done (§6, §7) |
| §2.6 | `stock-show`, `stock-set`, `stock-generate` CLI commands | Not built. The Stock screen works in both web interfaces |
| §5 | Side-by-side verification of every screen and the Excel pack | Done for the Excel pack, Consolidated TB, Mapping and Retained Earnings. **Not** done for the Stock screen or the adjustment edit form |

---

## 10. Open accounting items

These need a finance decision, not code.

### Purchases missing for three of four entities (highest priority)

In August only KNS has a ledger mapped to COGS (`Purchase Intercompany`, 10,280,724). BII, KDI and
VKS show purchases of zero on the Stock screen, so their computed COGS is opening minus closing
with no purchases. If they bought nothing, this is fine. Otherwise COGS is understated.

### Retained Earnings does not move by prior month profit

Group figures from the corrected check, on the 9 September backup:

| Period | Prior RE | Prior net profit | Actual RE | Gap |
|---|---|---|---|---|
| 2026-06 | 53,929,971,902 | 3,715,138,060 | 50,959,361,702 | (6,685,748,260) |
| 2026-07 | 50,959,361,702 | (1,763,426,354) | 69,407,109,827 | 20,211,174,480 |
| 2026-08 | 69,407,109,827 | (709,158,983) | 70,116,268,808 | 1,418,317,963 |

The underlying Tally Retained Earnings ledger moves independently of monthly profit, which
suggests the books restate rather than roll forward. July is dominated by `ADJ-07-04`. Once it is
known how Retained Earnings should behave, the check can be tightened around that rule.

### Also open

- **August Check row is 1 rupiah.** Pre-existing rounding; unaffected by any of this work.
- **Stock restatement decision.** In the live data, BII's inventory was taken to Retained Earnings
  (`ADJ-07-08`, 3,804,418,750) while KDI, KNS and VKS went through COGS against Inventory. Worth
  confirming this is intended and will stay consistent month to month.
- Carried over from `HANDOVER.md`: KDI "Other Income" as a shareholder loan repayment; sample
  expenses distorting Sales and COGS; the opening balance break; intercompany eliminations.
- All four periods are still **open**. None has been locked.

---

## 11. Traps for whoever works on this next

1. **`entity_id IS NULL` means two different things.** A group-level adjustment and the
   consolidated total row both carry it. Never group consolidated rows by entity alone; use
   `get_buckets` / `getBuckets`. This caused three separate bugs.
2. **Two codebases, no shared code.** Every engine change must be made in `src/` and `docs/src/`.
   There are no JavaScript tests, so a port is only verified if someone verifies it by hand.
3. **Sum, never overwrite.** One account and entity can have both a TB row and an adjustment row.
   Last-write-wins silently loses the TB value (`HANDOVER.md` §9.6).
4. **Sort with `codepointCompare`, not `localeCompare`,** or JavaScript orders mixed-case names
   differently from Python.
5. **The Excel pack has no cached values.** Excel calculates on open. openpyxl reads `None`, so
   workbook numbers can only be checked by evaluating formulas; `tests/test_excel_pack.py`
   contains a small evaluator for that.
6. **Browser module caching** hides deployed changes during testing. Test locally on a fresh
   origin such as `127.0.0.1` rather than `localhost`, or bypass the cache.
7. **Wait for `indexedDB.deleteDatabase` to finish** before reloading when testing. Reloading
   mid-delete produces a spurious "UNIQUE constraint failed: schema_migrations" boot error. It
   does not reproduce on the live site from a clean state.
8. **Push to `github`, not `origin`.** `origin` is an obsolete local mirror.
9. **Loading a backup replaces the browser's data entirely.** There is no merge. Always download a
   current backup before loading another.
10. **No Node.js in this environment.** JavaScript cannot be syntax-checked or unit-tested from
    the command line here; the running app is the only check.

---

## 12. Recommended next upgrades

In priority order.

| # | Upgrade | Why |
|---|---|---|
| 1 | **Guard the Mapping.xlsx import** and add its `Entity Code` column (plan §1.3) | Closes the last path that can still flatten per-entity mappings |
| 2 | **Resolve and map purchase ledgers** for BII, KDI and VKS | Largest known effect on reported COGS |
| 3 | **A JavaScript test harness** that runs the browser engines against the Python fixtures and diffs results | Every September defect was a parity gap or an unverified port. This is the structural fix |
| 4 | **Decide the Retained Earnings rule**, then turn V20 from a diagnostic into a real check | Currently reports large unexplained gaps every month |
| 5 | **Stock CLI commands** (plan §2.6) | Plan parity; low effort |
| 6 | **Side-by-side verification of the Stock screen and adjustment editing** | The two Phase 7 screens never cross-checked between languages |
| 7 | **Run the split-ledger sweep automatically**, on consolidation or as a validation | Stops silent re-flattening from ever going unnoticed again |
| 8 | **Replace `HANDOVER.md`** with this report, or merge them | Avoids a stale document misleading the next session |
| 9 | **Month-on-month, YTD and year-on-year comparatives** | Explicitly never built; four periods of live data now exist to support it |
| 10 | **Lock closed periods** | May–August are all still open and editable |
