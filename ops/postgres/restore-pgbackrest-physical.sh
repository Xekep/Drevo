#!/usr/bin/env bash
set -euo pipefail

# Keep the restore options used in production and in the CI integration smoke identical.
if (( $# != 3 && $# != 4 )); then
  echo 'Usage: restore-pgbackrest-physical.sh STANZA DATA_DIR TABLESPACE_DIR [CONFIG]' >&2
  exit 2
fi

options=(
  --stanza="$1"
  --pg1-path="$2"
  --tablespace-map-all="$3"
  --type=default
)
if (( $# == 4 )); then
  options+=(--config="$4")
fi
exec pgbackrest "${options[@]}" restore
