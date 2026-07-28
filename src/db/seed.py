import json
from pathlib import Path

from src.db.repositories import entity_repo, group_coa_repo

CONFIG_DIR = Path(__file__).parent.parent.parent / "config"


def seed_entities(conn) -> None:
    settings = json.loads((CONFIG_DIR / "app_settings.json").read_text(encoding="utf-8"))
    for i, entity in enumerate(settings["entities"]):
        entity_repo.upsert(conn, entity["code"], entity["name"], sort_order=i)
    conn.commit()


def seed_group_coa(conn) -> None:
    rows = json.loads((CONFIG_DIR / "group_coa_fixed.json").read_text(encoding="utf-8"))
    group_coa_repo.seed_from_json(conn, rows)
    conn.commit()


def seed_all(conn) -> None:
    seed_entities(conn)
    seed_group_coa(conn)
