#!/usr/bin/env python3
"""Rehearse extraction of one immutable Drevo media backup."""

import argparse
import hashlib
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
DISK_RESERVE = 8 * 1024**3


@dataclass(frozen=True)
class RestoreResult:
    files: int
    bytes: int
    checksum_seconds: float
    restore_seconds: float
    ready_seconds: float


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
    if parts[0] == "uploads":
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
    archive: Path, scratch_parent: Path, reserve_bytes: int = DISK_RESERVE
) -> RestoreResult:
    started = time.monotonic()
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
            files = 0
            total_bytes = 0
            has_legacy_uploads = False
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
                    with input_file, target.open("xb") as output:
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
            if not has_legacy_uploads or files == 0:
                raise ValueError("Media backup has no legacy uploads root or no files")
            restore_seconds = time.monotonic() - restore_started
    return RestoreResult(
        files, total_bytes, checksum_seconds, restore_seconds,
        time.monotonic() - started,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--scratch-parent", type=Path, default=Path("/var/tmp"))
    arguments = parser.parse_args()
    try:
        result = verify_archive(arguments.archive, arguments.scratch_parent)
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
