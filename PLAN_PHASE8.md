# Phase 8 — YTD comparatives, UI refresh, Tally connector

**Status:** specification, not yet built.
**Prerequisite reading:** `PROGRESS_REPORT.md` (current state as of 15 Sep 2026), then this file.
**Build order:** Python engine + tests first, browser port second, UI refresh in parallel with
port, Tally connector last. Manual TB upload remains available permanently even after Tally is
connected.

**Decisions locked (15 Sep 2026):**

| Topic | Decision |
|---|---|
| Primary interface | Browser app (GitHub Pages); Python CLI/web for dev and connector |
| Financial year | Calendar Jan–Dec |
| P&L movement | Sum monthly imports (Tally exports are period movement, not YTD) |
| BS comparatives | Closing position at each month-end (not summed) |
| Locked periods | Warn on open periods; do not block comparatives |
| Missing months in range | Warn and sum partial data |
| YTD scope | All surfaces: P&L/BS screens, Excel pack, Consolidated TB monthly view, dashboard KPIs, full monthly matrix |
| Excel layout | Match `Kreasi Financials FY Aug 2026.xlsx` sheets `P&L` and `BS` |
| % columns | Keep % of Net Sales after **every** P&L amount column (match template) |
| UI | Browser only; all page recommendations in §5 approved |
| Tally | TallyPrime, 4 companies in one install on `\\serverlt1\tallydata`; connector service on server; IT approval required; manual upload never removed |
| Deadline | September 2026 close — ship full scope (not a reduced MVP) |

---

## 0. Scope

Three workstreams, in build order:

| # | Item | Type |
|---|------|------|
| 1 | YTD / prior-year / monthly-matrix comparatives | Feature (engine + screens + Excel) |
| 2 | Browser UI refresh | UX / cosmetic |
| 3 | Tally connector (server service + browser refresh button) | Integration |

**Also do early (from PROGRESS_REPORT §12, before or alongside Phase 8.1):**

- Guard `Mapping.xlsx` import against flattening per-entity splits (plan §1.3 carry-over).
- JS parity test harness (structural fix for Python/browser drift).

**Explicitly retained after Phase 8:**

- Manual TB file upload on Import TB page (per entity or bulk).
- Download / Load backup workflow unchanged.

---

## 1. Workstream 1 — YTD and comparatives

### 1.1 Reference layout (source of truth)

File: `D:\KNS Group\Monthly Tasks\2026\8. Aug\Financials\Kreasi Financials FY Aug 2026.xlsx`

**P&L (`P&L` sheet, row 4)** — for selected month *M* (e.g. August):

```
| Particulars | YTD M'YY | % | YTD M'(YY-1) | % |
| Jan'YY | % | Jan'(YY-1) | % | Feb'YY | % | Feb'(YY-1) | % | … through Dec |
```

- YTD current = sum of monthly P&L movements Jan→*M* in year *YY*.
- YTD prior = sum Jan→*M* in year *YY−1*.
- Each month column = that month's movement only (from consolidated TB for that period).
- Prior-year month column = same calendar month in prior year.
- Months after *M* in the current year: show empty/greyed in on-screen view; Excel may omit
  or leave blank (match template behaviour for future months).
- Budget column (E in template): **out of scope** unless requested later.

**BS (`BS` sheet, row 5)** — no YTD columns:

```
| Line | Schedule | Jan'YY | Jan'(YY-1) | Feb'YY | Feb'(YY-1) | … through Dec |
```

- Each column = closing BS position at that month-end (from consolidated TB `total` rows).
- Schedule reference column: optional in v1; add if time allows.

**Net income summary row (P&L rows 2–3 in template):** replicate check formulas that derive
monthly net income from subtotal lines (Sales − discounts − … − tax). The tool already
computes net income via `compute_pl`; comparative engine must expose the same for each column.

### 1.2 Period resolution

Add `config/fiscal.json` (or extend `group_coa_fixed.json` metadata):

```json
{
  "fiscal_year_start_month": 1,
  "fiscal_year_end_month": 12
}
```

New module `src/engines/comparative_engine.py` (port to `docs/src/engines/comparative.js`):

