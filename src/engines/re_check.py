"""Retained Earnings movement check.

expected_RE_closing(M) = RE_closing(M-1) + net_profit(M-1)
gap                    = actual_RE_closing(M) - expected_RE_closing(M)

RE_closing is the post-adjustment closing on the `Retained Earnings` ledger category
(BS022) -- the brought-forward figure, *not* the BS face line (which compute_bs builds as
RE_bf + current_year_pl). Using the face line would compare the number against itself.

Deliberately diagnostic rather than prescriptive: reports both months' RE closing, the
movement, the prior month's profit, and the gap -- so the first run tells you whether the
TBs update RE monthly or only at year end, instead of the tool assuming one and being wrong
all year. Severity is always Warning; this check never blocks locking a period.
"""

import sqlite3
from dataclasses import dataclass, field

from src.db.repositories import consolidated_repo, group_coa_repo, period_repo
from src.engines.statement_generator import compute_pl

RE_ACCOUNT_NAME = "Retained Earnings"


def _re_closing_group_total(conn: sqlite3.Connection, period_id: int) -> float:
    """Post-adjustment Retained Earnings for the group: every entity's bucket PLUS
    group-level adjustments.

    Not sum(per-entity buckets) alone: an adjustment booked at group level carries no
    entity_id, so it lands in no entity's bucket and summing them silently omits it. That
    would pair an RE closing WITHOUT group-level adjustments against a prior_net_profit
    (from compute_pl) WITH them, and report a gap wrong by exactly those adjustments --
    which is what happened on the real July data, off by the 13,608,330,781 shareholder-loan
    reclass. Entities + group-level is what the consolidated 'total' row holds, so this ties
    to the Balance Sheet, while still being well-defined before a period is consolidated."""
    account = group_coa_repo.get_by_name(conn, RE_ACCOUNT_NAME)
    if account is None:
        return 0.0
    account_id = account["group_account_id"]
    by_account_entity, group_adjustment, _ = consolidated_repo.get_buckets(conn, period_id)
    entity_sum = sum(v for (acct, _entity), v in by_account_entity.items() if acct == account_id)
    return entity_sum + group_adjustment.get(account_id, 0.0)


@dataclass
class RECheckRow:
    """One per entity, plus a group total row (entity_code=None)."""
    entity_code: str | None
    re_closing_prior: float
    prior_net_profit: float
    re_closing_current: float

    @property
    def expected(self) -> float:
        return self.re_closing_prior + self.prior_net_profit

    @property
    def gap(self) -> float:
        return self.re_closing_current - self.expected


@dataclass
class RECheckResult:
    applicable: bool
    reason: str | None
    prior_period_str: str | None
    rows: list[RECheckRow] = field(default_factory=list)
    linked_adjustments: list[dict] = field(default_factory=list)


def _re_closing_by_entity(conn: sqlite3.Connection, period_id: int) -> dict[int, float]:
    """entity_id -> post-adjustment closing balance on the Retained Earnings category.

    Summed (not last-wins) across source_type IN ('entity_tb', 'adjustment') rows."""
    rows = conn.execute(
        """SELECT ctb.entity_id, SUM(ctb.closing_dr) - SUM(ctb.closing_cr) AS balance
           FROM consolidated_tb ctb
           JOIN group_coa gc ON gc.group_account_id = ctb.group_account_id
           WHERE ctb.period_id = ? AND gc.account_name = ?
                 AND ctb.source_type IN ('entity_tb', 'adjustment')
           GROUP BY ctb.entity_id""",
        (period_id, RE_ACCOUNT_NAME),
    ).fetchall()
    return {r["entity_id"]: (r["balance"] or 0.0) for r in rows if r["entity_id"] is not None}


def _net_profit_by_entity(conn: sqlite3.Connection, period_id: int) -> dict[int, float]:
    """entity_id -> signed sum of consolidated_tb PL-category rows, sign-flipped to
    income-positive (matching _v7_pl_flows_to_bs's convention: income_positive =
    -(closing_dr - closing_cr)). Summed across source_type IN ('entity_tb', 'adjustment')."""
    rows = conn.execute(
        """SELECT ctb.entity_id, SUM(ctb.closing_dr) - SUM(ctb.closing_cr) AS balance
           FROM consolidated_tb ctb
           JOIN group_coa gc ON gc.group_account_id = ctb.group_account_id
           WHERE ctb.period_id = ? AND gc.statement_type = 'PL'
                 AND ctb.source_type IN ('entity_tb', 'adjustment')
           GROUP BY ctb.entity_id""",
        (period_id,),
    ).fetchall()
    return {r["entity_id"]: -(r["balance"] or 0.0) for r in rows if r["entity_id"] is not None}


