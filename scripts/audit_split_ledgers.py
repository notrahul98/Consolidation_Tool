"""Read-only sweep for ledgers that are booked differently across entities.

Why this exists: entity_coa_mapping is keyed (entity_id, entity_ledger_name), so the same
ledger name can legitimately carry a different category in each entity. Until the per-entity
Mapping fix, saving the Mapping page applied ONE category to every entity carrying that name.
Any ledger flattened that way is still wrong in the database today — re-running consolidation
will not repair it, because the mapping itself was overwritten.

The dangerous pattern is a ledger whose Tally primary group differs across entities (so the
entities genuinely mean different things by it) while every entity now shares a single
category. That is what happened to "12% Interest on Shareholders Loan A/c": an expense in
VKS and a liability in KDI, collapsed onto the liability, which quietly removed the interest
from the P&L.

Nothing here writes. Point it at any consolidation.db, including a backup downloaded from
the browser app:

    python scripts/audit_split_ledgers.py
    python scripts/audit_split_ledgers.py --db "C:/Users/me/Downloads/consolidation.db"
    python scripts/audit_split_ledgers.py --period 2026-08 --strict
"""

import argparse
import json
import sqlite3
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Tally primary group -> which statement the ledger naturally belongs to. Used only to spot
# a mapped category that contradicts the source group; it is a heuristic prompt for review,
# never a verdict. Deliberate reclassifications do exist (stock accounts under a purchase
# group mapped to Inventory, for one), so expect and read past some false positives.
GROUP_STATEMENT = {
    "indirect expenses": "PL",
    "direct expenses": "PL",
    "indirect incomes": "PL",
    "direct incomes": "PL",
    "sales accounts": "PL",
    "purchase accounts": "PL",
    "unadjusted forex gain/loss": "PL",
    "current assets": "BS",
    "current liabilities": "BS",
    "fixed assets": "BS",
    "investments": "BS",
    "capital account": "BS",
    "loans (liability)": "BS",
    "branch / divisions": "BS",
    "misc. expenses (asset)": "BS",
}


def resolve_db(explicit: str | None) -> str:
    if explicit:
        return explicit
    settings = json.loads((PROJECT_ROOT / "config" / "app_settings.json").read_text(encoding="utf-8"))
    raw = Path(settings["database_path"])
    return str(raw if raw.is_absolute() else PROJECT_ROOT / raw)


