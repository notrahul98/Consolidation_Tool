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

Two interfaces exist, both driving the *exact same* engine code:
- **Web dashboard** (`python -m src.web`) — click-through UI, the primary way to work
- **CLI** (`python -m src.cli ...`) — same operations from the command line

Python + SQLite, runs entirely on your machine. Nothing is hosted or sent anywhere.

---

## 2. Where everything is on your PC

### The project (all code + data)
```
D:\Projects\Tally Consolidation Tool
```

| Path | What it is |
|------|-----------|
| `data\consolidation.db` | **⚠️ THE SINGLE MOST IMPORTANT FILE.** SQLite database holding all imported TBs, every ledger categorization, all adjustments, and the full audit log. If this is lost, all categorization work is lost. |
| `src\` | All source code (see §6 for the map) |
| `config\group_coa_fixed.json` | Your fixed 98-row P&L/Balance Sheet category list |
| `config\app_settings.json` | Entity codes/names, DB path, tolerance |
| `tests\` | 57 automated tests |
| `tests\fixtures\` | Copies of all 8 real TB files, used by the tests |
| `README.md` | User-facing guide + worked adjustment examples |
| `HANDOVER.md` | This file |

### Your source data files (inputs you provided)
| Path | What it is |
|------|-----------|
| `D:\Projects\Tally Consolidation Tool\TB BII Jun 26.xlsx` | June TB — BII |
| `...\TB KDI V4.xlsx` | June TB — KDI |
| `...\TB KNS V3.xlsx` | June TB — KNS |
| `...\TB VKS June 26.xlsx` | June TB — VKS |
| `...\May TB\TB Bahan May 26 MTD.xlsx` | May TB — BII |
| `...\May TB\TB KDI May 26 MTD.xlsx` | May TB — KDI |
| `...\May TB\TB KNS May 26 MTD V2.xlsx` | May TB — KNS |
| `...\May TB\TB VKS May 26 MTD V2.xlsx` | May TB — VKS |
| `...\Kreasi Financials FY June 2026 Draft V2.xlsx` | Your existing manual June workbook — **the reference template** the P&L/BS layout was copied from |
| `...\May TB\Kreasi Financials FY May 2026 Final.xlsx` | Your existing manual May workbook |
| `...\Mapping from File.xlsx` | The categorization mapping you supplied |

### Generated outputs
| Path | What it is |
|------|-----------|
| `...\Consolidated Pack 2026-06.xlsx` | The monthly deliverable (11 sheets, fully formula-linked) |
| `...\Mapping.xlsx` | Ledger categorization round-trip workbook |
| `...\Adjustments.xlsx` | Adjustments JE-grid round-trip workbook |

### Files outside the project folder
| Path | What it is |
|------|-----------|
| `C:\Users\Finance-MGR\Documents\Tally_Consolidation_Tool_Plan.pdf` | The original 13-page implementation plan this was built from |
| `C:\Users\Finance-MGR\.claude\plans\fancy-hatching-floyd.md` | Detailed Phase 1 plan + real-data findings |
| `C:\Users\Finance-MGR\.claude\plans\wild-roaming-beaver.md` | Web dashboard plan |
| `C:\Users\Finance-MGR\.claude\projects\C--Users-Finance-MGR-Downloads-Stock-Data-Vault-Stock-Data-Vault---Phase-2\memory\` | Saved project memory + lessons learned |
| `C:\Users\Finance-MGR\Downloads\Stock-Data-Vault\Stock-Data-Vault - Phase 2\.claude\launch.json` | Browser-preview config (entry named `tally-web`) |

---

## 3. How to run it

```bash
cd "D:\Projects\Tally Consolidation Tool"
pip install -r requirements.txt          # first time only
python -m src.web                        # starts dashboard, opens browser at 127.0.0.1:8420
```

Stop it with `Ctrl+C` when you're done. It only runs while you want it to.

Full CLI reference is in `README.md`. Available commands:
`import-tb`, `export-mapping`, `import-mapping`, `consolidate`, `export-pack`,
`export-adjustments`, `import-adjustments`, `apply-adjustments`, `copy-adjustments`,
`delete-adjustment`, `lock-period`, `unlock-period`.

---

## 4. Current state of the data (as of this handover)

| Item | Value |
|------|-------|
| Periods loaded | **2026-05** (open), **2026-06** (open) |
| TB imports | 8 (4 entities × 2 months) |
| TB ledger lines | 277 |
| Ledgers categorized | 155 mapped, 1 unmapped (`Porto Valas Pt (Sunrise)`, VKS, zero balance — harmless) |
| Fixed categories | 98 |
| Adjustments | 1 applied: `ADJ-2026-06-001` |
| Audit log entries | 233 |
| Validation status | **10/10 passing on both May and June** |
| Automated tests | **57 passing** |

### June 2026 headline figures currently produced
| Line | Amount (IDR) |
|------|--------------|
| Total Sales | 299,656,250 |
| Net Income / (Loss) | (1,763,426,354) |
| Total Assets | 25,368,583,088 |
| Balance Sheet check | 0 (balances exactly) |

> ⚠️ **These numbers are NOT final** — see §7. Four known adjustments are still missing,
> the largest worth ~785M IDR.

---

## 5. What's been built (phase by phase)

### Phase 1 — Foundation ✅
- Tally TB Excel parser. **Key discovery:** Dr/Cr is not in the cell value — it's baked into
  each cell's Excel *number format string* (`""#,000" Dr"`). It must be read per-cell, because
  a single ledger can be Dr on Opening and Cr on Closing (real case: KNS `Hutang Pajak`).
