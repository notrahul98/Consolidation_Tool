from src.db.repositories import mapping_repo, group_coa_repo
from tests.conftest import import_all_entities


def test_ledgers_start_unmapped(conn):
    period_id = import_all_entities(conn)
    ledgers = mapping_repo.distinct_ledgers_for_period(conn, period_id)
    assert len(ledgers) > 0
    assert all(len(l["group_account_ids"]) == 0 for l in ledgers)


def test_same_ledger_name_flagged_when_primary_group_differs(conn):
    period_id = import_all_entities(conn)
    ledgers = {l["ledger_name"]: l for l in mapping_repo.distinct_ledgers_for_period(conn, period_id)}
    interest = ledgers["12% Interest on Shareholders Loan A/c"]
    assert len(interest["primary_groups"]) > 1  # Current Liabilities (KDI) vs Indirect Expenses (VKS)


def test_apply_mapping_applies_to_every_entity_with_that_ledger(conn):
    period_id = import_all_entities(conn)
    category = group_coa_repo.get_by_name(conn, "Interco Balances")
    affected = mapping_repo.apply_mapping(conn, "Kreasi Inter Co", category["group_account_id"], user="test")
    assert affected >= 2  # Kreasi Inter Co appears in BII, KDI, and VKS

    ledgers = {l["ledger_name"]: l for l in mapping_repo.distinct_ledgers_for_period(conn, period_id)}
    assert ledgers["Kreasi Inter Co"]["group_account_ids"] == {category["group_account_id"]}


def test_import_mapping_workbook_round_trip(conn, tmp_path):
    from src.exporters.mapping_workbook import export_mapping_workbook, import_mapping_workbook
    import openpyxl

    period_id = import_all_entities(conn)
    out_path = tmp_path / "Mapping.xlsx"
    export_mapping_workbook(conn, period_id, str(out_path))

    wb = openpyxl.load_workbook(out_path)
    ws = wb["Mapping"]
    for row in range(2, ws.max_row + 1):
        if ws.cell(row=row, column=1).value == "Sales":
            ws.cell(row=row, column=6, value="Sales")
    wb.save(out_path)

    applied = import_mapping_workbook(conn, str(out_path), user="test")
    assert applied == 1
    row = mapping_repo.get_mapping(conn, conn.execute(
        "SELECT entity_id FROM entities WHERE entity_code = 'KNS'"
    ).fetchone()["entity_id"], "Sales")
    assert row["mapping_status"] == "mapped"
