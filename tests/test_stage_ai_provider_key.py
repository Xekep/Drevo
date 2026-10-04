"""The deploy preflight must stage a private, matching platform key pair."""

from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "ops/postgres/stage-ai-provider-key.py"
NAME = "ai-provider-cleanup.v1.key"


@unittest.skipIf(sys.platform == "win32", "Unix file modes are required by the deploy helper")
class StageAiProviderKeyTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.shared = self.root / "shared"
        self.stage = self.root / "stage"
        (self.shared / "backups/platform-keys").mkdir(parents=True)
        self.stage.mkdir(mode=0o700)
        self.primary = self.shared / NAME
        self.backup = self.shared / "backups/platform-keys" / NAME
        self.primary.write_bytes(b'{"version":1,"key":"fixture"}')
        self.backup.write_bytes(self.primary.read_bytes())
        self.primary.chmod(0o600)
        self.backup.chmod(0o600)

    def run_helper(self):
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(self.shared), str(self.stage)],
            capture_output=True, text=True, check=False,
        )

    def test_stages_both_private_matching_copies(self):
        result = self.run_helper()
        self.assertEqual(result.returncode, 0, result.stderr)
        staged = self.stage / NAME
        staged_backup = self.stage / "backups/platform-keys" / NAME
        self.assertEqual(staged.read_bytes(), self.primary.read_bytes())
        self.assertEqual(staged_backup.read_bytes(), self.primary.read_bytes())
        for path in (staged, staged_backup):
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertNotIn("fixture", result.stdout + result.stderr)

    def test_rejects_missing_wrong_large_or_exposed_key_without_copying(self):
        cases = (
            lambda: self.backup.unlink(),
            lambda: self.backup.write_bytes(b"wrong"),
            lambda: self.primary.write_bytes(b"x" * 4097),
            lambda: self.primary.chmod(0o644),
        )
        for mutate in cases:
            with self.subTest(mutate=mutate):
                self.setUp()
                mutate()
                result = self.run_helper()
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.stage / NAME).exists())
                self.assertNotIn("fixture", result.stdout + result.stderr)

    def test_rejects_symlinked_source(self):
        self.backup.unlink()
        self.backup.symlink_to(self.primary)
        result = self.run_helper()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.stage / NAME).exists())


if __name__ == "__main__":
    unittest.main()
