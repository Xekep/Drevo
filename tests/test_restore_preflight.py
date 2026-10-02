import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "ops/postgres/restore-preflight.py"
SPEC = importlib.util.spec_from_file_location("restore_preflight", MODULE_PATH)
preflight = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preflight)


class RestorePreflightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.database = "drevo_archive_20260928_123456"
        self.pgdata = self.root / "pgdata"
        self.pgdata.mkdir()

    def check(self, *, current_kib=1024, backup_bytes=2 * 1024**3, free_bytes=12 * 1024**3, status=0):
        info = [{"status": {"code": status}, "backup": [
            {"timestamp": {"stop": 10}, "info": {"size": 1024}},
            {"timestamp": {"stop": 20}, "info": {"size": backup_bytes}},
        ]}]
        calls = [
            subprocess.CompletedProcess([], 0, f"{current_kib}\t{self.pgdata}\n", ""),
            subprocess.CompletedProcess([], 0, json.dumps(info), ""),
        ]
        with patch.object(preflight.subprocess, "run", side_effect=calls) as run, patch.object(
            preflight.shutil, "disk_usage", return_value=SimpleNamespace(free=free_bytes)
        ):
            result = preflight.check_capacity(self.database, self.pgdata, self.root)
        self.assertEqual(run.call_count, 2)
        return result

    def test_accepts_exact_production_marker_and_larger_backup(self):
        self.assertEqual(self.check(), "drevo_archive_20260928_123456")

    def test_rejects_migration_database_even_with_space(self):
        self.database = "drevo_migration"
        with self.assertRaisesRegex(ValueError, "production archive"):
            self.check()

    def test_rejects_space_below_backup_plus_reserve(self):
        with self.assertRaisesRegex(ValueError, "Not enough free space"):
            self.check(free_bytes=10 * 1024**3 - 1)

    def test_rejects_space_below_current_cluster_plus_reserve(self):
        with self.assertRaisesRegex(ValueError, "Not enough free space"):
            self.check(current_kib=3 * 1024**2, free_bytes=10 * 1024**3)

    def test_rejects_unhealthy_repository(self):
        with self.assertRaisesRegex(ValueError, "no healthy backup"):
            self.check(status=1)


if __name__ == "__main__":
    unittest.main()
