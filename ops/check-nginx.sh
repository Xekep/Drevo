#!/usr/bin/env bash
set -euo pipefail

site=${1:-ops/nginx.conf}
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT

openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
  -subj '/CN=localhost' \
  -keyout "$temporary/key.pem" -out "$temporary/cert.pem" >/dev/null 2>&1
# The Ubuntu 24.04 runner has Nginx 1.24 and no privilege to bind 80/443.
# The deployed 1.28 site also receives nginx -t when installed on the server.
sed \
  -e "s#/etc/letsencrypt/live/[^/]*/fullchain.pem#$temporary/cert.pem#g" \
  -e "s#/etc/letsencrypt/live/[^/]*/privkey.pem#$temporary/key.pem#g" \
  -e 's#/var/log/nginx/drevo.kiiko.ru/access.log#/dev/null#g' \
  -e 's#/var/log/nginx/drevo.kiiko.ru/error.log#/dev/null#g' \
  -e '/^[[:space:]]*http2 on;[[:space:]]*$/d' \
  -e 's/listen 80;/listen 18080;/g' \
  -e 's/listen \[::\]:80;/listen [::]:18080;/g' \
  -e 's/listen 443 ssl;/listen 18443 ssl;/g' \
  -e 's/listen \[::\]:443 ssl;/listen [::]:18443 ssl;/g' \
  "$site" > "$temporary/site.conf"
cat > "$temporary/nginx.conf" <<EOF
pid $temporary/nginx.pid;
events {}
http { include $temporary/site.conf; }
EOF
nginx -t -c "$temporary/nginx.conf" -p "$temporary"