def _period_has_consolidated_data(conn: sqlite3.Connection, period_id: int) -> bool:
    row = conn.execute(
        "SELECT 1 FROM consolidated_tb WHERE period_id = ? LIMIT 1", (period_id,)
    ).fetchone()
    return row is not None


def _linked_adjustments(conn: sqlite3.Connection, current_period_id: int, prior_period_id: int) -> list[dict]:
    """Every adjustment line in either period that touches Retained Earnings or any
    PL-statement-type category, since both move the two sides of this reconciliation."""
    rows = conn.execute(
        """SELECT p.year, p.month, a.adjustment_id, a.external_ref, a.adjustment_type, a.status,
                  a.narration, e.entity_code, gc.account_name, gc.statement_type,
                  al.debit_amount, al.credit_amount
           FROM adjustment_lines al
           JOIN adjustments a ON al.adjustment_id = a.adjustment_id
           JOIN periods p ON a.period_id = p.period_id
           JOIN group_coa gc ON al.group_account_id = gc.group_account_id
           LEFT JOIN entities e ON al.entity_id = e.entity_id
           WHERE a.period_id IN (?, ?)
                 AND (gc.account_name = ? OR gc.statement_type = 'PL')
           ORDER BY p.year, p.month, a.external_ref""",
        (current_period_id, prior_period_id, RE_ACCOUNT_NAME),
    ).fetchall()

    return [
        {
            "period_str": f"{r['year']}-{r['month']:02d}",
            "adjustment_id": r["adjustment_id"],
            "external_ref": r["external_ref"],
            "type": r["adjustment_type"],
            "status": r["status"],
            "narration": r["narration"],
            "entity_code": r["entity_code"],
            "category": r["account_name"],
            "statement_type": r["statement_type"],
            "debit": r["debit_amount"],
            "credit": r["credit_amount"],
        }
        for r in rows
    ]


def run(conn: sqlite3.Connection, current_period_id: int) -> RECheckResult:
    prior = period_repo.get_prior(conn, current_period_id)
    if prior is None:
        return RECheckResult(applicable=False, reason="No prior period exists", prior_period_str=None)

    prior_period_id = prior["period_id"]
    if not _period_has_consolidated_data(conn, prior_period_id):
        return RECheckResult(
            applicable=False,
            reason="Prior period has not been consolidated",
            prior_period_str=period_repo.as_str(prior),
        )

    re_prior = _re_closing_by_entity(conn, prior_period_id)
    re_current = _re_closing_by_entity(conn, current_period_id)
    profit_prior = _net_profit_by_entity(conn, prior_period_id)

    entity_ids = sorted(set(re_prior) | set(re_current) | set(profit_prior))
    entity_codes = {
        r["entity_id"]: r["entity_code"]
        for r in conn.execute("SELECT entity_id, entity_code FROM entities").fetchall()
    }

    rows = []
    for eid in entity_ids:
        rows.append(RECheckRow(
            entity_code=entity_codes.get(eid, str(eid)),
            re_closing_prior=re_prior.get(eid, 0.0),
            prior_net_profit=profit_prior.get(eid, 0.0),
            re_closing_current=re_current.get(eid, 0.0),
        ))
    rows.sort(key=lambda r: r.entity_code or "")

    # Group total row: every figure must come from a source that includes group-level
    # adjustments, or the gap is wrong by exactly those adjustments. Net profit uses
    # compute_pl and RE closing uses the 'total' row, so both tie to the P&L and BS pages.
    # The per-entity rows above necessarily exclude group-level adjustments -- those belong
    # to no entity -- so the entity rows will not add up to this row whenever any exist.
    _, group_prior_profit = compute_pl(conn, prior_period_id)
    group_row = RECheckRow(
        entity_code=None,
        re_closing_prior=_re_closing_group_total(conn, prior_period_id),
        prior_net_profit=group_prior_profit,
        re_closing_current=_re_closing_group_total(conn, current_period_id),
    )
    rows.append(group_row)

    linked = _linked_adjustments(conn, current_period_id, prior_period_id)

    return RECheckResult(
        applicable=True,
        reason=None,
        prior_period_str=period_repo.as_str(prior),
        rows=rows,
        linked_adjustments=linked,
    )
