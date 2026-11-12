#!/usr/bin/env bash
set -euo pipefail

# GitHub runners occasionally cannot resolve Ubuntu mirrors. Give installation
# bounded retries; test failures themselves are never retried by this helper.
for source in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources /etc/apt/apt-mirrors.txt; do
  if [ -f "$source" ]; then
    sudo sed -i 's#http://azure.archive.ubuntu.com/ubuntu#https://archive.ubuntu.com/ubuntu#g' "$source"
  fi
done

result=1
for attempt in 1 2 3; do
  if timeout 210s npx playwright install --with-deps chromium; then
    exit 0
  else
    result=$?
  fi
  if [ "$attempt" -lt 3 ]; then
    echo "Chromium installation failed (attempt $attempt/3, exit $result); retrying." >&2
    sleep 5
  fi
done
exit "$result"
