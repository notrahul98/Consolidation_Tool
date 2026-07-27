from pathlib import Path

import pytest

from src.db.database import get_connection
from src.db.seed import seed_all
from src.db.repositories import entity_repo, period_repo, tb_repo, mapping_repo
from src.importers.tally_tb_parser import parse_file
from src.engines.consolidation_engine import consolidate_period

FIXTURES_DIR = Path(__file__).parent / "fixtures"

ENTITY_FILES = {
    "BII": "TB BII Jun 26.xlsx",
    "KDI": "TB KDI V4.xlsx",
    "KNS": "TB KNS V3.xlsx",
    "VKS": "TB VKS June 26.xlsx",
}

MAY_ENTITY_FILES = {
    "BII": "TB Bahan May 26 MTD.xlsx",
    "KDI": "TB KDI May 26 MTD.xlsx",
    "KNS": "TB KNS May 26 MTD V2.xlsx",
    "VKS": "TB VKS May 26 MTD V2.xlsx",
}

# NOTE: this maps by ledger name *globally* across all 4 entities (unlike production's
# entity-aware mapping applied from "Mapping from File.xlsx"), so figures computed against
# this fixture can differ slightly from the real Consolidated Pack for ledger names that
# are booked differently per entity (e.g. "12% Interest on Shareholders Loan A/c" is a P&L
# expense for VKS but a tiny BS residual for KDI in production — both get the P&L category
# here). Don't hardcode production figures against tests using this mapping; assert against
# what the engine itself computes for the fixture instead.
#
# A full categorization of every distinct ledger across the 4 real fixtures, used to
# exercise consolidation/validation end-to-end without a human at the keyboard.
FULL_MAPPING = {
    "12% Interest on Shareholders Loan A/c": "Interest on  Shareholder loan",
    "2019 Adj Ledger": "Other Receivables",
    "AKUMULASI PENYUSUTAN INVENTARIS": "Accumulated Depreciation",
    "AKUMULASI PENYUSUTAN KENDARAAN": "Accumulated Depreciation",
    "AR Interco": "Interco Balances",
    "Account Payable": "Accounts Payable",
    "Account Receivable": "Accounts Receivable",
    "Accumulated Depreciation Inventries": "Accumulated Depreciation",
    "Advance From Customers": "Accrued Expenses",
    "Advance Tax PPH 25": "Prepaid Taxes",
    "Advance to Foreign Suppliers": "Other Receivables",
    "BII Interco": "Interco Balances",
    "BMS": "Accrued Expenses",
    "BPJSKES - Company Payable": "Accrued Expenses",
    "BPJSKES - Employee Payable": "Accrued Expenses",
    "BPJSTK - Company Payable": "Accrued Expenses",
    "BPJSTK - Employee Payable": "Accrued Expenses",
    "BPOM Biaya Perijinan Produk (SNI,BPOM,Etc)": "Direct Costs",
    "Bahan Indah Indonesia Inter Co": "Interco Balances",
    "Bank Accounts": "Cash & Cash Equivalent",
    "Bank Charges": "Bank Charges",
    "Bank OD A/c": "Loans & Advances taken",
    "Biaya BPJSKES": "Staff Insurance",
    "Biaya BPJSTK": "Staff Insurance",
    "Biaya Bank Charges": "Bank Charges",
    "Biaya Bank and Admin Charges": "Bank Charges",
    "Biaya Bonus & THR": "Bonus & Incentives",
    "Biaya Clearance & Freight Cost": "Direct Costs",
    "Biaya Consulting & Professional Fee": "Consulting & Professional Fee",
    "Biaya Depreciation-Office Inventories": "Depreciation",
    "Biaya Electricity & Water": "Electricity Expense",
    "Biaya Entertainment": "Entertainment",
    "Biaya Insurance": "General Insurance Expense",
    "Biaya Interest on Bank Loan": "Interest Expense",
    "Biaya JNE/ Courier/Expedisi/Transport": "Postage & Courier Expenses",
    "Biaya Marketing": "Advertising Expense",
    "Biaya Marketing Beauty": "Advertising Expense",
    "Biaya Materai": "Office Expenses",
    "Biaya Office Expenses": "Office Expenses",
    "Biaya Packing - Warehouse": "Packaging and Labeling",
    "Biaya Printing & Stationary": "Printing & Stationery",
    "Biaya Rental Office & Warehouse": "Rent Expense",
    "Biaya Repairs & Maintenance": "Repairs & Maintenance",
    "Biaya Salary": "Salaries & Wages",
    "Biaya Salary - Consultancy": "Consulting & Professional Fee",
    "Biaya Sample": "Sample Expenses",
    "Biaya Telephone & Internet": "Telephone Expense",
    "Biaya Transport ( Petrol,Parking,Toll )": "Transport Expense",
    "Biaya Travelling Expenses": "Travel Expense - Domestic",
    "Biaya Vehicle Maintenance": "Repairs & Maintenance",
    "Biaya Warehouse Expenses": "Warehouse Expense",
    "Biaya Warehouse Transport": "Warehouse Expense",
    "Cash-in-Hand": "Cash & Cash Equivalent",
    "Deposits (Asset)": "Short Term Deposits",
    "Gudang Cikokol Renovation": "Fixed Assets",
    "HUTANG LAIN-LAIN": "Accrued Expenses",
    "Head Office KDI": "Interco Balances",
    "Hutang Bank / Leasing": "Loans & Advances taken",
    "Hutang Pajak": "Taxes Payable",
    "Hutang Pemegang Saham": "Loans & Advances taken",
    "INVENTARIS": "Fixed Assets",
    "Import Duty (Bea Masuk)": "Direct Costs",
    "KDI Inter Co": "Interco Balances",
    "KENDARAAN": "Fixed Assets",
    "Kreasi Inter Co": "Interco Balances",
    "Loan From Sunrise": "Loans & Advances taken",
    "Loans & Advances (Asset)-VKS": "Interco Balances",
    "Loans & Advances (Interco Batik )": "Interco Balances",
    "Loans & Advances Inter Co( Batik )": "Interco Balances",
    "MR.Prakash Share Capital": "Share Capital",
    "Mining Inter Co": "Interco Balances",
    "Modal Disetor": "Share Capital",
    "Mr. Deepak Share Capital": "Share Capital",
    "Mr. Dilip Share Capital": "Share Capital",
    "Mr.Deepak Share Capital": "Share Capital",
    "Mr.Dilip Share Capital": "Share Capital",
    "Mr.Prakash Share Capital": "Share Capital",
    "Opening Stock": "Inventory",
    "Other Direct Expenses": "Direct Costs",
    "Other Income": "Other Income",
    "PT Fatahillah Makmur Inter Co": "Interco Balances",
    "PT Garuda Chindo Inter Co": "Interco Balances",
    "PT Hasilindo Sukses Inter Co": "Interco Balances",
    "Pajak Dibayar Dimuka": "Prepaid Taxes",
    "Piutang Lain-Lain": "Other Receivables",
    "Porto Valas Pt (Sunrise)": "Other Receivables",
    "Prepaid Expenses": "Prepaid Expenses",
    "Prepaid Taxes": "Prepaid Taxes",
    "Profit & Loss A/c": "Retained Earnings",
    "Provisi Bank": "Bank Charges",
    "Provision for Expenses": "Accrued Expenses",
    "Provisions": "Accrued Expenses",
    "Purchase Intercompany": "Direct Costs",
    "Purchase Sachajuan": "Direct Costs",
    "ROUND OFF": "Misc. Expense",
    "Rental Staff Apartment": "Rent Expense",
    "Retur Sales": "Sales Discount/Return",
    "Sales": "Sales",
    "Share Holders Loan": "Loans & Advances taken",
    "Shareholder Loan": "Loans & Advances taken",
    "Sundry Creditors": "Accounts Payable",
    "Sundry Debtors": "Accounts Receivable",
    "Tax Payable": "Taxes Payable",
    "Uang  Muka  Pembelian Barang Dagangan": "Other Receivables",
    "VKS Inter Co": "Interco Balances",
    # May-specific ledger-name variants (Tally's naming drifts month to month).
    "Loans & Advances (Interco Batik )": "Interco Balances",
    "Biaya BPJS": "Staff Insurance",
    "Biaya Documentation & Visa Charges": "Staff Welfare",
    "Biaya Forex Gain/Loss": "Foreign Exchange (Gain) Loss",
    "Biaya Tax Expenses": "Tax Expenses",
}