- Ledger categorization into your fixed 98-category list, via Excel round-trip or the web UI.
- Consolidation engine (entity columns + total, matching your `TB Consol` layout).
- P&L and Balance Sheet generator, structurally matched to your real template.
- Excel pack export where **every derived number is a live Excel formula**, so you can click any
  cell and trace it back: `Entity_<CODE>` → `Conso_TB_Matrix`/`Conso_TB_Total` →
  `PL_Current`/`BS_Current`.

### Phase 2 — Adjustments & Audit Trail ✅
- Structured double-entry journal adjustments (must balance, need narration, min 2 lines).
- Copy-prior-month workflow.
- Full audit log (who/when/old value/new value).
- Period locking.
- Validation checks V1, V2, V3/V12, V5, V6, V7, V8, V9, V14, V18.

### Phase 3 — IC Elimination ✅ (scope deliberately changed)
Per your instruction *"it should be the end user who would determine it"*, **no automated
matching engine was built.** IC elimination and stock/COGS reconciliation are both entered as
ordinary adjustments (types `ic_elimination` and `inventory_movement`). Worked examples are in
`README.md` under "Recurring adjustment patterns". This supersedes the original plan's Phase 3.

### Web Dashboard ✅
FastAPI + Jinja2, server-rendered. Pages: Dashboard, Import TB, Mapping, Adjustments (list + JE
entry form), Consolidated TB, P&L, BS, Validation, Audit Log, plus Excel pack download.

---

## 6. Code map

```
src/
├── cli.py                          Command-line interface
├── importers/
│   ├── tally_tb_parser.py          Parses Tally TB (incl. the Dr/Cr number-format trick)
│   └── column_detector.py          Locates header columns dynamically
├── db/
│   ├── database.py                 Connection + migration runner
│   ├── seed.py                     Loads entities + fixed categories
│   ├── migrations/                 001_init, 002_adjustments, 003_inventory_movement_type
│   └── repositories/               Data access: entity, group_coa, mapping, period, tb,
│                                   adjustment, consolidated
├── engines/
│   ├── consolidation_engine.py     Rolls TBs + adjustments into the consolidated TB
│   ├── adjustment_engine.py        JE validation, create, copy-prior-month
│   ├── statement_generator.py      Computes P&L and BS
│   └── validation_engine.py        All 10 validation checks
├── exporters/
│   ├── excel_pack_generator.py     The monthly Excel deliverable (formula-linked)
│   ├── mapping_workbook.py         Mapping.xlsx round-trip
│   └── adjustment_workbook.py      Adjustments.xlsx round-trip
├── services/audit_service.py       Audit logging
└── web/                            FastAPI app: app.py, deps.py, routes/, templates/, static/
```

---

## 7. ⚠️ Open items — what still needs YOUR input

These are the reason the June numbers aren't final. All four are **blocked on information only
you have** — they were deliberately not guessed at.

