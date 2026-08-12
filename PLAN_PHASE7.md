# Phase 7 — Stock/COGS, Retained Earnings check, editable adjustments, per-entity mapping

**Status:** specification, not yet built.
**Prerequisite reading:** `HANDOVER.md` (project context), then this file.
**Build order:** Python first (§8 phasing), verified against real data, then port to `docs/` (JS), then push to GitHub.

This document is written so someone with basic Python/JS skill can implement it without
having been in the design conversation. Every table, function signature, file path, and
test is named explicitly.

---

## 0. Scope

Five workstreams, in build order:

| # | Item | Type |
|---|------|------|
| A | Per-entity ledger mapping (fixes interest-on-shareholder-loan) | **Bug fix — do first** |
| B | Stock / COGS screen + generated adjustment | Feature |
| C | Retained Earnings movement check + screen | Feature |
| D | Edit an already-applied adjustment | Feature |
| E | Port A–D to the browser app, push to GitHub | Port + deploy |

**Explicitly out of scope for Phase 7:** one-sided (unbalanced) adjustments. Deferred by
decision — every adjustment still must have debits = credits. Revisit later if needed.

---

## 1. Workstream A — Per-entity ledger mapping (bug fix)

### 1.1 The defect

`entity_coa_mapping` is correctly keyed `UNIQUE (entity_id, entity_ledger_name)` — the
data model already supports one ledger name mapping to different categories in different
entities. **The UI does not.**

- `src/web/routes/mapping.py:21` builds rows from
  `mapping_repo.distinct_ledgers_for_period()`, which collapses to **one row per ledger
  name across all entities**.
- The row renders a **single** `<select>` (`src/web/templates/mapping.html:34`).
- Saving calls `mapping_repo.apply_mapping()` (`src/db/repositories/mapping_repo.py:61`),
  whose docstring says it plainly: *"Apply a category to every entity where this ledger
  name appears."*

So one Save silently overwrites every entity's mapping for that ledger with a single
category. `mapping_repo.apply_mapping_for_entity()` (line 84) already exists and does
exactly the right thing — it was written for this case — but **nothing calls it**. The JS
port has the identical shape (`docs/src/pages/mapping.js:70`,
`docs/src/db/mapping-repo.js:61` / `:87`).

### 1.2 Confirmed against real data

`12% Interest on Shareholders Loan A/c` exists in two entities under two different Tally
primary groups:

| Period | Entity | Tally primary group | Closing balance | Correct category |
|--------|--------|--------------------|-----------------|------------------|
| 2026-06 | KDI | Current Liabilities | 3 | `Loans & Advances taken` (BS) |
| 2026-06 | VKS | Indirect Expenses | 272,263,373 | `Interest on  Shareholder loan` (PL) |

**In the local `data\consolidation.db` this is currently mapped correctly** — June's P&L
does carry the 272,263,373 inside `Other Expenses`, and the BS `Check` row is 0. The
screenshot showing both collapsed onto `Loans & Advances taken` therefore came from a
**different copy** of the database.

Two consequences of the collapse, for whoever reviews the repaired numbers:
- P&L: `Interest on  Shareholder loan` understates by the VKS amount; net loss improves.
- BS: the amount lands in `Loans & Advances taken` (CR-normal), *reducing* short-term
  liabilities. Retained Earnings rises by the same amount via the improved P&L, so
  **the BS still balances** — which is why no validation caught it. It is wrong on two
  lines and self-cancelling.

> ⚠️ **Open question — which database?** The screenshot's balance is **283,297,543**,
> which matches neither May (278,046,584) nor June (272,263,376) in the local copy. That
> is a newer dataset — most likely July 2026, or a copy loaded into the browser app.
> Before repairing data, confirm which `consolidation.db` is authoritative. The code fix
> below is independent of this and can proceed either way.

### 1.3 Changes

**`src/db/repositories/mapping_repo.py`**

Add, alongside the existing `distinct_ledgers_for_period`:

```python
def ledger_rows_for_period(conn, period_id) -> list[dict]:
    """One row per ledger name, plus a per-entity breakdown. Replaces
    distinct_ledgers_for_period for UI use; that function stays for the Excel export."""
```