```python
def resolve_comparative_periods(conn, period_id: int) -> ComparativeContext:
    """Given e.g. 2026-08, return:
    - anchor: (2026, 8)
    - ytd_range_current: [(2026,1)..(2026,8)]
    - ytd_range_prior: [(2025,1)..(2025,8)]
    - month_pairs: [((2026,m),(2025,m)) for m in 1..12]
    - missing: list of (year, month) with no imported+consolidated period
    - open_in_range: list of period_ids not locked
    """

def compute_pl_comparative(conn, period_id: int) -> PlComparativeResult:
    """Returns line structure matching compute_pl, with values per column key:
    'ytd_current', 'ytd_prior', '2026-01', '2025-01', … and percent keys parallel to amounts.
    """

def compute_bs_comparative(conn, period_id: int) -> BsComparativeResult:
    """Returns line structure matching compute_bs, with values per column key:
    '2026-01', '2025-01', … (closing positions).
    """
```

**Aggregation rules:**

1. **P&L leaf lines:** for each month in range, call existing `compute_pl(conn, that_period_id)`
   and take the leaf value. YTD = sum of monthly leaf values Jan→anchor (not sum of subtotals).
2. **P&L subtotals:** recompute from aggregated leaf inputs using the **same explicit formulas**
   as `statement_generator.py` (Net Sales = Total Sales − Discount, etc.). Never sum subtotal
   rows across months.
3. **P&L %:** each amount column / that column's Net Sales subtotal (guard divide-by-zero).
4. **BS leaf lines:** `compute_bs` closing value for that month-end period_id.
5. **BS subtotals:** recompute from leaf closings same as single-period engine.
6. **Missing period:** value = None; include in `missing` list; UI shows "—" and warning banner.
7. **Open period in range:** include in calculations but set `open_in_range` for warning banner.

**Prerequisite data:** each month in the comparative range must be imported, categorized,
adjusted (as needed), and **consolidated**. Engine reads `consolidated_tb` only — not raw TB.

### 1.3 Repository helpers

`src/db/repositories/period_repo.py` — add:

```python
def list_in_range(conn, year: int, month_from: int, month_to: int) -> list[dict]
def get_by_year_month(conn, year: int, month: int) -> dict | None
def comparative_readiness(conn, period_ids: list[int]) -> dict  # missing, open, stale
```

### 1.4 Screens (browser — primary)

**P&L (`docs/src/pages/statement.js` or new `pl-comparative.js`):**

- Title: `Profit and Loss — period ended {last day of anchor month}`.
- Frozen column: Line Item.
- Pinned columns after label: YTD current, %, YTD prior, %.
- Horizontal scroll: monthly pairs Jan→Dec (current year | prior year | % | % each).
- Warning banners: missing months, open periods, partial YTD.
- Route: keep `/pl`; replace single-column view with comparative view (toggle "Simple" optional
  if needed for debugging — default comparative).

**BS (`docs/src/pages/statement.js`):**

- Same pattern without % columns and without YTD pinned columns.
- Monthly pairs only.

**Dashboard (`docs/src/pages/dashboard.js`):**

- KPI cards: Net Sales, Gross Profit, Net Income, BS Check.
- Each card: Current month | YTD current | YTD prior | YoY % (YTD current vs YTD prior).

**Consolidated TB (`docs/src/pages/consolidated-tb.js`):**

- New view toggle: **Single period** (current) | **Monthly matrix**.
- Matrix: rows = group accounts; columns = Jan…anchor month totals (entity + adj + total via
  `getBuckets` per period). Lower priority than P&L/BS but in scope for Sep close.

### 1.5 Excel pack

Extend `src/exporters/excel_pack_generator.py` and `docs/src/excel/export-pack.js`:

| Sheet | Purpose |
|---|---|
| `PL_Comparative` | Mirror template column layout; formulas reference per-period `Conso_TB_Total` columns or dedicated period columns |
| `BS_Comparative` | Mirror template paired month columns |
| `Conso_TB_By_Period` | Optional helper sheet: one column block per month for formula traceability |

Formula chain must remain traceable (no cached values). Extend `tests/test_excel_pack.py`:

- Multi-period fixture: at least Jan–Aug 2026 + Jan–Aug 2025 (synthetic or anonymized).
- Evaluate full formula chain for every comparative column.
- Seven existing group-level adjustment tests must still pass.

### 1.6 Python web + CLI (secondary but required for parity)

- `src/web/routes/statements.py` — comparative tables.
- `src/web/templates/statement.html` — scrollable matrix.
- CLI: `python -m src.cli show-pl --period 2026-08 --comparative` (optional flag).

### 1.7 Validations

New warning (not error):

- **V21:** Comparative range incomplete — lists missing months.
- **V22:** Comparative range contains open (unlocked) periods.

Neither blocks locking (consistent with user decision).

### 1.8 Tests

| File | Guards |
|---|---|
| `tests/test_comparative_engine.py` | YTD sums, subtotal formulas, BS point-in-time, missing month handling |
| `tests/test_excel_pack.py` | Extended comparative sheets |
| `tests/test_re_check.py` | Unaffected |
| `docs/` parity | JS harness compares `computePlComparative` to Python on fixtures |

