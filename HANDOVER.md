# Tally Consolidation Tool — Project Handover

**Everything lives in one folder: `D:\Projects\Tally Consolidation Tool`**

This document is a complete, self-contained brief. If you start a fresh chat, point it at this
file and it will have the full picture without needing the old conversation.

---

## 1. What this tool does

Consolidates monthly Tally trial balance (TB) Excel exports from **4 wholly-owned Indonesian
subsidiaries** into a single group P&L and Balance Sheet.

| Code | Entity |
|------|--------|
| BII | PT Bahan Indonesia Indah |
| KDI | PT Klasik Distribusi Indonesia |
| KNS | PT Kreasi Nusantara Sejati |
| VKS | VKS Co (Batik & Non-Batik) |

The monthly flow: **import 4 TB files → categorize each ledger into a fixed P&L/BS category →
enter adjustments → consolidate → review validations → export the Excel pack → lock the period.**

**Three interfaces now exist, all driving logically identical engine logic** (verified
line-by-line against each other — see §5):
- **Web dashboard (local)** — `python -m src.web` — click-through UI, runs on your machine
- **CLI (local)** — `python -m src.cli ...` — same operations from the command line
- **Web app (browser, no install)** — **https://notrahul98.github.io/Consolidation_Tool/** —
  a from-scratch JavaScript port that runs entirely in any browser, no Python/server needed.
  Data stays local to whichever browser loads it (via `sql.js`, SQLite compiled to
  WebAssembly) — nothing is ever uploaded anywhere. See §6.

Python + SQLite (local tools), or pure client-side JS + SQLite-in-WASM (web app). Nothing is
hosted server-side or sent to any backend in either case.

---

## 2. Where everything is

### The Python tool + all data (unchanged location)
```
D:\Projects\Tally Consolidation Tool
```

