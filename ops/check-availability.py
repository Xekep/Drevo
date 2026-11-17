#!/usr/bin/env python3
"""Exit unsuccessfully when the public Drevo health check is unavailable."""

import json
import sys
from urllib.request import urlopen


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else "https://mydrevo.org/api/health"
    try:
        with urlopen(url, timeout=8) as response:
            limit = 64 * 1024
            body = response.read(limit + 1)
            if response.status != 200 or len(body) > limit:
                raise ValueError("Unexpected health response")
        health = json.loads(body)
        if not isinstance(health, dict) or health.get("ok") is not True:
            raise ValueError("Health response is not healthy")
    except (OSError, ValueError) as error:
        print(f"Drevo availability check failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