---

## 2. Workstream 2 — Browser UI refresh

All recommendations approved 15 Sep 2026. Browser only (`docs/`). Python web templates are
**not** in scope unless time remains.

### 2.1 Global

- Widen statement pages to `max-width: 1400px`.
- Shared page header partial: title + subtitle + right-aligned action buttons.
- Compact table density default on Mapping and Consolidated TB.
- Loading state on Consolidate, Export, Import (spinner + disabled button).

### 2.2 Navigation (`docs/src/layout.js`, `docs/assets/style.css`)

Replace flat 11-link nav with grouped dropdowns:

```
Dashboard | Data ▾ | Work ▾ | Reports ▾ | System ▾ | [period badge]
```

| Group | Items |
|---|---|
| Data | Import TB |
| Work | Mapping, Stock, Adjustments |
| Reports | P&L, BS, Consolidated TB, Retained Earnings |
| System | Validation, Audit Log |

Backup / Load backup stay in topbar right.

### 2.3 Page changes

| Page | Changes |
|---|---|
| Dashboard | Period dropdown; status strip (4/4 TB, consolidated?, validations); KPI row with comparatives; action panel; workflow checklist |
| Import TB | 4-row entity status table; per-row upload + bulk upload; post-import summary; placeholder Tally refresh row (disabled until §3); re-import warning |
| Mapping | Sticky ledger column; split parent/child styling; save toast; filters (Unmapped / Split / Search) |
| Stock | Entity tabs; override indicators; V19 footer link |
| Adjustments | Compact list with filters; two-column form; 3-step edit callout |
| Consolidated TB | Sticky header + label column; group-adj expand/collapse |
| P&L / BS | Comparative matrix layout (§1.4) |
| Retained Earnings | Copy gap button; collapsible linked adjustments |
| Validation | Filter pills; group by rule; link to fix page |
| Audit Log | Filter by action/date/period; expandable JSON diff |

---

## 3. Workstream 3 — Tally connector

### 3.1 Environment

| Item | Value |
|---|---|
| Server data path | `\\serverlt1\tallydata` |
| Product | TallyPrime |
| HTTP/XML port | 9000 (to be enabled with IT) |
| Connector host | Same server as Tally (preferred) |
| User network | Always on same network as server (no VPN dependency for daily use) |

### 3.2 Company mapping (confirmed)

| Code | Tally company name | Folder # |
|---|---|---|
| BII | PT BAHAN INDONESIA INDAH | 010012 |
| KDI | PT KLASIK DISTRIBUSI INDONESIA 2021-2022 | 020018 |
| KNS | PT. Kreasi Nusantara Sejati 2020 - 2022 | 020013 |
| VKS | VKS Co-Batik & Non Batik 2022 | 020014 |

Store in `config/tally_companies.json`. Configurable without code change.

### 3.3 Architecture

```
TallyPrime (:9000) on serverlt1
        ↑ XML request/response
tally_connector/  (Python service, Windows Service or scheduled task)
  - POST /pull  { period: "2026-09", entities: ["BII","KDI","KNS","VKS"] }
  - Returns parsed TB lines per entity (same shape as tb-parser output)
        ↑ HTTP (internal network only)
Browser app  OR  CLI  OR  manual upload
```

**Pull flow (all four entities, user picks period):**

1. User clicks **Refresh from Tally** on Import TB (or selects period + Refresh all).
2. Browser calls connector internal URL (configurable in `docs/src/config.js` or settings UI).
3. Connector switches Tally company, exports Trial Balance for period end date, parses to
   `{ lines: [...], warnings: [...] }`.
4. Browser runs existing `tbRepo.importTb` for each entity (same as manual upload).
5. Auto-run consolidate for that period.
6. Show combined summary + warnings:
   - mapping stale / new ledgers needing categorization
   - adjustments changed since last consolidation (if applicable)
   - validation failures

**Manual upload remains** on the same page — never removed or hidden behind Tally.

### 3.4 New files

| Path | Purpose |
|---|---|
| `src/tally/` | XML client, TB export request builder, response parser |
| `src/tally/connector_server.py` | FastAPI/Flask minimal HTTP service for server install |
| `scripts/run_tally_connector.py` | Dev entry point |
| `tests/test_tally_parser.py` | Parser against captured XML fixtures |
| `docs/src/services/tally-client.js` | Browser fetch wrapper |
| `docs/src/pages/import-tb.js` | Refresh button + fallback to manual |

