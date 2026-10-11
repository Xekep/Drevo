#!/usr/bin/env python3
"""Validate a verified artifact's identity before uploading or activating it."""
import json
from pathlib import Path
import re
import sys


def main():
    if len(sys.argv) != 3:
        sys.exit("Usage: read-release-id.py release.json expected-commit")
    expected_commit = sys.argv[2]
    if not re.fullmatch(r"[0-9a-f]{40}", expected_commit):
        sys.exit("Invalid expected commit")
    try:
        metadata = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        sys.exit("Cannot read verified release metadata")
    release_id = metadata.get("releaseId") if isinstance(metadata, dict) else None
    if not isinstance(release_id, str) or not re.fullmatch(
        re.escape(expected_commit) + r"-[1-9][0-9]*", release_id
    ):
        sys.exit("Verified release identity does not match the expected commit")
    # A failed-job retry reuses the artifact assembled by an earlier attempt.
    # Its identity remains immutable; the current run_attempt is not its ID.
    print(f"release_id={release_id}")


if __name__ == "__main__":
    main()