### 1. Stock / COGS movement — biggest gap (~785,516,754 IDR)
Your Tally `Opening Stock` ledger shows **zero movement** in June (opening = closing), so COGS
is currently overstated by roughly 785.5M. Real COGS needs your **physical stock count**, which
doesn't exist anywhere in the Tally data. Your own `Closing Stock and COGS` workpaper was only
updated through May, not June.
**What's needed:** June's actual closing stock figure per entity.
**How to enter it:** as an `inventory_movement` adjustment — example in `README.md`.

### 2. KDI "Other Income" → shareholder loan repayment
Your notes say this should be a loan repayment, not income, and was never booked in Tally. The
ledger is identified (KDI `Other Income`, 12,396 IDR) but **which balance-sheet account it should
offset against, and in which direction, is unclear.**
**What's needed:** the offsetting account and direction.

### 3. Sample expenses distorting Sales and COGS
Your notes say sample expenses should be removed from both Sales and COGS.
**What's needed:** the amounts to reclassify and the target categories.

### 4. Opening balance break
Your notes mention *"Opening has a balance coming in which is breaking BS"*.
**What's needed:** which account, and the correct opening figure.

### Also outstanding
- **IC elimination entries** — mechanism is ready and tested; you decide which intercompany
  balances net against each other, then enter them as `ic_elimination` adjustments.
- **"Net Profit without interest on shareholder loan"** appeared **twice** in the P&L category
  list you supplied. Currently treated as one line. Confirm whether the second was meant to be
  something different.

---

## 8. ⚠️ Risks you should address

1. **No backups.** `data\consolidation.db` holds every hour of categorization work and has no
   copy anywhere. Copy it somewhere safe regularly. Losing it means re-categorizing 155 ledgers.
2. **No version control.** The project is **not** a git repository. There's no history and no undo
   beyond the audit log. Running `git init` and committing would fix this.
3. **Single-machine.** The database is local to this PC. If your team needs shared access, point
   `database_path` in `config\app_settings.json` at a shared network folder.

---

## 9. Not built yet

- **Comparatives** (MoM / YTD / YoY / quarterly) on the P&L and BS. MoM is buildable now (May and
  June are both loaded). YTD needs Jan–Jun TB files; YoY needs June 2025.
- Budget vs actual, Tally ODBC auto-import, multi-currency, PDF export.

---

## 10. Notable bugs found and fixed (context worth keeping)

These were real defects caught by testing, not by reading code — useful history if similar
symptoms reappear:

1. **Locked periods weren't actually locked.** Only "create new adjustment" checked lock status.
   TB import, mapping edits, consolidate, apply-adjustments and delete-adjustment all silently
   succeeded on a locked period; the disabled delete button was cosmetic only. Now enforced
   centrally via `period_repo.require_open()` across all six write paths, with regression tests.
2. **Relative database path.** `database_path` resolved against the *process's* working
   directory, so launching from elsewhere silently created a **new empty database** in the wrong
   folder. Now resolved against the project root in both CLI and web.
3. **Childless Tally group rows were dropped.** A group row carrying its own balance with no
   child ledgers (`Unadjusted Forex Gain/Loss` in May's KNS file) was skipped, losing 12.5M.
4. **Interco mapping error.** Row 26 of `Mapping from File.xlsx` mapped "Interco Balances" →
   "Other Payables", misrouting ~26.5B IDR. Corrected to `Interco Balances`, which then matched
   your real Balance Sheet figure of 105,005,405 almost exactly.
5. **Lock badge missing on most pages.** Now injected centrally for every period-scoped page.

---

## 11. Starting a fresh chat — what to say

Open a new chat **with `D:\Projects\Tally Consolidation Tool` as a working directory**, and say:

> Read `D:\Projects\Tally Consolidation Tool\HANDOVER.md` — that's the full context for this
> project. [then your request]

Good next steps to pick from:
- *"Here's the June closing stock: [figures]. Enter the stock/COGS adjustment."*
- *"Set up git for this project and make an initial commit."*
- *"Build the MoM comparatives — May and June are both loaded."*
- *"Set up a backup routine for the database."*

**Note on saved memory:** notes about this project were stored under the *Stock-Data-Vault*
working directory, not this one. A new chat opened only in `D:\Projects\Tally Consolidation Tool`
won't auto-load them — which is exactly why this HANDOVER.md exists and is self-contained.
