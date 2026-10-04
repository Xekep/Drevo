#!/usr/bin/env python3
"""Rehearse extraction of one immutable Drevo media backup."""

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tarfile
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path


BACKUP_NAME = re.compile(r"media-\d{8}T\d{6}Z\.tar\.gz\Z")
ARCHIVE_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9-]{2,63}\Z")
FILE_NAME = re.compile(r"[a-zA-Z0-9-]+\.(?:jpg|png|webp|gif|tif|pdf)\Z")
REFERENCE_SOURCES = frozenset({
    "person", "photo", "history", "citation", "upload_grant", "image_metadata", "document",
    "restore_stage_image", "restore_stage_document",
})
DISK_RESERVE = 8 * 1024**3
PLATFORM_KEY_PATHS = frozenset({
    ("ai-provider-cleanup.v1.key",),
    ("backups", "platform-keys", "ai-provider-cleanup.v1.key"),
})


@dataclass(frozen=True)
class RestoreResult:
    files: int
    bytes: int
    checksum_seconds: float
    restore_seconds: float
    ready_seconds: float
    references_checked: int = 0


def read_references(
    manifest: Path, legacy_archive_id: str | None
) -> tuple[dict[tuple[str, ...], int | None], str | None]:
    if not stat.S_ISREG(manifest.lstat().st_mode):
        raise ValueError("Reference manifest is not a regular file")
    archives: set[str] = set()
    references: list[tuple[str, str, int | None]] = []
    platform_key: str | None = None
    with manifest.open("r", encoding="utf-8") as source:
        for number, line in enumerate(source, 1):
            try:
                row = json.loads(line)
            except (json.JSONDecodeError, UnicodeError) as error:
                raise ValueError(f"Invalid reference manifest line {number}") from error
            if isinstance(row, dict) and row.get("kind") == "platform_key":
                if set(row) != {"kind", "version", "fingerprint"} or row["version"] != 1 \
                        or not isinstance(row["fingerprint"], str) \
                        or not re.fullmatch(r"[a-f0-9]{64}", row["fingerprint"]) \
                        or platform_key is not None:
                    raise ValueError(f"Invalid platform key on manifest line {number}")
                platform_key = row["fingerprint"]
                continue
            if not isinstance(row, dict) or not isinstance(row.get("archive_id"), str) \
                    or not ARCHIVE_ID.fullmatch(row["archive_id"]):
                raise ValueError(f"Invalid archive ID on manifest line {number}")
            archive_id = row["archive_id"]
            if row.get("kind") == "archive":
                if set(row) != {"kind", "archive_id"}:
                    raise ValueError(f"Invalid archive row on manifest line {number}")
                if archive_id in archives:
                    raise ValueError(f"Duplicate archive on manifest line {number}")
                archives.add(archive_id)
                continue
            size = row.get("known_bytes")
            if set(row) != {"kind", "archive_id", "name", "source", "known_bytes"} \
                    or row.get("kind") != "ref" or not isinstance(row.get("name"), str) \
                    or not FILE_NAME.fullmatch(row["name"]) \
                    or not isinstance(row.get("source"), str) \
                    or row["source"] not in REFERENCE_SOURCES \
                    or (size is not None and (type(size) is not int or size <= 0)):
                raise ValueError(f"Invalid media reference on manifest line {number}")
            references.append((archive_id, row["name"], size))
    if legacy_archive_id is None:
        if len(archives) != 1:
            raise ValueError("Specify the legacy archive ID for a multi-archive restore")
        legacy_archive_id = next(iter(archives))
    if legacy_archive_id not in archives:
        raise ValueError("Legacy archive ID is absent from restored database")

    expected: dict[tuple[str, ...], int | None] = {}
    for archive_id, name, size in references:
        if archive_id not in archives:
            raise ValueError("Media reference belongs to an unknown archive")
        parts = ("uploads", name) if archive_id == legacy_archive_id else (
            "archives", archive_id, "uploads", name,
        )
        previous = expected.get(parts)
        if previous is not None and size is not None and previous != size:
            raise ValueError("Conflicting sizes in restored database")
        expected[parts] = size if size is not None else previous
    return expected, platform_key