@pytest.fixture
def conn(tmp_path):
    db_path = tmp_path / "test.db"
    c = get_connection(str(db_path))
    seed_all(c)
    yield c
    c.close()


def import_all_entities(conn, period_str="2026-06", files=None):
    period_id = period_repo.get_or_create(conn, *period_repo.parse_period_str(period_str))
    for code, filename in (files or ENTITY_FILES).items():
        entity = entity_repo.get_by_code(conn, code)
        parsed = parse_file(str(FIXTURES_DIR / filename))
        tb_repo.import_tb(conn, period_id, entity["entity_id"], parsed, imported_by="test")
    mapping_repo.ensure_rows_exist(conn, period_id)
    conn.commit()
    return period_id


def categorize_all(conn, ledger_to_category=FULL_MAPPING, user="test"):
    from src.db.repositories import group_coa_repo
    for ledger_name, category_name in ledger_to_category.items():
        row = group_coa_repo.get_by_name(conn, category_name)
        assert row is not None, f"Unknown fixed category: {category_name}"
        mapping_repo.apply_mapping(conn, ledger_name, row["group_account_id"], user=user)
    conn.commit()


@pytest.fixture
def consolidated(conn):
    period_id = import_all_entities(conn)
    categorize_all(conn)
    result = consolidate_period(conn, period_id)
    conn.commit()
    return conn, period_id, result


@pytest.fixture
def two_periods(conn):
    """May 2026 (prior) and June 2026 (current), both imported, categorized, and
    consolidated — for exercising copy-prior-month against two real periods."""
    may_id = import_all_entities(conn, "2026-05", files=MAY_ENTITY_FILES)
    june_id = import_all_entities(conn, "2026-06")
    categorize_all(conn)
    may_result = consolidate_period(conn, may_id)
    june_result = consolidate_period(conn, june_id)
    conn.commit()
    assert not may_result["blocked"], may_result["unmapped_material"]
    assert not june_result["blocked"], june_result["unmapped_material"]
    return conn, may_id, june_id
