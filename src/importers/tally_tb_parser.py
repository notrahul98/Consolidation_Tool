"""Parses a Tally trial balance Excel export.

Key real-data findings this parser encodes (see the Phase 1 plan for detail):
- Opening/Closing are single columns, but each cell's Dr/Cr side is tagged in that
  cell's Excel *number format* string (e.g. '""#,000" Dr"'), not in the value or a
  separate column, and not reliably inferable from the ledger's parent group (a ledger's
  Opening and Closing tag can even differ from each other on the same row).
- A row is a group/subtotal ("skip for ledger import") if its Particulars cell is bold;
  a real postable ledger is not bold. Indent level is not a reliable leaf/group signal.
- The bold, indent-0 ancestor name is tracked as a mapping hint only, never for sign.
"""

import hashlib
import re
from dataclasses import dataclass, field

import openpyxl

from src.importers.column_detector import detect

TOLERANCE_IDR = 1
_DRCR_RE = re.compile(r'"\s*(Dr|Cr)"\s*$')


def extract_dr_cr(number_format: str | None) -> str | None:
    if not number_format:
        return None
    m = _DRCR_RE.search(number_format)
    return m.group(1).upper() if m else None


@dataclass
class ParsedLine:
    entity_ledger_name: str
    tally_primary_group: str | None
    opening_dr: float
    opening_cr: float
    period_dr: float
    period_cr: float
    closing_dr: float
    closing_cr: float
    closing_tie_warning: bool


@dataclass
class ParsedTB:
    source_filename: str
    checksum: str
    lines: list[ParsedLine] = field(default_factory=list)
    grand_total_period_dr: float = 0.0
    grand_total_period_cr: float = 0.0
    warnings: list[str] = field(default_factory=list)


def _to_float(value) -> float:
    """Some entities' TB exports store numeric cells as text strings, not real
    numbers (observed in TB BII / TB VKS but not TB KDI / TB KNS) — coerce defensively."""
    if value is None or value == "":
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return float(str(value).replace(",", "").strip())


def _signed(value: float, side: str | None) -> float:
    if not value or side is None:
        return 0.0
    return value if side == "DR" else -value


def _read_line(name: str, row: int, opening_cell, debit_cell, credit_cell, closing_cell,
               tally_primary_group: str | None, warnings: list[str]) -> ParsedLine:
    opening_val = _to_float(opening_cell.value)
    opening_side = extract_dr_cr(opening_cell.number_format)
    closing_val = _to_float(closing_cell.value)
    closing_side = extract_dr_cr(closing_cell.number_format)
    period_dr = _to_float(debit_cell.value)
    period_cr = _to_float(credit_cell.value)

    opening_dr = opening_val if opening_side == "DR" else 0.0
    opening_cr = opening_val if opening_side == "CR" else 0.0
    closing_dr = closing_val if closing_side == "DR" else 0.0
    closing_cr = closing_val if closing_side == "CR" else 0.0

    if opening_val and opening_side is None:
        warnings.append(f"Row {row} ({name}): opening balance has no Dr/Cr tag")
    if closing_val and closing_side is None:
        warnings.append(f"Row {row} ({name}): closing balance has no Dr/Cr tag")

    signed_opening = _signed(opening_val, opening_side)
    signed_closing = _signed(closing_val, closing_side)
    implied_closing = signed_opening + period_dr - period_cr
    tie_warning = abs(implied_closing - signed_closing) > TOLERANCE_IDR
    if tie_warning:
        warnings.append(f"Row {row} ({name}): implied closing {implied_closing} vs exported {signed_closing}")

    return ParsedLine(
        entity_ledger_name=name,
        tally_primary_group=tally_primary_group,
        opening_dr=opening_dr,
        opening_cr=opening_cr,
        period_dr=period_dr,
        period_cr=period_cr,
        closing_dr=closing_dr,
        closing_cr=closing_cr,
        closing_tie_warning=tie_warning,
    )


def parse_file(path: str) -> ParsedTB:
    """A bold row is normally a group/subtotal that gets skipped in favor of its
    (non-bold) children. But Tally sometimes gives a group its own balance with
    *zero* children underneath it (observed: 'Unadjusted Forex Gain/Loss' in a real
    May 2026 export) — skipping those loses real money. A pending bold row is only
    discarded once an actual child row confirms it was a genuine subtotal; if the
    next thing seen is another bold row or Grand Total instead, the pending row is
    emitted as a leaf in its own right, using its own name as the ledger name."""
    with open(path, "rb") as f:
        checksum = hashlib.sha256(f.read()).hexdigest()

    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb[wb.sheetnames[0]]
    layout = detect(ws)

    result = ParsedTB(source_filename=path, checksum=checksum)
    current_top_group: str | None = None
    pending_group: tuple[str, int, object, object, object, object, str | None] | None = None

    def resolve_pending_as_leaf():
        if pending_group is None:
            return
        name, row, opening_cell, debit_cell, credit_cell, closing_cell, group_ctx = pending_group
        result.lines.append(
            _read_line(name, row, opening_cell, debit_cell, credit_cell, closing_cell,
                       group_ctx, result.warnings)
        )

    for row in range(layout.data_start_row, ws.max_row + 1):
        name_cell = ws.cell(row=row, column=layout.particulars_col)
        name = name_cell.value
        if name is None or str(name).strip() == "":
            continue
        name = str(name).strip()

        opening_cell = ws.cell(row=row, column=layout.opening_col)
        debit_cell = ws.cell(row=row, column=layout.period_debit_col)
        credit_cell = ws.cell(row=row, column=layout.period_credit_col)
        closing_cell = ws.cell(row=row, column=layout.closing_col)

        is_bold = bool(name_cell.font and name_cell.font.bold)
        indent = name_cell.alignment.indent if name_cell.alignment else 0

        if name.lower() == "grand total":
            resolve_pending_as_leaf()
            pending_group = None
            result.grand_total_period_dr = _to_float(debit_cell.value)
            result.grand_total_period_cr = _to_float(credit_cell.value)
            continue

        if is_bold:
            resolve_pending_as_leaf()  # previous pending group had no children after all
            group_ctx_for_pending = current_top_group if indent != 0 else name
            pending_group = (name, row, opening_cell, debit_cell, credit_cell, closing_cell, group_ctx_for_pending)
            if indent == 0:
                current_top_group = name
            continue

        pending_group = None  # this leaf confirms the last bold row was a genuine subtotal
        result.lines.append(
            _read_line(name, row, opening_cell, debit_cell, credit_cell, closing_cell,
                       current_top_group, result.warnings)
        )

    resolve_pending_as_leaf()  # file ended with a still-pending childless group
    return result