| Path | What it is |
|------|-----------|
| `data\consolidation.db` | **⚠️ THE SINGLE MOST IMPORTANT FILE.** SQLite database holding all imported TBs, every ledger categorization, all adjustments, and the full audit log. |
| `src\` | Python source code (see §7 for the map) |
| `docs\` | **The new web app** (static JS, deploys to GitHub Pages — see §6) |
| `config\group_coa_fixed.json` | Fixed 98-row P&L/Balance Sheet category list |
| `config\app_settings.json` | Entity codes/names, DB path, tolerance |
| `tests\` | 57 automated Python tests |
| `tests\fixtures\` | Copies of all 8 real TB files, used by tests and by the web app's own verification |
| `README.md` | User-facing guide + worked adjustment examples |
| `HANDOVER.md` | This file |

### This project is now a git repository, pushed to GitHub
- **Local repo:** `D:\Projects\Tally Consolidation Tool` (branch `master`)
- **GitHub repo:** https://github.com/notrahul98/Consolidation_Tool (branch `main`)
- **Live web app:** https://notrahul98.github.io/Consolidation_Tool/ (GitHub Pages, serving from the `main` branch's `/docs` folder)
- A secondary local mirror also exists at `D:\Projects\GitHub\Tally Consolidation Tool` (bare repo) and `D:\Projects\GitHub\Tally Consolidation Tool - Working` (a clone of it) — these were an earlier local-only backup setup, now superseded by the real GitHub remote. Not needed going forward, but harmless to leave in place.

### Your source data files (inputs you provided)
| Path | What it is |
|------|-----------|
| `TB BII Jun 26.xlsx`, `TB KDI V4.xlsx`, `TB KNS V3.xlsx`, `TB VKS June 26.xlsx` | June TBs |
| `May TB\*.xlsx` | May TBs (4 entities) |
| `Kreasi Financials FY June 2026 Draft V2.xlsx` | Your existing manual workbook — the reference template the P&L/BS layout was copied from |
| `Mapping from File.xlsx` | The categorization mapping you originally supplied |

---

## 3. How to run each interface

### Local web dashboard (Python)
```bash
cd "D:\Projects\Tally Consolidation Tool"
pip install -r requirements.txt          # first time only
python -m src.web                        # starts dashboard at 127.0.0.1:8420
```
Stop with `Ctrl+C`. Only runs while you want it to.

### Local CLI (Python)
Full reference in `README.md`. Commands: `import-tb`, `export-mapping`, `import-mapping`,
`consolidate`, `export-pack`, `export-adjustments`, `import-adjustments`, `apply-adjustments`,
`copy-adjustments`, `delete-adjustment`, `lock-period`, `unlock-period`.

### Web app (browser, anywhere)
Just open **https://notrahul98.github.io/Consolidation_Tool/**. On first visit it starts empty
(4 entities, 98 categories, 0 periods). To load your real data: click **Load backup (.db)** in
the top bar and select `data\consolidation.db`. Click **Download backup (.db)** any time to save
your work back out. Nothing is transmitted anywhere — the whole app runs in your browser via
WebAssembly SQLite.

**Important:** the web app's data lives only in the browser that loaded it (IndexedDB). There is
no sync between the local Python tool, different browsers, or different machines. Move data
between them manually via the Download/Load backup buttons — treat it the same way you'd think
about copying `consolidation.db` around today.

---

## 4. Current state of the data (as of this handover)

| Item | Value |
|------|-------|
| Periods loaded | **2026-05** (open), **2026-06** (open) |
| Ledgers categorized | 155 mapped, 1 immaterial unmapped (zero balance) |
| Fixed categories | 98 |
| Adjustments | 1 applied: `ADJ-2026-06-001` (KNS Travel Expense reclassification) |
| Audit log entries | 233+ |
| Validation status | **10/10 passing on both May and June**, in all three interfaces |
| Python automated tests | **57 passing** |

### June 2026 headline figures (verified identical across Python and web app)
| Line | Amount (IDR) |
|------|--------------|
| Total Sales | 299,656,250 |
| Net Income / (Loss) | (1,763,426,354) |
| Total Assets | 25,368,583,088 |
| Balance Sheet check | 0 (balances exactly) |

> ⚠️ **These numbers are still not final** — see §8. The stock/COGS movement adjustment (below)
> has still not been booked for any period.

---

## 5. How the web app was built and verified

The web app (`docs/`) is a complete from-scratch JavaScript rewrite of the Python engines —
not a wrapper, not a subset. Built in 8 phases (foundation → TB import → mapping → consolidation
→ adjustments → validation → statements → Excel export → dashboard/audit/deploy), each phase
checkpointed against the **real Python app running side-by-side on the same real production
data**, not synthetic test data.

Verification methods used, in increasing order of rigor as the stakes went up:
- TB parser: ran the actual Python parser against all 8 real fixture files, diffed every parsed
  line field-by-field against the JS output — 0 diffs after fixing one real bug (see §9).
- Consolidation engine: compared the JS-computed `consolidated_tb` (137 rows) against Python's
  own previously-computed output for the same period — 0 diffs.
- Statements (P&L/BS): compared full rendered page output line-by-line against the live Python
  app — byte-for-byte identical.
- Excel export: since no Excel/LibreOffice was available in the build environment to force a
  recalculation, built a small independent formula evaluator that actually resolves the
  cross-sheet formula chain (Entity sheets → Matrix → Total → PL/BS) to real numbers, and
  cross-checked against the already-verified statement engine and against Python's own
  CLI-generated Excel pack, cell-by-cell — 0 diffs (after fixing two real bugs, see §9).

Tech stack: `sql.js` (SQLite compiled to WebAssembly) for storage, `ExcelJS` for TB parsing and
the live-formula Excel export, vanilla JS + `lit-html` for the UI. No build step — the vendored
libraries are committed directly, so deploying is just pushing static files.

---

## 6. Deployment details

- **Source:** GitHub repo `main` branch, `/docs` folder → GitHub Pages
- **No GitHub Actions workflow needed** — GitHub's built-in "Deploy from a branch" Pages
  builder handles it automatically on every push to `main`
- **Git history note:** the GitHub repo had originally been seeded via GitHub's web "upload
  files" interface, creating a disconnected git history from the local repo. This was merged
  (`--allow-unrelated-histories`, content was byte-identical modulo line endings) rather than
  force-pushed, so no history was lost. If you ever see two unrelated root commits again,
  that's why — same fix applies.

---

## 7. Python code map

```
src/
├── cli.py                          Command-line interface
├── importers/                      TB parsing + column detection
├── db/                             Connection, migrations, seed, repositories
├── engines/
│   ├── consolidation_engine.py     Rolls TBs + adjustments into the consolidated TB
│   ├── adjustment_engine.py        JE validation, create, copy-prior-month
│   ├── statement_generator.py      Computes P&L and BS
│   └── validation_engine.py        All 10 validation checks
├── exporters/excel_pack_generator.py   The monthly Excel deliverable (formula-linked)
├── services/audit_service.py       Audit logging
└── web/                            FastAPI app (local dashboard)