Each returned dict:

```python
{
  "ledger_name": str,
  "entities": [                      # always populated, one per entity carrying the ledger
      {"entity_id": int, "entity_code": str, "primary_group": str,
       "balance": float, "category": str | None},
  ],
  "total_balance": float,
  "distinct_categories": int,        # count of distinct non-null category ids
  "distinct_primary_groups": int,
  "needs_split": bool,               # distinct_primary_groups > 1 or distinct_categories > 1
  "uniform_category": str | None,    # the single category, or None if it varies
}
```

`needs_split` is the switch that decides how the UI renders the row.

**`src/web/routes/mapping.py`**

- `mapping_form` uses `ledger_rows_for_period`.
- `apply_mapping_form` accepts a parallel `entity_code` list:

```python
def apply_mapping_form(period_str: str,
                       ledger_name: list[str] = Form(default=[]),
                       entity_code: list[str] = Form(default=[]),   # NEW; "" = all entities
                       category:   list[str] = Form(default=[]),
                       conn = Depends(get_db)):
```

For each triple: if `entity_code` is non-empty, resolve it and call
`apply_mapping_for_entity(conn, entity_id, name, cat_id, user)`; otherwise call
`apply_mapping(...)` as today.

**Guard against silent collapse (the important bit).** Even for a row the user did not
touch, a whole-ledger `apply_mapping` would flatten an existing split. So:

> A ledger with `needs_split == True` is **only ever** rendered as per-entity rows, and
> the server **rejects** a whole-ledger (`entity_code == ""`) write for such a ledger,
> returning an error flash rather than applying it.

**`src/web/templates/mapping.html`**

- `needs_split == False` → render exactly as today (one row, one select, hidden
  `entity_code` = `""`).
- `needs_split == True` → render a parent row (ledger name, badge, total balance, **no
  select**) followed by one indented child row per entity, each with entity code, that
  entity's primary group, that entity's balance, and its own `<select>` plus hidden
  `entity_code`.
- Update the page subtitle — it currently promises the old behaviour: *"Changing a
  category and saving re-applies it to every entity that carries that ledger name."*
  Reword to say that ledgers differing across entities are categorized per entity.

**`src/exporters/mapping_workbook.py`** — add an `Entity Code` column:
- Export: one row per (ledger, entity) when `needs_split`, else one row with blank entity.
- Import: blank entity code → `apply_mapping`; a code → `apply_mapping_for_entity`.
- Reject a blank entity code for a `needs_split` ledger, mirroring the web guard.

### 1.4 Tests — `tests/test_mapping.py`

1. `test_ledger_in_two_entities_keeps_independent_categories` — map the same ledger name
   to a BS category in one entity and a PL category in another; assert both persist.
2. `test_whole_ledger_write_rejected_for_split_ledger` — after a split exists, posting a
   whole-ledger mapping returns an error and **leaves both mappings unchanged**.
3. `test_interest_on_shareholder_loan_reaches_pl` — regression, on the real fixtures:
   import June, apply the correct split, consolidate, `compute_pl`, assert
   `Interest on  Shareholder loan == 272263373` and BS `Check == 0`.
4. `test_mapping_workbook_entity_column_round_trip` — export → edit → import preserves the
   split.

### 1.5 Data repair

Once the fix is in, on the authoritative database: open Mapping, confirm the ledger renders
as two per-entity rows, set KDI → `Loans & Advances taken`, VKS →
`Interest on  Shareholder loan`, Save, Consolidate, and check the P&L line and BS `Check`.

Then **sweep for other victims** — any ledger where `distinct_primary_groups > 1`. A
throwaway script (`scripts/audit_split_ledgers.py`, safe/read-only) should list every such
ledger per period so they can all be reviewed at once rather than found one at a time.

---

## 2. Workstream B — Stock / COGS

### 2.1 Formula and sources

```
COGS = Opening Stock + Purchases − Closing Stock
```