### 3.5 CLI (always available alongside browser)

```bash
python -m src.cli pull-tally --period 2026-09 --entity KDI
python -m src.cli pull-tally --period 2026-09 --all
python -m src.cli import-tb ...   # unchanged manual path
```

### 3.6 IT approval checklist

- [ ] Enable TallyPrime as server (port 9000) on serverlt1
- [ ] Install Python 3.11+ on server
- [ ] Install connector as Windows Service (`tally-connector`)
- [ ] Internal firewall: allow workstation → server on connector port (e.g. 8765)
- [ ] Document connector URL for browser config
- [ ] Read-only: connector only exports TB; no write access to Tally data

### 3.7 Spike (do first in workstream 3)

1. Capture one XML TB export response per entity for one month.
2. Diff parsed output against existing Excel import for same entity/month.
3. Confirm column mapping matches `src/importers/tb_parser.py` / `docs/src/excel/tb-parser.js`.

---

## 4. Phasing and milestones (September 2026 close)

Full scope for Sep close — not a reduced MVP.

| Milestone | Deliverable | Est. |
|---|---|---|
| **8.0** | Mapping import guard + start JS parity harness | 2–3 days |
| **8.1a** | `comparative_engine.py` + unit tests | 4–5 days |
| **8.1b** | Excel `PL_Comparative` / `BS_Comparative` + pack tests | 3–4 days |
| **8.1c** | Browser comparative engine port + P&L/BS screens | 4–5 days |
| **8.1d** | Dashboard KPIs + Consolidated TB matrix + V21/V22 | 3–4 days |
| **8.2** | UI refresh (nav, dashboard, import table, global styles) | 4–5 days |
| **8.2b** | UI refresh (mapping, stock, adjustments, validation, audit) | 3–4 days |
| **8.3** | Tally spike + connector service + CLI pull | 5–7 days |
| **8.3b** | Browser Refresh from Tally + IT deployment | 3–5 days (after IT approval) |
| **8.4** | Sep 2026 live run: import/pull → adjust → consolidate → export pack | 1–2 days |

**Parallel tracks:**

- 8.1a–8.1b Python can start immediately.
- 8.2 nav + dashboard can overlap 8.1c.
- 8.3 spike can start early; production deploy waits on IT.
- Sep close export can use **manual TB upload** while 8.3b is pending; connector must not
  block close.

**Sep close acceptance criteria:**

- [ ] All months Jan–Sep 2026 (and Jan–Sep 2025 for prior columns) imported and consolidated
- [ ] P&L screen shows YTD Sep'26, YTD Sep'25, and monthly matrix Jan–Sep with % columns
- [ ] BS screen shows paired columns Jan–Sep 2026 vs 2025
- [ ] Excel pack comparative sheets match on-screen figures (zero diff vs engine)
- [ ] Dashboard KPIs show month + YTD + prior YTD
- [ ] UI nav groups and page refresh shipped
- [ ] Manual TB upload still works
- [ ] Tally connector: spike complete; production optional for close if IT not ready

---

## 5. Traps (carry forward from PROGRESS_REPORT §11)

1. **`entity_id IS NULL`** — always use `get_buckets` / `getBuckets` for consolidated rows.
2. **Two codebases** — every engine change in `src/engines/` needs a port in `docs/src/engines/`.
3. **P&L subtotals** — never sum subtotal rows across months; recompute from leaves.
4. **BS comparatives** — closing position only; never sum BS across months.
5. **Excel pack** — evaluate formulas in tests; openpyxl reads `None` for formula cells.
6. **Push to `github` remote**, not obsolete `origin` mirror.
7. **Browser module cache** — test UI on fresh origin (`127.0.0.1`) when verifying deploy.
8. **Manual path** — Tally connector is additive; do not remove upload UI or backup workflow.

---

## 6. Open items unchanged (finance, not Phase 8 code)

From `PROGRESS_REPORT.md` §10 — still need finance decisions:

- Purchase ledger mapping for BII, KDI, VKS (COGS/stock)
- Retained Earnings roll-forward rule (V20 remains diagnostic until decided)
- August BS Check 1 rupiah rounding
- Intercompany eliminations, sample expenses, opening balance break (from HANDOVER)

Phase 8 does not resolve these; comparative columns will reflect whatever adjustments exist.

---

## 7. Document maintenance

After Phase 8 ships:

- Update `PROGRESS_REPORT.md` with Phase 8 delivery notes.
- Merge or replace stale `HANDOVER.md` sections with this plan's outcomes.
- Update `README.md` comparative section (currently says MoM/YTD/YoY not built).
