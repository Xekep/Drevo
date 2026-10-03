import hashlib
import importlib.util
import io
import json
from contextlib import redirect_stdout
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

    def pair_archive(self):
        with tarfile.open(self.backup, "w:gz") as media:
            for name in ("uploads", "archives", "archives/tree-b",
                         "archives/tree-b/uploads"):
                directory = tarfile.TarInfo(name)
                directory.type = tarfile.DIRTYPE
                media.addfile(directory)
            for name, data in (
                ("uploads/one.jpg", b"abc"),
                ("archives/tree-b/uploads/two.pdf", b"file"),
                ("uploads/older.png", b"retained history"),
            ):
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                media.addfile(entry, io.BytesIO(data))
        self.seal()

    def pair_manifest(self, *rows):
        path = self.root / "restored-refs.jsonl"
        path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        return path

    def test_pair_matches_references_in_legacy_and_private_archive(self):
        self.pair_archive()
        manifest = self.pair_manifest(
            {"kind": "archive", "archive_id": "tree-a"},
            {"kind": "archive", "archive_id": "tree-b"},
            {"kind": "ref", "archive_id": "tree-a", "name": "one.jpg",
             "source": "person", "known_bytes": None},
            {"kind": "ref", "archive_id": "tree-a", "name": "one.jpg",
             "source": "image_metadata", "known_bytes": 3},
            {"kind": "ref", "archive_id": "tree-b", "name": "two.pdf",
             "source": "document", "known_bytes": 4},
        )
        result = verifier.verify_archive(
            self.backup, self.root, reserve_bytes=0,
            reference_manifest=manifest, legacy_archive_id="tree-a",
        )
        self.assertEqual(result.references_checked, 2)
        self.assertEqual(result.files, 3)  # Extra older original is allowed.
        self.assertEqual(list(self.root.glob("drevo-media-restore.*")), [])

    def test_pair_checks_citation_only_original(self):
        self.pair_archive()
        manifest = self.pair_manifest(
            {"kind": "archive", "archive_id": "tree-a"},
            {"kind": "archive", "archive_id": "tree-b"},
            {"kind": "ref", "archive_id": "tree-a", "name": "older.png",
             "source": "citation", "known_bytes": None},
        )
        result = verifier.verify_archive(
            self.backup, self.root, reserve_bytes=0,
            reference_manifest=manifest, legacy_archive_id="tree-a",
        )
        self.assertEqual(result.references_checked, 1)

        missing_manifest = self.pair_manifest(
            {"kind": "archive", "archive_id": "tree-a"},
            {"kind": "archive", "archive_id": "tree-b"},
            {"kind": "ref", "archive_id": "tree-a", "name": "missing.png",
             "source": "citation", "known_bytes": None},
        )
        with self.assertRaisesRegex(ValueError, "missing=1 wrong_size=0"):
            verifier.verify_archive(
                self.backup, self.root, reserve_bytes=0,
                reference_manifest=missing_manifest, legacy_archive_id="tree-a",
            )
        self.assertEqual(list(self.root.glob("drevo-media-restore.*")), [])

    def test_pair_rejects_missing_and_wrong_size_and_cleans_temp(self):
        self.pair_archive()
        manifest = self.pair_manifest(
            {"kind": "archive", "archive_id": "tree-a"},
            {"kind": "archive", "archive_id": "tree-b"},
            {"kind": "ref", "archive_id": "tree-a", "name": "missing.jpg",
             "source": "photo", "known_bytes": None},
            {"kind": "ref", "archive_id": "tree-b", "name": "two.pdf",
             "source": "document", "known_bytes": 5},
        )
        with self.assertRaisesRegex(ValueError, "missing=1 wrong_size=1"):
            verifier.verify_archive(
                self.backup, self.root, reserve_bytes=0,
                reference_manifest=manifest, legacy_archive_id="tree-a",
            )
        self.assertEqual(list(self.root.glob("drevo-media-restore.*")), [])

    def test_pair_infers_legacy_id_only_for_single_archive(self):
        self.pair_archive()
        manifest = self.pair_manifest(
            {"kind": "archive", "archive_id": "tree-a"},
            {"kind": "ref", "archive_id": "tree-a", "name": "one.jpg",
             "source": "person", "known_bytes": None},
        )
        result = verifier.verify_archive(
            self.backup, self.root, reserve_bytes=0, reference_manifest=manifest,
        )
        self.assertEqual(result.references_checked, 1)

        actual_verify = verifier.verify_archive
        output = io.StringIO()
        with patch.object(sys, "argv", [str(MODULE_PATH), str(self.backup),
                                        "--scratch-parent", str(self.root),
                                        "--reference-manifest", str(manifest)]), \
             patch.object(verifier, "verify_archive", side_effect=lambda archive, scratch, **options:
                          actual_verify(archive, scratch, reserve_bytes=0, **options)), \
             redirect_stdout(output):
            self.assertEqual(verifier.main(), 0)
        self.assertIn("RESTORE_PAIR_VERIFIED media=media-20261002T042000Z.tar.gz references=1",
                      output.getvalue())

    def test_pair_manifest_rejects_personal_fields_and_ambiguous_archive(self):
        self.pair_archive()
        manifest = self.pair_manifest(
            {"kind": "archive", "archive_id": "tree-a"},
            {"kind": "archive", "archive_id": "tree-b"},
            {"kind": "ref", "archive_id": "tree-a", "name": "one.jpg",
             "source": "person", "known_bytes": None, "person_name": "not allowed"},
        )
        with self.assertRaisesRegex(ValueError, "Invalid media reference"):
            verifier.verify_archive(
                self.backup, self.root, reserve_bytes=0,
                reference_manifest=manifest, legacy_archive_id="tree-a",
            )
        manifest = self.pair_manifest(
            {"kind": "archive", "archive_id": "tree-a"},
            {"kind": "archive", "archive_id": "tree-b"},
        )
        with self.assertRaisesRegex(ValueError, "Specify the legacy archive ID"):
            verifier.verify_archive(
                self.backup, self.root, reserve_bytes=0, reference_manifest=manifest,
            )

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

    def test_multiple_files_are_restored_from_forward_only_tar_stream(self):
        payloads = {
            "uploads/one.jpg": b"one",
            "uploads/large.bin": b"x" * (1024 * 1024 + 17),
            "archives/tree-b/uploads/two.pdf": b"two",
        }
        with tarfile.open(self.backup, "w:gz") as media:
            for name in ("uploads", "archives", "archives/tree-b",
                         "archives/tree-b/uploads"):
                directory = tarfile.TarInfo(name)
                directory.type = tarfile.DIRTYPE
                media.addfile(directory)
            for name, payload in payloads.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(payload)
                media.addfile(entry, io.BytesIO(payload))
        self.seal()

        class ForwardOnly:
            def __init__(self, source):
                self.source = source

            def read(self, size=-1):
                return self.source.read(size)

            def seek(self, *args):
                raise AssertionError("tar stream attempted random seek")

        actual_open = tarfile.open

        def open_forward_only(*args, **kwargs):
            self.assertEqual(kwargs["mode"], "r|gz")
            kwargs["fileobj"] = ForwardOnly(kwargs["fileobj"])
            return actual_open(*args, **kwargs)

        with patch.object(verifier.tarfile, "open", side_effect=open_forward_only):
            result = self.verify()
        self.assertEqual(result.files, len(payloads))
        self.assertEqual(result.bytes, sum(map(len, payloads.values())))
        self.assertEqual(list(self.root.glob("drevo-media-restore.*")), [])
        with patch.object(verifier.shutil, "disk_usage", return_value=SimpleNamespace(free=3)):
            with self.assertRaisesRegex(ValueError, "Insufficient free space"):
                self.verify()
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
