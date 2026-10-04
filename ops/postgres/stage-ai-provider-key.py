#!/usr/bin/env python3
"""Copy the physical platform key pair into an app-owned preflight directory."""

import os
from pathlib import Path
import stat
import sys


NAME = "ai-provider-cleanup.v1.key"
MAX_BYTES = 4096
UNIX = os.name == "posix"


def private_directory(path: Path, owned: bool = False) -> None:
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or (owned and UNIX and info.st_uid != os.geteuid()):
        raise ValueError("unsafe directory")


def private_key(path: Path) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode)
                or (UNIX and (info.st_uid != os.geteuid() or info.st_mode & 0o077))
                or not 0 < info.st_size <= MAX_BYTES):
            raise ValueError("unsafe key")
        content = os.read(descriptor, MAX_BYTES + 1)
        if len(content) != info.st_size:
            raise ValueError("key changed during staging")
        return content
    finally:
        os.close(descriptor)


def write_private(path: Path, content: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as output:
            output.write(content)
            output.flush()
            os.fsync(descriptor)
    finally:
        os.close(descriptor)


def stage_keys(shared: Path, stage: Path) -> None:
    private_directory(shared)
    private_directory(shared / "backups")
    private_directory(shared / "backups/platform-keys")
    private_directory(stage, owned=True)
    if UNIX and stage.stat().st_mode & 0o077:
        raise ValueError("unsafe stage")
    original = private_key(shared / NAME)
    backup = private_key(shared / "backups/platform-keys" / NAME)
    if original != backup:
        raise ValueError("key pair differs")
    (stage / "backups").mkdir(mode=0o700)
    (stage / "backups/platform-keys").mkdir(mode=0o700)
    write_private(stage / NAME, original)
    write_private(stage / "backups/platform-keys" / NAME, backup)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("Usage: stage-ai-provider-key.py <shared> <preflight-stage>")
    try:
        stage_keys(Path(sys.argv[1]), Path(sys.argv[2]))
    except (OSError, ValueError):
        sys.exit("AI cleanup key staging failed")