| Input | Source | Editable |
|-------|--------|----------|
| Opening Stock | Prior period's **post-adjustment** Inventory closing, per entity | Yes |
| Closing Stock | Current period's TB Inventory closing, per entity | Yes |
| Purchases | Current period's closing balance on ledgers mapped to `COGS before Direct Cost & Forex Gain/Loss`, per entity | Yes |

"Post-adjustment" means summing `consolidated_tb` rows with
`source_type IN ('entity_tb','adjustment')` for that entity — **summed, not last-wins**
(this is the §9.6 bug from `HANDOVER.md`; don't reintroduce it).

Purchases uses the **closing** balance, not `period_dr − period_cr`, because
`statement_generator` builds the whole P&L from closing balances — using movement here
would make the screen disagree with the P&L.

### 2.2 What the real data says (read this before coding)

Per-entity, from the local database:

| Period | Entity | TB Inventory opening | TB Inventory movement | TB Inventory closing |
|--------|--------|---------------------|----------------------|---------------------|
| 2026-05 | BII | 3,804,418,750 | 0 | 3,804,418,750 |
| 2026-05 | KDI | 1,141,650,774 | 0 | 1,141,650,774 |
| 2026-05 | KNS | 3,328,825,188 | 0 | 3,328,825,188 |
| 2026-05 | VKS | 3,342,059,691 | 0 | 3,342,059,691 |
| 2026-06 | BII | 3,804,418,750 | 0 | 3,804,418,750 |
| 2026-06 | KDI | 1,195,849,866 | 0 | 1,195,849,866 |
| 2026-06 | KNS | 2,529,813,048 | 0 | 2,529,813,048 |
| 2026-06 | VKS | 3,342,059,691 | 0 | 3,342,059,691 |

Purchases (June, ledgers mapped to COGS): **KNS only** — `Purchase Sachajuan`
926,845,857 (plus a zero-value `ROUND OFF`). BII, KDI and VKS have **no** purchase ledgers
mapped at all.

Two things fall out of this that the implementer must not paper over:

**(a) Inventory never moves within a month, but does move between months.** Every entity
shows zero period movement, yet KNS drops 3,328,825,188 → 2,529,813,048 and KDI rises
1,141,650,774 → 1,195,849,866 across the two TBs. So June's TB *opening* ≠ May's TB
*closing* for those entities. The stock was restated in Tally without a journal in the
Inventory ledger. **This is the unresolved caveat from `HANDOVER.md` §8.1, now confirmed
with numbers.**

It matters because it decides where the credit goes. For KNS June, Opening − Closing =
**799,012,140** (close to the ~785M previously estimated — different framing, similar size):

- If the TB's Inventory closing is **already correct**, then crediting Inventory again
  would double-count the drawdown and take KNS to ~1.73bn. The credit belongs in equity
  (an opening correction), and only the P&L needs the debit.
- If the TB's Inventory closing is **stale**, crediting Inventory is right.

The tool must not guess. §2.4 puts the choice on the screen and shows the evidence.

**(b) Three of four entities have no purchases mapped.** Either genuinely no purchases, or
purchase ledgers are categorized somewhere other than COGS. The Stock screen must display
"Purchases: 0 (no ledgers mapped to COGS)" loudly rather than quietly computing with zero.

### 2.3 Schema — `src/db/migrations/004_stock_and_period_state.sql`

```sql
CREATE TABLE IF NOT EXISTS stock_movement (
    stock_id                INTEGER PRIMARY KEY AUTOINCREMENT,
    period_id               INTEGER NOT NULL REFERENCES periods(period_id),
    entity_id               INTEGER NOT NULL REFERENCES entities(entity_id),
    opening_stock_auto      REAL,
    opening_stock_override  REAL,
    closing_stock_auto      REAL,
    closing_stock_override  REAL,
    purchases_auto          REAL,
    purchases_override      REAL,
    balancing_account       TEXT NOT NULL DEFAULT 'inventory'
                              CHECK (balancing_account IN ('inventory', 'retained_earnings')),
    notes                   TEXT,
    updated_at              TEXT,
    updated_by              TEXT,
    UNIQUE (period_id, entity_id)
);

ALTER TABLE periods ADD COLUMN consolidated_at TEXT;   -- used by workstream D
```

Auto and override are stored **separately and both kept** so the screen can always show
"pulled X, you overrode to Y", and so a re-pull never silently discards a typed figure.
Effective value = `override if override is not None else auto`.

### 2.4 Engine — `src/engines/stock_engine.py` (new)

```python
@dataclass
class StockRow:
    entity_id: int
    entity_code: str
    opening_auto: float | None       # None = no prior period
    opening_override: float | None
    closing_auto: float
    closing_override: float | None
    purchases_auto: float
    purchases_override: float | None
    purchase_ledger_count: int       # 0 => show the "nothing mapped" warning
    tb_opening_inventory: float      # current TB's own opening — for the break check
    balancing_account: str
    # derived (properties)
    opening: float; closing: float; purchases: float
    computed_cogs: float             # opening + purchases − closing
    tb_cogs: float                   # == purchases; what the P&L shows today
    delta: float                     # computed_cogs − tb_cogs  ==  opening − closing
    opening_break: float             # tb_opening_inventory − opening
```

```python
def refresh(conn, period_id) -> list[StockRow]:
    """Recompute every *_auto from the TBs and prior period, upsert into stock_movement,
    preserve all *_override values. Idempotent — safe to call on every page load."""

def save_overrides(conn, period_id, entity_id, *, opening=None, closing=None,
                   purchases=None, balancing_account=None, notes=None, user=None) -> None:
    """Writes overrides only. Passing None leaves that field untouched;
    to clear an override, pass the sentinel CLEAR."""

def generate_adjustment(conn, period_id, external_ref, user=None) -> int:
    """Build/replace a draft `inventory_movement` adjustment from the current
    stock_movement state. Two lines per entity with a non-zero delta. Raises if the
    period is locked (via period_repo.require_open)."""
```

Line construction, per entity, `delta = opening − closing`:

| Case | Line 1 | Line 2 |
|------|--------|--------|
| `delta > 0` (drew down) | Dr `COGS before Direct Cost & Forex Gain/Loss` = delta | Cr *balancing account* = delta |
| `delta < 0` (built up) | Dr *balancing account* = −delta | Cr `COGS before Direct Cost & Forex Gain/Loss` = −delta |
| `delta == 0` | no lines |

Balancing account = `Inventory` (default) or `Retained Earnings`, per entity, per the
`balancing_account` column. Both lines carry that entity's `entity_id` — never group-level,
since stock sits with a specific entity.

Reuse `adjustment_engine.create_adjustment` — do **not** write to `adjustments` directly;
that would bypass validation and the audit log.

### 2.5 UI — `/periods/{period_str}/stock`

New route file `src/web/routes/stock.py`, template `src/web/templates/stock.html`, nav
entry added in `base.html`.

One row per entity, columns:

| Entity | Opening Stock | Closing Stock | Purchases | Computed COGS | COGS in TB | Adjustment needed | Balancing a/c |
|--------|--------------|---------------|-----------|---------------|------------|-------------------|---------------|

- Opening / Closing / Purchases are `<input>`s pre-filled with the effective value. A
  small "auto: 3,328,825,188 · reset" link beside any overridden field.
- Balancing a/c is a per-row `<select>`: *Inventory* / *Retained Earnings*.
- Badges on the row:
  - `opening_break != 0` → warn: *"This TB's Inventory opening is X, but the prior period
    closed at Y (break Z). Tally restated stock without a journal — check whether the
    Inventory side of this entry would double-count."* This is the §2.2(a) decision,
    surfaced exactly where it's made.
  - `purchase_ledger_count == 0` → warn: *"No ledgers mapped to COGS for this entity."*
  - No prior period → *"No prior period — enter Opening Stock manually."*
- Footer total row.
- Buttons: **Save figures**, and **Generate adjustment** (posts to
  `/periods/{p}/stock/generate`, default ref `ADJ-{YYYY}-{MM}-STOCK`, then redirects to the
  Adjustments list with a flash saying it was created as a draft and still needs Apply +
  Consolidate).

Locked period → inputs disabled, both buttons hidden.

### 2.6 CLI

```
python -m src.cli stock-show     --period 2026-06
python -m src.cli stock-set      --period 2026-06 --entity KNS [--opening N] [--closing N] [--purchases N] [--balancing inventory|retained_earnings]
python -m src.cli stock-generate --period 2026-06 [--ref ADJ-2026-06-STOCK]
```

### 2.7 Validation V19

In `validation_engine.py`, added to `run_all`:

> **V19 — Stock/COGS movement booked.** Severity **Warning**. Fails when the period has a
> non-zero Inventory balance and either (a) no applied `inventory_movement` adjustment
> exists, or (b) one exists but its amounts no longer match the current `stock_movement`
> figures (i.e. the figures were edited after the adjustment was generated). Details name
> the entity and the expected vs booked amount.

### 2.8 Tests — `tests/test_stock.py` (new)

1. `test_refresh_pulls_opening_from_prior_post_adjustment_closing`
2. `test_refresh_pulls_closing_from_current_tb`
3. `test_refresh_purchases_sums_cogs_mapped_ledgers` — on real June fixtures, KNS = 926,845,857
4. `test_refresh_preserves_overrides`
5. `test_generate_adjustment_drawdown_direction` — KNS June: Dr COGS 799,012,140 / Cr Inventory 799,012,140
6. `test_generate_adjustment_buildup_direction` — reversed
7. `test_generate_adjustment_retained_earnings_balancing_account`
8. `test_generate_adjustment_skips_zero_delta_entities`
9. `test_generated_adjustment_balances_and_passes_v2`
10. `test_no_prior_period_leaves_opening_null`
11. `test_locked_period_blocks_generate`
12. `test_v19_warns_when_stock_not_booked` / `..._when_figures_changed_after_generation`

---

## 3. Workstream C — Retained Earnings movement check

### 3.1 The check

```
expected_RE_closing(M) = RE_closing(M−1) + net_profit(M−1)
gap                    = actual_RE_closing(M) − expected_RE_closing(M)
```

- `RE_closing` = post-adjustment closing on the `Retained Earnings` **ledger category**
  (BS022) — the brought-forward figure, *not* the BS face line, which
  `statement_generator.compute_bs` builds as `RE_bf + current_year_pl`. Using the face line
  would compare the number against itself.
- `net_profit(M−1)` = `compute_pl(conn, prior_period_id)[1]`.
- **Severity: Warning.** It never blocks locking a period.
- Passes trivially (with an explanatory detail line) when there is no prior period, or the
  prior period has no `consolidated_tb` rows.

This is deliberately diagnostic rather than prescriptive: it reports RE closing for both
months, the movement, the prior month's profit, and the gap, so the first run tells you
whether your TBs update RE monthly or only at year end — instead of the tool assuming one
and being wrong all year.

### 3.2 Engine — `src/engines/re_check.py` (new)

```python
@dataclass
class RECheckRow:            # one per entity, plus a group total row
    entity_code: str | None  # None = group total
    re_closing_prior: float
    prior_net_profit: float
    re_closing_current: float
    expected: float          # re_closing_prior + prior_net_profit
    gap: float               # re_closing_current − expected

@dataclass
class RECheckResult:
    applicable: bool
    reason: str | None       # why not applicable
    prior_period_str: str | None
    rows: list[RECheckRow]
    linked_adjustments: list[dict]

def run(conn, current_period_id) -> RECheckResult: ...
```

`linked_adjustments` — this is the *"adjustments linked to it as well"* requirement. It
collects every adjustment line in **either** period that touches `Retained Earnings` or
**any** `statement_type = 'PL'` category, since both move the two sides of this
reconciliation. Each entry:

```python
{"period_str", "adjustment_id", "external_ref", "type", "status", "narration",
 "entity_code", "category", "statement_type", "debit", "credit"}
```

Per-entity attribution: `net_profit(M−1)` per entity is not something `compute_pl` produces
(it computes a group P&L). Compute it in `re_check` as the signed sum of
`consolidated_tb` PL-category rows for that entity, `source_type IN ('entity_tb','adjustment')`
— sign-flipped to income-positive, matching `_v7_pl_flows_to_bs`'s convention. The group
total row uses `compute_pl` so the headline figure ties to the P&L page exactly.

### 3.3 UI — `/periods/{period_str}/retained-earnings`

New route file `src/web/routes/re_check.py`, template
`src/web/templates/retained_earnings.html`, nav entry in `base.html`.

Layout:

1. **Headline reconciliation** (group level), as a vertical waterfall:
   `RE closing 2026-05` → `+ Net profit/(loss) 2026-05` → `= Expected RE closing 2026-06`
   → `Actual RE closing 2026-06` → **`Gap`** (bold; green when within tolerance, amber
   otherwise).
2. **Per-entity table** — same five columns, one row per entity, total row at the bottom.
3. **Linked adjustments table** — ref, period, type, entity, category, Dr, Cr, status,
   narration. Each ref links to that adjustment's edit page (workstream D), so a gap can be
   chased straight into the entry that caused it.
4. When not applicable, an explanatory panel instead of the tables.

Tolerance: reuse `validation_engine.TOLERANCE_IDR` (1).

### 3.4 Validation V20

> **V20 — Retained Earnings movement ties to prior period profit.** Severity **Warning**.
> Wraps `re_check.run()`. Detail line per entity whose `abs(gap) > TOLERANCE_IDR`, plus a
> group-level line. Passes when not applicable.

Add to `run_all`. Note `tests/test_validations.py` and `tests/test_web_routes.py` assert on
the number of checks — those counts move from 10 to 12 (V19 + V20).

### 3.5 Tests — `tests/test_re_check.py` (new)

1. `test_not_applicable_without_prior_period`
2. `test_not_applicable_when_prior_not_consolidated`
3. `test_gap_zero_on_synthetic_tying_data`
4. `test_gap_reported_when_re_does_not_move`
5. `test_per_entity_rows_sum_to_group_row`
6. `test_group_row_net_profit_matches_compute_pl` — guards the two-different-methods risk in §3.2
7. `test_linked_adjustments_include_pl_and_re_lines_from_both_periods`
8. `test_v20_is_warning_and_never_blocks_lock`
9. `test_re_page_renders` (TestClient)

---

## 4. Workstream D — Edit an applied adjustment

### 4.1 Current behaviour

`adjustment_repo.create_or_replace` already upserts by `(period_id, external_ref)`:
deletes the old lines, updates the header, **resets `status` to `'draft'`**, and writes an
audit row. So the engine half largely exists — what's missing is a UI path to it, a
meaningful audit trail, and a warning that the consolidated TB is now stale.

### 4.2 Decisions

- **Editing resets the adjustment to `draft`.** It must be re-Applied and the period
  re-Consolidated. This matches existing behaviour and keeps "applied" meaning "actually
  in the consolidated numbers".
- **`external_ref` is immutable when editing.** Renaming is delete + recreate. Allowing it
  would collide with the `UNIQUE (period_id, external_ref)` upsert key and make an edit
  indistinguishable from creating a second adjustment.
- **Locked periods stay locked.** `period_repo.require_open` guards the edit path like
  every other write.

### 4.3 Engine — `src/engines/adjustment_engine.py`

```python
def update_adjustment(conn, period_id, adjustment_id, adjustment_type, narration,
                      lines, user=None) -> int:
    """Edit an existing adjustment (draft or applied) in place. Validates, requires the
    period open, snapshots before/after into the audit log, and resets status to draft."""
```

Steps: `period_repo.require_open` → load the existing header + lines → `validate(...)`,
raise on errors → serialize the before-state to JSON → `create_or_replace(...)` → write an
`audit_service.log(conn, "edit", "adjustments", str(adjustment_id), old_value=<before json>,
new_value=<after json>, user=user)`.

The before/after JSON is the point of this workstream as much as the editing is — without
it, an edit to an applied entry is untraceable. Shape:

```json
{"external_ref": "...", "type": "...", "narration": "...", "status": "applied",
 "lines": [{"entity": "KNS", "category": "...", "debit": 0, "credit": 97714092}]}
```

### 4.4 Stale-consolidation flag

`consolidate_period` sets `periods.consolidated_at` (column added in migration 004) on
success. A period is **stale** when any adjustment for it has been created, edited,
applied, or deleted since that timestamp.

Helper in `src/db/repositories/period_repo.py`:

```python
def is_consolidation_stale(conn, period_id) -> bool: ...
```

Implemented by comparing `periods.consolidated_at` against the newest `audit_log.timestamp`
for `table_name = 'adjustments'` on that period's adjustment ids. Surface it as an amber
banner — *"Adjustments changed since the last consolidation. Re-run Consolidate."* — via
the existing `_inject_period_status` context processor in `src/web/deps.py`, so every
period-scoped page shows it and no individual route can forget (same pattern as the
existing lock badge fix).

### 4.5 UI

- `GET /periods/{period_str}/adjustments/{ref}/edit` — reuses `adjustments_form.html`,
  pre-filled: header fields set, `external_ref` rendered readonly, one row per existing
  line (entity, category, debit, credit, line narration), plus blank rows to add lines and
  a per-row remove control.
- `POST /periods/{period_str}/adjustments/{ref}/edit` — same parsing as
  `create_adjustment_route`, calls `update_adjustment`, re-renders with errors on failure
  (status 400), redirects to the list with a flash on success: *"Updated {ref} — back to
  draft. Apply it and re-run Consolidate."*
- `adjustments_list.html` — add an **Edit** button per row (both draft and applied),
  hidden when the period is locked.
- Template needs a `mode` flag (`"new"` / `"edit"`) to switch the form action, heading, and
  submit label.

### 4.6 CLI

```
python -m src.cli edit-adjustment --period 2026-06 --ref ADJ-2026-06-001 --in Adjustments.xlsx
```

Loads only that ref from the workbook and routes it through `update_adjustment`. (The
existing `import-adjustments` already round-trips everything; this is the single-entry,
audited path.)

### 4.7 Tests — `tests/test_adjustments.py`

1. `test_update_applied_adjustment_resets_to_draft`
2. `test_update_writes_before_and_after_to_audit_log`
3. `test_update_rejects_unbalanced_lines`
4. `test_update_blocked_on_locked_period`
5. `test_update_cannot_change_external_ref`
6. `test_edited_adjustment_changes_consolidated_tb_after_reapply_and_reconsolidate` —
   end-to-end
7. `test_is_consolidation_stale_after_edit` / `..._false_after_reconsolidate`
8. `test_edit_form_renders_prefilled` (TestClient)

---

## 5. Workstream E — Port to the browser app and deploy

Only after A–D pass in Python. Mirror file-for-file:

| Python | JS |
|--------|-----|
| `src/db/migrations/004_stock_and_period_state.sql` | copy to `docs/src/db/migrations/`, add to `MIGRATION_FILES` in `docs/src/db/persistence.js:10` |
| `src/engines/stock_engine.py` | `docs/src/engines/stock.js` |
| `src/engines/re_check.py` | `docs/src/engines/re-check.js` |
| `adjustment_engine.update_adjustment` | `docs/src/engines/adjustments.js` |
| `mapping_repo.ledger_rows_for_period` | `docs/src/db/mapping-repo.js` |
| `src/web/routes/stock.py` + template | `docs/src/pages/stock.js` |
| `src/web/routes/re_check.py` + template | `docs/src/pages/retained-earnings.js` |
| mapping route/template | `docs/src/pages/mapping.js` |
| adjustments edit route/template | `docs/src/pages/adjustment-form.js`, `adjustments-list.js` |
| V19, V20 | `docs/src/engines/validation.js` |

Also: two new routes in `docs/src/router.js`, two nav entries in `docs/src/layout.js`.

**Two porting traps, both already paid for once** (`HANDOVER.md` §9):
- Sort order — use the existing `codepointCompare` from `docs/src/utils.js`, never
  `localeCompare`, anywhere rows are ordered.
- Entity + adjustment values must be **summed**, not last-wins. The Stock screen's
  post-adjustment opening balance (§2.1) is exactly the shape that bug took.

**Verification method** — the same as the original port: run the Python app and the browser
app side by side on the **same real database**, and diff, per period, per entity:
Stock screen figures and computed COGS; the generated adjustment's lines; the RE
reconciliation numbers; the full validation list including V19/V20; and the P&L/BS after
apply + consolidate. Target: 0 diffs. Also re-run the Excel pack cell-by-cell comparison,
since a new applied adjustment flows into the `Entity_<CODE>` sheets.

**Deploy:** commit to `master`, push to `main` on
`https://github.com/notrahul98/Consolidation_Tool`. GitHub Pages rebuilds from `/docs`
automatically — no Actions workflow. Then hard-refresh the live app and confirm the two new
nav entries appear and the migration applied (`schema_migrations` contains `004_...`).

---

## 6. Files touched — summary

**New:** `src/db/migrations/004_stock_and_period_state.sql`, `src/engines/stock_engine.py`,
`src/engines/re_check.py`, `src/web/routes/stock.py`, `src/web/routes/re_check.py`,
`src/web/templates/stock.html`, `src/web/templates/retained_earnings.html`,
`scripts/audit_split_ledgers.py`, `tests/test_stock.py`, `tests/test_re_check.py`,
plus the JS counterparts in §5.

**Modified:** `src/db/repositories/mapping_repo.py`, `period_repo.py`, `adjustment_repo.py`,
`src/engines/adjustment_engine.py`, `consolidation_engine.py`, `validation_engine.py`,
`src/exporters/mapping_workbook.py`, `src/web/routes/mapping.py`, `adjustments.py`,
`src/web/deps.py`, `src/web/templates/mapping.html`, `adjustments_form.html`,
`adjustments_list.html`, `base.html`, `src/cli.py`, `tests/test_mapping.py`,
`test_adjustments.py`, `test_validations.py`, `test_web_routes.py`, `README.md`,
`HANDOVER.md`.

---

## 7. Regression risk register

| Risk | Guard |
|------|-------|
| Mapping change collapses an existing per-entity split | Server-side rejection of whole-ledger writes for `needs_split` ledgers (§1.3) + test 2 |
| Stock adjustment double-counts Inventory | `opening_break` badge + per-entity balancing-account choice (§2.2a, §2.4) |
| Purchases silently zero for 3 of 4 entities | `purchase_ledger_count == 0` warning (§2.2b) |
| Editing an applied adjustment leaves stale consolidated numbers | `consolidated_at` + stale banner on every period page (§4.4) |
| Edits untraceable | before/after JSON in `audit_log` (§4.3) |
| V19/V20 block month-end | both are **Warning** severity by design |
| Existing tests assert "10 checks" | update counts to 12 (§3.4) |
| Python and JS drift | side-by-side 0-diff verification before deploy (§5) |

---

## 8. Phasing

| Phase | Content | Done when |
|-------|---------|-----------|
| 7.1 | Workstream A + tests | Interest reaches the P&L on real June data; split-ledger sweep reviewed |
| 7.2 | Migration 004 + `stock_engine` + tests (no UI) | `pytest tests/test_stock.py` green |
| 7.3 | Stock screen + CLI + V19 | KNS June generates Dr COGS / Cr 799,012,140 as a draft |
| 7.4 | `re_check` + screen + V20 + tests | RE page renders for June; gap explained |
| 7.5 | Editable adjustments + stale banner + tests | Full suite green (57 + ~30 new) |
| 7.6 | Port to JS, side-by-side diff | 0 diffs across all screens |
| 7.7 | Push to GitHub, verify live | New pages live on GitHub Pages |

---

## 9. Open questions

1. **Which `consolidation.db` is authoritative?** The screenshot's 283,297,543 matches
   neither May nor June in the local copy (§1.2). Needed before any data repair.
2. **The Inventory restatement (§2.2a).** The tool will present the choice per entity, but
   the accounting answer — is the TB's Inventory closing current or stale? — is yours. The
   default is `Inventory`; flip to `Retained Earnings` where the TB was already restated.
3. **Missing purchase ledgers.** BII, KDI and VKS have nothing mapped to COGS. Genuine, or
   a mapping gap? Affects whether their computed COGS means anything.