def member_parts(member: tarfile.TarInfo) -> tuple[str, ...]:
    name = member.name.rstrip("/")
    parts = tuple(name.split("/"))
    if (
        not name
        or name.startswith("/")
        or "\\" in name
        or any(part in ("", ".", "..") for part in parts)
        or any(ord(character) < 32 for character in name)
    ):
        raise ValueError(f"Unsafe media archive path: {member.name!r}")
    if parts in PLATFORM_KEY_PATHS:
        if not member.isfile() or member.mode & 0o077:
            raise ValueError("AI cleanup key is not a private file")
    elif parts[0] == "uploads":
        if len(parts) == 1 and not member.isdir():
            raise ValueError("Legacy uploads root is not a directory")
    elif parts[0] == "archives":
        if len(parts) == 1:
            if not member.isdir():
                raise ValueError("Archive root is not a directory")
        elif not ARCHIVE_ID.fullmatch(parts[1]):
            raise ValueError(f"Invalid archive ID: {parts[1]!r}")
        elif len(parts) == 2:
            if not member.isdir():
                raise ValueError("Archive directory is not a directory")
        elif parts[2] != "uploads" or (len(parts) == 3 and not member.isdir()):
            raise ValueError(f"Unexpected media archive path: {member.name!r}")
    else:
        raise ValueError(f"Unexpected media archive path: {member.name!r}")
    if not (member.isdir() or member.isfile()):
        raise ValueError(f"Media archive contains a link or special file: {member.name!r}")
    return parts


