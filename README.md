# Tally Consolidation Tool — Phase 1 + 2 + Web Dashboard

Local-first consolidation tool for 4 wholly-owned Indonesian subsidiaries (BII, KDI, KNS, VKS),
consolidating Tally trial balance Excel exports into a single group TB.

**Phase 1**: import Tally TB exports, categorize ledgers into a fixed set of P&L/Balance Sheet
categories, consolidate, and export an Excel pack — including a computed, single-period P&L and
Balance Sheet (`PL_Current` / `BS_Current`) generated directly from the Consolidated TB.

**Phase 2**: structured double-entry adjustments replacing manual TB edits, an audit trail, and
period locking.

**Web dashboard**: everything above is also available as a full interactive web app —
upload TB files, categorize ledgers, enter adjustments, lock periods — as an alternative to the
CLI + Excel round-trip. Both interfaces call the exact same underlying engine, so use whichever
you prefer; nothing is CLI-only or web-only. See "Web dashboard" below. YTD, prior-year and
month-by-month comparatives are built (Phase 8); IC-elimination auto-matching is not planned
(IC elimination is deliberately manual — see "Recurring adjustment patterns").

**Stock/COGS reconciliation and IC elimination are both handled as regular, user-entered
adjustments** — not automated. Neither can be computed from the Tally TB alone (stock movement
needs a physical count; IC elimination needs someone to decide which balances genuinely net
against each other), so the tool deliberately doesn't guess. See "Recurring adjustment patterns"
below for worked examples of both.

Every derived number in the pack is a live Excel formula, not a static value, so it's traceable
directly in Excel: `Entity_<CODE>` sheets (base data) -> `Conso_TB_Matrix`/`Conso_TB_Total`
(formula-reference the entity sheets) -> `PL_Current`/`BS_Current` (formula-reference
`Conso_TB_Total`, with BS `Retained Earnings` cross-referencing `PL_Current`'s Net Income
directly). Click any cell and trace it back to source.

## Setup

```bash
pip install -r requirements.txt
```

## CLI usage

```bash
# 1. Import a period's TB exports (run once per entity, or point at a folder)
python -m src.cli import-tb --entity BII --period 2026-06 "tests/fixtures/TB BII Jun 26.xlsx"
python -m src.cli import-tb --entity KDI --period 2026-06 "tests/fixtures/TB KDI V4.xlsx"
python -m src.cli import-tb --entity KNS --period 2026-06 "tests/fixtures/TB KNS V3.xlsx"
python -m src.cli import-tb --entity VKS --period 2026-06 "tests/fixtures/TB VKS June 26.xlsx"

# 2. Export the mapping workbook, categorize ledgers in Excel, then re-import
python -m src.cli export-mapping --period 2026-06 --out Mapping.xlsx
#   ... edit Mapping.xlsx: fill in the Category column for each ledger ...
python -m src.cli import-mapping --in Mapping.xlsx

# 3. Adjustments — export, edit as a JE-style grid, re-import as drafts, then apply
python -m src.cli export-adjustments --period 2026-06 --out Adjustments.xlsx
#   ... edit Adjustments.xlsx: rows sharing an "Adjustment Ref" form one balanced JE ...
python -m src.cli import-adjustments --period 2026-06 --in Adjustments.xlsx
python -m src.cli apply-adjustments --period 2026-06

#    Copy last month's adjustments forward as new drafts instead of re-typing them:
python -m src.cli copy-adjustments --period 2026-07

# 4. Consolidate and export the Excel pack (Conso_TB, PL_Current, BS_Current, Adjustments,
#    Adj_Bridge, Mapping, Validation, Audit_Log)
python -m src.cli consolidate --period 2026-06
python -m src.cli export-pack --period 2026-06 --out "Consolidated Pack 2026-06.xlsx"

# 5. Lock a period once all Error-severity validations pass. Comparatives do NOT require a
#    locked period — they warn about open months rather than refusing to show them (V22).
python -m src.cli lock-period --period 2026-06
python -m src.cli unlock-period --period 2026-06   # admin override, logged
```

