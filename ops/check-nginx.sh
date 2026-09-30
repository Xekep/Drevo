#!/usr/bin/env bash
set -euo pipefail

site=${1:-ops/nginx.conf}
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT

openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
  -subj '/CN=localhost' \
  -keyout "$temporary/key.pem" -out "$temporary/cert.pem" >/dev/null 2>&1
# The Ubuntu 24.04 runner has Nginx 1.24; the deployed 1.28 site also
# receives a separate nginx -t on the server when this file is installed.
sed \
  -e "s#/etc/letsencrypt/live/[^/]*/fullchain.pem#$temporary/cert.pem#g" \
  -e "s#/etc/letsencrypt/live/[^/]*/privkey.pem#$temporary/key.pem#g" \
  -e 's#/var/log/nginx/drevo.kiiko.ru/access.log#/dev/null#g' \
  -e 's#/var/log/nginx/drevo.kiiko.ru/error.log#/dev/null#g' \
  -e '/^[[:space:]]*http2 on;[[:space:]]*$/d' \
  "$site" > "$temporary/site.conf"
cat > "$temporary/nginx.conf" <<EOF
pid $temporary/nginx.pid;
events {}
http { include $temporary/site.conf; }
EOF
nginx -t -c "$temporary/nginx.conf" -p "$temporary"
