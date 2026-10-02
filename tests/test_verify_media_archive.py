import hashlib
import importlib.util
import io
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "ops/postgres/verify-media-archive.py"
SPEC = importlib.util.spec_from_file_location("verify_media_archive", MODULE_PATH)
verifier = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = verifier
SPEC.loader.exec_module(verifier)


class MediaRestoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.backup = self.root / "media-20261002T042000Z.tar.gz"

    def seal(self):
        digest = hashlib.sha256(self.backup.read_bytes()).hexdigest()
        (self.root / (self.backup.name + ".sha256")).write_text(
            f"{digest}  {self.backup.name}\n", encoding="ascii"
        )

    def verify(self):
        return verifier.verify_archive(self.backup, self.root, reserve_bytes=0)

    def test_restore_checks_saved_snapshot_after_live_media_changes(self):
        live = self.root / "live"
        (live / "uploads").mkdir(parents=True)
        (live / "archives/tree-b/uploads").mkdir(parents=True)
        (live / "uploads/one.jpg").write_bytes(b"legacy image")
        (live / "archives/tree-b/uploads/two.pdf").write_bytes(b"private document")
        subprocess.run(
            ["tar", "--exclude=uploads/.*", "--exclude=archives/*/uploads/.*",
             "-C", str(live), "-czf", str(self.backup), "--",
             "uploads", "archives/tree-b/uploads"],
            check=True,
        )
        self.seal()

        (live / "uploads/later.jpg").write_bytes(b"new upload after backup")
        (live / "archives/tree-c/uploads").mkdir(parents=True)
        result = self.verify()
        self.assertEqual(result.files, 2)
        self.assertEqual(result.bytes, len(b"legacy image") + len(b"private document"))
        self.assertGreaterEqual(result.restore_seconds, 0)
        self.assertGreaterEqual(result.ready_seconds, result.restore_seconds)
        self.assertEqual(list(self.root.glob("drevo-media-restore.*")), [])

    def test_corrupt_archive_fails_before_extraction(self):
        with tarfile.open(self.backup, "w:gz") as media:
            directory = tarfile.TarInfo("uploads")
            directory.type = tarfile.DIRTYPE
            media.addfile(directory)
            file = tarfile.TarInfo("uploads/one.jpg")
            file.size = 3
            media.addfile(file, io.BytesIO(b"abc"))
        self.seal()
        with self.backup.open("ab") as output:
            output.write(b"changed")
        with self.assertRaisesRegex(ValueError, "checksum does not match"):
            self.verify()
        self.assertEqual(list(self.root.glob("drevo-media-restore.*")), [])

    def test_links_and_parent_traversal_are_rejected(self):
        for unsafe in ("uploads/link.jpg", "uploads/../outside.jpg"):
            with self.subTest(path=unsafe):
                with tarfile.open(self.backup, "w:gz") as media:
                    directory = tarfile.TarInfo("uploads")
                    directory.type = tarfile.DIRTYPE
                    media.addfile(directory)
                    entry = tarfile.TarInfo(unsafe)
                    if unsafe.endswith("link.jpg"):
                        entry.type = tarfile.SYMTYPE
                        entry.linkname = "../outside"
                    else:
                        entry.size = 3
                    media.addfile(entry, None if entry.issym() else io.BytesIO(b"abc"))
                self.seal()
                with self.assertRaisesRegex(ValueError, "Unsafe|link or special"):
                    self.verify()
                self.assertEqual(list(self.root.glob("drevo-media-restore.*")), [])

    def test_untrusted_checksum_and_insufficient_space_fail_closed(self):
        with tarfile.open(self.backup, "w:gz") as media:
            directory = tarfile.TarInfo("uploads")
            directory.type = tarfile.DIRTYPE
            media.addfile(directory)
            file = tarfile.TarInfo("uploads/one.jpg")
            file.size = 3
            media.addfile(file, io.BytesIO(b"abc"))
        self.seal()
        checksum = self.root / (self.backup.name + ".sha256")
        checksum.write_text("incorrect\n", encoding="ascii")
        with self.assertRaisesRegex(ValueError, "Invalid media backup checksum"):
            self.verify()
        self.seal()
        with patch.object(verifier.shutil, "disk_usage", return_value=SimpleNamespace(free=2)):
            with self.assertRaisesRegex(ValueError, "Insufficient free space"):
                self.verify()


if __name__ == "__main__":
    unittest.main()