def verify_archive(
    archive: Path, scratch_parent: Path, reserve_bytes: int = DISK_RESERVE,
    reference_manifest: Path | None = None, legacy_archive_id: str | None = None,
) -> RestoreResult:
    started = time.monotonic()
    if legacy_archive_id is not None and reference_manifest is None:
        raise ValueError("Legacy archive ID requires a reference manifest")
    pair = (
        read_references(reference_manifest, legacy_archive_id)
        if reference_manifest is not None else None
    )
    expected, expected_key = pair if pair is not None else (None, None)
    if not BACKUP_NAME.fullmatch(archive.name):
        raise ValueError("Invalid media backup name")
    sidecar = archive.with_name(archive.name + ".sha256")
    for path in (archive, sidecar):
        if not stat.S_ISREG(path.lstat().st_mode):
            raise ValueError(f"Backup or checksum is not a regular file: {path.name}")
    if sidecar.stat().st_size > 256:
        raise ValueError("Invalid media backup checksum")
    checksum = re.fullmatch(
        rf"([a-f0-9]{{64}})  {re.escape(archive.name)}\n?",
        sidecar.read_text(encoding="ascii"),
    )
    if checksum is None:
        raise ValueError("Invalid media backup checksum")
    if not scratch_parent.is_dir() or scratch_parent.is_symlink():
        raise ValueError("Scratch directory is missing or symlinked")

    checksum_started = time.monotonic()
    with archive.open("rb") as source:
        digest = hashlib.sha256()
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
        if digest.hexdigest() != checksum.group(1):
            raise ValueError("Media backup checksum does not match")
        checksum_seconds = time.monotonic() - checksum_started
        source.seek(0)
        available_bytes = shutil.disk_usage(scratch_parent).free - reserve_bytes
        if available_bytes < 0:
            raise ValueError("Insufficient free space for media restore and reserve")

        restore_started = time.monotonic()
        with tempfile.TemporaryDirectory(
            prefix="drevo-media-restore.", dir=scratch_parent
        ) as temporary:
            root = Path(temporary)
            seen: set[tuple[str, ...]] = set()
            extracted: dict[tuple[str, ...], int] = {}
            files = 0
            total_bytes = 0
            has_legacy_uploads = False
            restored_keys: dict[tuple[str, ...], tuple[str, bytes]] = {}
            with tarfile.open(fileobj=source, mode="r|gz") as media:
                for member in media:
                    parts = member_parts(member)
                    if parts in seen:
                        raise ValueError(f"Duplicate media archive path: {member.name!r}")
                    seen.add(parts)
                    if parts == ("uploads",):
                        has_legacy_uploads = True
                    if member.isfile():
                        if member.size < 0:
                            raise ValueError(f"Invalid media file size: {member.name!r}")
                        if parts in PLATFORM_KEY_PATHS and member.size > 4096:
                            raise ValueError("AI cleanup key exceeds the size limit")
                        files += 1
                        total_bytes += member.size
                        if total_bytes > available_bytes:
                            raise ValueError(
                                "Insufficient free space for media restore and reserve"
                            )
                    target = root.joinpath(*parts)
                    if member.isdir():
                        target.mkdir(parents=True, exist_ok=True)
                        continue
                    target.parent.mkdir(parents=True, exist_ok=True)
                    input_file = media.extractfile(member)
                    if input_file is None:
                        raise ValueError(f"Cannot read media file: {member.name!r}")
                    archived_digest = hashlib.sha256()
                    copied = 0
                    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600) \
                        if parts in PLATFORM_KEY_PATHS else None
                    output_file = os.fdopen(descriptor, "wb") if descriptor is not None \
                        else target.open("xb")
                    with input_file, output_file as output:
                        for block in iter(lambda: input_file.read(1024 * 1024), b""):
                            output.write(block)
                            archived_digest.update(block)
                            copied += len(block)
                    if copied != member.size or target.stat().st_size != member.size:
                        raise ValueError(f"Incomplete media file: {member.name!r}")
                    restored_digest = hashlib.sha256()
                    with target.open("rb") as restored:
                        for block in iter(lambda: restored.read(1024 * 1024), b""):
                            restored_digest.update(block)
                    if restored_digest.digest() != archived_digest.digest():
                        raise ValueError(f"Restored media differs from archive: {member.name!r}")
                    extracted[parts] = copied
                    if parts in PLATFORM_KEY_PATHS:
                        try:
                            content = target.read_bytes()
                            key_data = json.loads(content.decode("utf-8"))
                            raw_key = base64.b64decode(key_data["key"], validate=True)
                            if key_data["version"] != 1 or len(raw_key) != 32:
                                raise ValueError()
                            restored_keys[parts] = (hashlib.sha256(raw_key).hexdigest(), content)
                        except (ValueError, KeyError, TypeError, UnicodeError) as error:
                            raise ValueError("Restored AI cleanup key is invalid") from error
            if not has_legacy_uploads or files == 0:
                raise ValueError("Media backup has no legacy uploads root or no files")
            if restored_keys and (
                set(restored_keys) != PLATFORM_KEY_PATHS
                or len({entry[1] for entry in restored_keys.values()}) != 1
            ):
                raise ValueError("AI cleanup primary and backup keys do not match")
            if expected is not None:
                if expected_key is None and restored_keys:
                    raise ValueError("Restored database/AI cleanup key mismatch")
                if expected_key is not None and (
                    set(restored_keys) != PLATFORM_KEY_PATHS
                    or {entry[0] for entry in restored_keys.values()} != {expected_key}
                ):
                    raise ValueError("Restored database/AI cleanup key mismatch")
                missing = sum(1 for parts in expected if parts not in extracted)
                wrong_size = sum(
                    1 for parts, size in expected.items()
                    if size is not None and parts in extracted and extracted[parts] != size
                )
                if missing or wrong_size:
                    raise ValueError(
                        f"Restored database/media mismatch: missing={missing} "
                        f"wrong_size={wrong_size}"
                    )
            restore_seconds = time.monotonic() - restore_started
    return RestoreResult(
        files, total_bytes, checksum_seconds, restore_seconds,
        time.monotonic() - started, len(expected) if expected is not None else 0,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--scratch-parent", type=Path, default=Path("/var/tmp"))
    parser.add_argument("--reference-manifest", type=Path)
    parser.add_argument("--legacy-archive-id")
    arguments = parser.parse_args()
    try:
        result = verify_archive(
            arguments.archive, arguments.scratch_parent,
            reference_manifest=arguments.reference_manifest,
            legacy_archive_id=arguments.legacy_archive_id,
        )
    except (OSError, ValueError, tarfile.TarError) as error:
        print(f"Media restore verification failed: {error}", file=sys.stderr)
        return 1
    print(
        "MEDIA_RESTORE_VERIFIED "
        f"files={result.files} bytes={result.bytes} "
        f"checksum_seconds={result.checksum_seconds:.3f} "
        f"restore_seconds={result.restore_seconds:.3f} "
        f"ready_seconds={result.ready_seconds:.3f}"
    )
    if arguments.reference_manifest is not None:
        print(
            f"RESTORE_PAIR_VERIFIED media={arguments.archive.name} "
            f"references={result.references_checked} files={result.files}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
