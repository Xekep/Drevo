#!/usr/bin/env bash
# Однократная подготовка выделенного каталога и процесса. Запускается от root.
set -euo pipefail
base=/var/www/drevo.kiiko.ru
getent group site_drevo_grp >/dev/null || groupadd --system site_drevo_grp
id site_drevo >/dev/null 2>&1 || useradd --system --gid site_drevo_grp --home-dir "$base" --shell /usr/sbin/nologin site_drevo
usermod -aG site_drevo_grp deploy
install -d -m 2770 -o site_drevo -g site_drevo_grp "$base" "$base/releases" "$base/shared" "$base/shared/uploads" "$base/shared/backups"
setfacl -m g:site_drevo_grp:rwx,d:g:site_drevo_grp:rwx,d:m:rwx "$base" "$base/releases" "$base/shared" "$base/shared/uploads" "$base/shared/backups"
install -d -m 755 /var/log/nginx/drevo.kiiko.ru
if ! test -x /opt/node-v22.23.2-linux-x64/bin/node; then
  tmp=$(mktemp -d)
  cd "$tmp"
  curl --fail --silent --show-error -O https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz
  curl --fail --silent --show-error -O https://nodejs.org/dist/v22.23.2/SHASUMS256.txt
  grep ' node-v22.23.2-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum -c -
  tar -xJf node-v22.23.2-linux-x64.tar.xz -C /opt
fi
ln -sfn /opt/node-v22.23.2-linux-x64 /opt/drevo-node
cat > /usr/local/sbin/drevo-service-restart <<'SH'
#!/bin/sh
test "$#" -eq 0 || exit 2
exec /usr/bin/systemctl restart drevo.service
SH
chmod 755 /usr/local/sbin/drevo-service-restart
echo 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/drevo-service-restart ""' > /etc/sudoers.d/drevo-deploy
chmod 440 /etc/sudoers.d/drevo-deploy
visudo -cf /etc/sudoers.d/drevo-deploy
echo 'Каталог Древа и Node.js готовы. Установите unit, /etc/drevo.env и конфигурацию Nginx согласно docs/deployment.md.'
