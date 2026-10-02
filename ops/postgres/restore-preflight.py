#!/usr/bin/env python3
"""Fail closed before expanding a local physical backup on the production disk."""

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

RESERVE_BYTES = 8 * 1024**3
DATABASE_RE = re.compile(r"drevo_archive_[0-9]{8}_[0-9]{6}\Z")


def check_capacity(database: str, pgdata: Path, work_root: Path) -> str:
    if not DATABASE_RE.fullmatch(database):
        raise ValueError("Expected database is not a production archive database")
    if not pgdata.is_dir() or not work_root.is_dir():
        raise ValueError("PostgreSQL data or restore directory is missing")
    result = subprocess.run(
        ["du", "-sk", "--", str(pgdata)],
        check=True,
        capture_output=True,
        text=True,
    )
    used_kib = int(result.stdout.split()[0])
    if used_kib <= 0:
        raise ValueError("Cannot measure PostgreSQL data size")
    info = subprocess.run(
        ["pgbackrest", "--stanza=drevo", "--output=json", "info"],
        check=True,
        capture_output=True,
        text=True,
    )
    stanzas = json.loads(info.stdout)
    if len(stanzas) != 1 or stanzas[0]["status"]["code"] != 0 or not stanzas[0]["backup"]:
        raise ValueError("pgBackRest repository has no healthy backup")
    latest = max(stanzas[0]["backup"], key=lambda backup: backup["timestamp"]["stop"])
    backup_bytes = latest["info"]["size"]
    if not isinstance(backup_bytes, int) or backup_bytes <= 0:
        raise ValueError("Cannot measure backup restore size")
    free_bytes = shutil.disk_usage(work_root).free
    if free_bytes < max(used_kib * 1024, backup_bytes) + RESERVE_BYTES:
        raise ValueError("Not enough free space for a second cluster plus 8 GiB reserve")
    return database


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit("Usage: restore-preflight.py <database> <PGDATA> <restore-root>")
    try:
        print(check_capacity(sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])))
    except (OSError, ValueError, KeyError, IndexError, TypeError, subprocess.CalledProcessError) as error:
        sys.exit(f"Physical restore preflight failed: {error}")