docs/                                The web app (mirrors src/ structure, JS)
├── src/db/                          persistence.js (sql.js), repositories
├── src/engines/                     consolidation.js, adjustments.js, statements.js, validation.js
├── src/excel/                       tb-parser.js, column-detector.js, export-pack.js
└── src/pages/                       one file per page, same page set as the Python web UI
```

---

## 8. ⚠️ Open items — what still needs YOUR input

### 1. Stock / COGS movement — biggest gap, still not booked in any period
**This was discussed at length in the most recent session — read this carefully before booking it.**

Current state: `COGS before Direct Cost & Forex Gain/Loss` in the TB reflects **Purchases only**.
It does not net against inventory movement. The textbook formula is:

**COGS = Opening Stock + Purchases − Closing Stock**

Since Purchases is already in the TB, the adjustment needs to add Opening Stock and subtract
Closing Stock. You confirmed there is **no physical count involved** — you already have actual
Opening and Closing stock figures on hand (from your own records, not a count exercise). Net the
two into a single two-line adjustment:

**If Closing Stock > Opening Stock** (inventory built up):
| Category | Debit | Credit |
|---|---|---|
| Inventory | Closing − Opening | |
| COGS before Direct Cost & Forex Gain/Loss | | Closing − Opening |

**If Closing Stock < Opening Stock** (inventory drew down): reverse the two lines, same amount.

Enter as an `inventory_movement` adjustment, entity-specific (not group-level — stock sits with
a specific entity), then **Apply** and **Recalculate** on the Consolidated TB page. P&L and BS
both update automatically from there — no separate step needed.

**One caveat you should sanity-check:** this entry assumes the TB's *current* Inventory balance
already equals your **Opening Stock** actual (true if that ledger had zero period movement,
which is what causes this whole issue). If the TB's current Inventory balance and your actual
Opening Stock number don't match for some other reason, that's a separate discrepancy to resolve
first — otherwise it carries silently into the new Closing balance.

The magnitude previously estimated for June was ~785M IDR, but that number came from an earlier,
different framing (physical-count-vs-book) and should be re-derived from your actual Opening/
Closing figures using the formula above, not assumed to still be correct.

### 2. KDI "Other Income" → shareholder loan repayment
Should be reclassified as a loan repayment, not income; the offsetting BS account and direction
are still unclear. Needs your input.

### 3. Sample expenses distorting Sales and COGS
Amounts and target categories for reclassification still needed.

### 4. Opening balance break
An account with an incoming opening balance that's breaking the BS check — which account and the
correct figure are still needed.

### Also outstanding
- **IC elimination entries** — mechanism ready and tested (`ic_elimination` adjustment type,
  worked example in `README.md`); you decide which intercompany balances net against each other.

---

## 9. Notable bugs found and fixed (context worth keeping)

From the original Python build:
1. Locked periods weren't fully enforced across all 6 write paths — fixed centrally via
   `period_repo.require_open()`.
2. Relative database path resolved against process working directory, not project root — fixed.
3. Childless Tally group rows (a group with its own balance, no children) were silently dropped,
   losing real money — fixed with lookahead logic in the parser.
4. A mapping file row error misrouted ~26.5B IDR (Interco Balances → Other Payables) — corrected.

From building the web app port (both found via rigorous cross-checking against real data, both
**fixed in the Python tool too**, not just the port):
5. **Sort-order bug**: JS's `localeCompare()` sorts differently from Python's codepoint-based
   `sorted()` for mixed-case names (e.g. "AKUMULASI..." vs "Account..." flip order). Affected the
   Mapping page's row order in the web app only — not a Python bug, just something to watch for
   if this pattern is ever copied elsewhere.
6. **Entity+adjustment summing bug** (real bug, present in the Python tool too, now fixed in
   both): when an adjustment targets a specific entity+account that also has a base TB balance,
   both the Consolidated TB page and the Excel export's `Entity_<CODE>` sheets were showing
   *only* the adjustment's value, silently dropping the entity's base TB value, because both were
   combined with "last one wins" instead of summing. Fixed in `src/web/routes/statements.py` and
   `src/exporters/excel_pack_generator.py` (Python) and the equivalent web app files. **If you
   have any exported Excel packs generated before this fix that include an entity-specific
   adjustment, the affected entity's column will understate its true value** — the Total column
   was always correct, only the per-entity breakdown was wrong.

---

## 10. Risks

1. **Web app data has no backup by default** — same principle as `consolidation.db` always did:
   whichever browser you load data into is the only copy, until you click "Download backup".
2. **No physical stock count process** — by design, per your confirmation; Opening/Closing stock
   figures come from your own records, not a count. Worth a periodic sanity check against Tally's
   book balance regardless (see the caveat in §8.1).
3. **Single point of truth ambiguity**: with three interfaces now live (local web, CLI, hosted
   web app), make sure whichever one you actually work in each month has the *latest* data loaded
   before you start — there's no automatic sync between them.

---

## 11. Starting a fresh chat — what to say

Open a new chat **with `D:\Projects\Tally Consolidation Tool` as a working directory**, and say:

> Read `D:\Projects\Tally Consolidation Tool\HANDOVER.md` — that's the full context for this
> project. [then your request]

Good next steps to pick from:
- *"Here's the June Opening/Closing stock: [figures]. Enter the stock/COGS adjustment."*
- *"Build the MoM comparatives — May and June are both loaded."*
- *"Add [feature] to the web app the same way we built the rest of it."*
