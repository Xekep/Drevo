import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class ReleaseIdentityTests(unittest.TestCase):
    commit = "a" * 40
    script = Path(__file__).resolve().parents[1] / "ops" / "read-release-id.py"

    def read_identity(self, metadata, expected_commit=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "release.json"
            path.write_text(json.dumps(metadata), encoding="utf-8")
            return subprocess.run(
                [sys.executable, "-B", str(self.script), str(path),
                 expected_commit if expected_commit is not None else self.commit],
                capture_output=True, text=True, check=False,
            )

    def test_reused_artifact_keeps_its_build_attempt(self):
        result = self.read_identity({"releaseId": self.commit + "-1"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "release_id=" + self.commit + "-1\n")

    def test_another_commits_artifact_is_rejected(self):
        result = self.read_identity({"releaseId": "b" * 40 + "-1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_invalid_metadata_cannot_write_workflow_outputs(self):
        for metadata in [None, [], {}, {"releaseId": 1},
                         {"releaseId": self.commit + "-0"},
                         {"releaseId": self.commit + "-1\ninjected=value"}]:
            with self.subTest(metadata=metadata):
                result = self.read_identity(metadata)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")

    def test_invalid_expected_commit_is_rejected(self):
        result = self.read_identity({"releaseId": self.commit + "-1"}, "main")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_missing_or_corrupt_metadata_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "release.json"
            for content in [None, "{broken"]:
                with self.subTest(content=content):
                    if content is not None:
                        path.write_text(content, encoding="utf-8")
                    result = subprocess.run(
                        [sys.executable, "-B", str(self.script), str(path), self.commit],
                        capture_output=True, text=True, check=False,
                    )
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