def connect_readonly(path: str) -> sqlite3.Connection:
    if not Path(path).exists():
        sys.exit(f"No database at {path}")
    conn = sqlite3.connect(f"file:{Path(path).as_posix()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def periods(conn: sqlite3.Connection, only: str | None) -> list[sqlite3.Row]:
    rows = conn.execute("SELECT period_id, year, month FROM periods ORDER BY year, month").fetchall()
    if only:
        year, month = (int(p) for p in only.split("-"))
        rows = [r for r in rows if r["year"] == year and r["month"] == month]
        if not rows:
            sys.exit(f"No period {only} in this database")
    return rows


def ledgers_for_period(conn: sqlite3.Connection, period_id: int) -> dict[str, list[dict]]:
    rows = conn.execute(
        """SELECT tbl.entity_ledger_name AS ledger, tbl.tally_primary_group AS grp,
                  e.entity_code, gc.account_name AS category, gc.statement_type,
                  (tbl.closing_dr - tbl.closing_cr) AS balance
           FROM trial_balance_lines tbl
           JOIN trial_balance_imports tbi ON tbi.import_id = tbl.import_id
           JOIN entities e ON e.entity_id = tbi.entity_id
           LEFT JOIN entity_coa_mapping ecm
                  ON ecm.entity_id = tbi.entity_id AND ecm.entity_ledger_name = tbl.entity_ledger_name
           LEFT JOIN group_coa gc ON gc.group_account_id = ecm.group_account_id
           WHERE tbi.period_id = ?
           ORDER BY tbl.entity_ledger_name, e.entity_code""",
        (period_id,),
    ).fetchall()

    by_ledger: dict[str, list[dict]] = {}
    for r in rows:
        by_ledger.setdefault(r["ledger"], []).append({
            "entity": r["entity_code"],
            "group": (r["grp"] or "").strip(),
            "category": r["category"],
            "statement_type": r["statement_type"],
            "balance": r["balance"] or 0.0,
        })
    return by_ledger


def classify(entries: list[dict]) -> str | None:
    groups = {e["group"] for e in entries if e["group"]}
    categories = {e["category"] for e in entries if e["category"]}
    fully_categorized = all(e["category"] for e in entries)

    if len(groups) > 1:
        if len(categories) > 1:
            return "split"          # already handled per entity
        # One shared category across entities that mean different things by this ledger:
        # the fingerprint of a whole-ledger save. Requires every entity to be categorized —
        # a half-mapped or unmapped ledger is incomplete work, not a collapse, and validation
        # V3/V12 already blocks consolidation on material unmapped ledgers.
        return "flattened" if (len(categories) == 1 and fully_categorized) else None
    if len(categories) > 1:
        return "inconsistent"
    return None


def statement_mismatches(entries: list[dict]) -> list[dict]:
    out = []
    for e in entries:
        implied = GROUP_STATEMENT.get(e["group"].lower())
        if implied and e["statement_type"] and implied != e["statement_type"]:
            out.append(e)
    return out


def idr(v: float) -> str:
    return f"({abs(v):,.0f})" if v < 0 else f"{v:,.0f}"


def main() -> None:
    ap = argparse.ArgumentParser(description="Find ledgers booked differently across entities.")
    ap.add_argument("--db", help="Path to a consolidation.db (default: the configured one)")
    ap.add_argument("--period", help="Limit to one period, e.g. 2026-08")
    ap.add_argument("--all-mismatches", action="store_true",
                    help="List every group-vs-category mismatch, not just the worst 20")
    ap.add_argument("--strict", action="store_true", help="Exit 1 if any flattened ledger is found")
    args = ap.parse_args()

    db_path = resolve_db(args.db)
    conn = connect_readonly(db_path)
    print(f"Database : {db_path}")

    total_flattened = 0
    for period in periods(conn, args.period):
        label = f"{period['year']}-{period['month']:02d}"
        by_ledger = ledgers_for_period(conn, period["period_id"])

        buckets: dict[str, list] = {"flattened": [], "split": [], "inconsistent": []}
        mismatches = []
        for ledger, entries in sorted(by_ledger.items()):
            kind = classify(entries)
            if kind:
                buckets[kind].append((ledger, entries))
            for m in statement_mismatches(entries):
                mismatches.append((ledger, m))

        print(f"\n{'=' * 78}\nPeriod {label} - {len(by_ledger)} distinct ledgers")
        total_flattened += len(buckets["flattened"])

        print(f"\n  [1] FLATTENED - different Tally groups, but one shared category  ({len(buckets['flattened'])})")
        print("      These are the likely victims of a whole-ledger save. Fix each on the")
        print("      Mapping page, then Consolidate.")
        if not buckets["flattened"]:
            print("      none")
        for ledger, entries in buckets["flattened"]:
            print(f"      - {ledger}")
            for e in entries:
                print(f"          {e['entity']:5} {e['group'][:24]:24} -> {e['category'] or '(uncategorized)'}  {idr(e['balance']):>20}")

        print(f"\n  [2] SPLIT - different groups AND different categories, already handled  ({len(buckets['split'])})")
        if not buckets["split"]:
            print("      none")
        for ledger, entries in buckets["split"]:
            print(f"      - {ledger}")
            for e in entries:
                print(f"          {e['entity']:5} {e['group'][:24]:24} -> {e['category'] or '(uncategorized)'}  {idr(e['balance']):>20}")

        print(f"\n  [3] INCONSISTENT - same group, different categories, worth a look  ({len(buckets['inconsistent'])})")
        if not buckets["inconsistent"]:
            print("      none")
        for ledger, entries in buckets["inconsistent"]:
            print(f"      - {ledger}")
            for e in entries:
                print(f"          {e['entity']:5} {e['group'][:24]:24} -> {e['category'] or '(uncategorized)'}  {idr(e['balance']):>20}")

        shown = mismatches if args.all_mismatches else sorted(
            mismatches, key=lambda x: -abs(x[1]["balance"]))[:20]
        print(f"\n  [4] GROUP vs CATEGORY MISMATCH - heuristic, expect false positives  ({len(mismatches)})")
        print("      The Tally group implies one statement, the mapped category is on the other.")
        print("      Some of these are deliberate. Read, don't act blindly.")
        if not mismatches:
            print("      none")
        for ledger, e in shown:
            implied = GROUP_STATEMENT.get(e["group"].lower())
            print(f"      - {e['entity']:5} {ledger[:40]:40} {e['group'][:20]:20} ({implied}) -> "
                  f"{e['category']} ({e['statement_type']})  {idr(e['balance']):>18}")
        if len(mismatches) > len(shown):
            print(f"      ... and {len(mismatches) - len(shown)} more (--all-mismatches to see them)")

    print(f"\n{'=' * 78}")
    print(f"Flattened ledgers across all periods scanned: {total_flattened}")
    conn.close()
    if args.strict and total_flattened:
        sys.exit(1)


if __name__ == "__main__":
    main()