Re-running `export-mapping` / `import-mapping` / `consolidate` / `export-pack` after changing
categorization or adjustments always regenerates output from the latest state — nothing is
cached stale.

## Web dashboard

```bash
python -m src.web
```

Starts a local server at `http://127.0.0.1:8420` and opens it in your browser. Run this when
you want to work; there's nothing to keep running otherwise — close the terminal window (or
Ctrl+C) when you're done, and start it again next time. No login, no setup — it reads and writes
the same `data/consolidation.db` the CLI uses, so you can freely switch between the two.

Pages: **Dashboard** (period picker, KPIs, validation status, lock/unlock) · **Import TB**
(upload per entity) · **Mapping** (categorize ledgers with a dropdown per row) · **Adjustments**
(list with apply/delete/copy-from-prior-period, and an entry form with dynamic JE lines) ·
**Consolidated TB** (entity-columns matrix with a Recalculate button) · **P&L** / **BS** ·
**Validation** · **Audit Log**. A "Download Excel Pack" button on the dashboard still produces
the familiar `Consolidated Pack {period}.xlsx` for anyone who wants that deliverable.

## Recurring adjustment patterns

Both of these are entered exactly like any other adjustment — `export-adjustments` -> edit the
grid -> `import-adjustments` -> `apply-adjustments` — there is no separate workflow or automation
for either. The tool provides the mechanism (balanced entry, audit trail, bridge report); the
finance team supplies the judgment.

**Stock/COGS reconciliation** (type `inventory_movement`): each month, compare the physical
stock count against what's showing in the entity's `Inventory` category, and book the difference.
If the actual closing stock is higher than Tally shows (meaning COGS is currently overstated,
as it was for KNS in June 2026 — see the RCA in this project's history), the entry increases
Inventory and reduces COGS by the same amount:

| Adjustment Ref | Type | Entity | Category | Debit | Credit |
|---|---|---|---|---|---|
| ADJ-2026-06-STOCK | inventory_movement | KNS | Inventory | 785,516,754 | |
| ADJ-2026-06-STOCK | inventory_movement | KNS | COGS before Direct Cost & Forex Gain/Loss | | 785,516,754 |

**IC elimination** (type `ic_elimination`): once you've determined two entities' intercompany
balances genuinely net against each other, eliminate them with one entry — same category
(`Interco Balances`), opposite entities, opposite sides:

| Adjustment Ref | Type | Entity | Category | Debit | Credit |
|---|---|---|---|---|---|
| ADJ-2026-06-IC-01 | ic_elimination | KDI | Interco Balances | 18,084,500 | |
| ADJ-2026-06-IC-01 | ic_elimination | BII | Interco Balances | | 18,084,500 |

This nets to zero in `Conso_TB_Total`'s Interco Balances line while each entity's own column
still shows the adjustment individually, traceable via `Adj_Bridge`.

## Python / browser parity check

The tool is two implementations of the same logic — `src/` in Python and `docs/src/` in
JavaScript — kept identical by hand. There is no JavaScript test runner and no Node here, so
nothing else catches them drifting apart. That has already happened once in production: a
mapping fix shipped to Python and silently not to the browser app.

Run this after any engine or exporter change:

```bash
python scripts/parity_snapshot.py "data/consolidation.db"
# then serve docs/ and open /parity.html
```

The script records what every Python engine produced; the page runs the JavaScript engines over
the same database and compares statements, buckets, comparatives, the monthly matrix,
validations, the RE check, and every cell of the Excel pack's statement sheets. Pack formulas
are compared as text, not as evaluated numbers, because two workbooks can agree on today's
figures while referencing different cells.

`docs/_parity/` holds the snapshot and a copy of the database. It is gitignored — a real
consolidation database is client financial data.


## Project layout

See `config/group_coa_fixed.json` for the fixed P&L/Balance Sheet category list ledgers are
categorized into, and the plan this was built from at
`~/.claude/plans/fancy-hatching-floyd.md` (Phase 1 of the full
`Tally_Consolidation_Tool_Plan.pdf`).

Real TB fixtures for two periods (May and June 2026, all 4 entities) live in `tests/fixtures/`
and are used both by the test suite and as realistic sample data.
