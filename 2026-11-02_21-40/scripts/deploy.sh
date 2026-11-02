#!/usr/bin/env bash
# Deploys the release folder this script lives in. The code folder is only ever READ: the settings file,
# the database, the patient files and the backups live in a separate folder (default /opt/clinic-data),
# so a new release can be started without touching them.
#
#   bash <release-folder>/scripts/deploy.sh
#
# Layout it expects (create once, see docs/DEPLOY-AGENT.md):
#   $CLINIC_DATA_ROOT/.env   settings (DOMAIN, TZ, DATA_PATH=$CLINIC_DATA_ROOT/data)
#   $CLINIC_DATA_ROOT/data/  database, patients, backups (owned by uid 1000)
# It writes two small files into $CLINIC_DATA_ROOT: `current-release` (the folder now running) and `dc`
# (a wrapper: `$CLINIC_DATA_ROOT/dc ps`, `dc logs --tail 50 app`, `dc exec -T app node scripts/backup.js`).
#
# Steps: check settings, back up the running database, build and start this release, wait until the app is
# healthy, check the public HTTPS address. On failure it prints the command that restarts the previous release.
set -euo pipefail

release=$(cd "$(dirname "$0")/.." && pwd)
root=$(cd "${CLINIC_DATA_ROOT:-/opt/clinic-data}" && pwd)
cd "$release"   # Docker's build tool only reads files below the current folder
fail() { echo "FAILED: $1" >&2; exit 1; }

[ -f "$root/.env" ] || fail "$root/.env is missing (copy .env.example there and set DOMAIN)"
data=$(grep -E '^DATA_PATH=' "$root/.env" | head -1 | cut -d= -f2- | tr -d '\r"' | xargs || true)
case "$data" in
  /* | [A-Za-z]:*) ;;
  *) fail "DATA_PATH in $root/.env must be an absolute path outside the code folder, e.g. $root/data" ;;
esac
mkdir -p "$data"
if [ "$(uname)" = Linux ] && [ "$(stat -c %u "$data")" != 1000 ]; then
  fail "the app runs as user 1000; run: sudo chown 1000:1000 $data"
fi

previous=""
[ -f "$root/current-release" ] && previous=$(cat "$root/current-release")

running=$(docker ps -q --filter label=com.docker.compose.project=clinic --filter label=com.docker.compose.service=app)
if [ -n "$running" ]; then
  docker exec "$running" node scripts/backup.js
fi

compose() { docker compose --env-file "$root/.env" -f "$release/docker-compose.yml" "$@"; }
compose up -d --build

rollback_hint() {
  echo "FAILED: $1" >&2
  if [ -n "$previous" ] && [ "$previous" != "$release" ]; then
    echo "Restart the previous release with:" >&2
    echo "  docker compose --env-file $root/.env -f $previous/docker-compose.yml up -d --build" >&2
    echo "If a database change already ran, restore the backup made above (docs/TROUBLESHOOTING.md)." >&2
  else
    echo "This is the first release, so there is nothing to go back to. Read the logs: docker compose --env-file $root/.env -f $release/docker-compose.yml logs --tail 50" >&2
  fi
  exit 1
}

status=starting
for _ in $(seq 1 60); do
  status=$(docker inspect --format '{{.State.Health.Status}}' "$(compose ps -q app)" 2>/dev/null || echo starting)
  [ "$status" = healthy ] && break
  sleep 2
done
[ "$status" = healthy ] || rollback_hint "app is '$status' after 120 s (check the app logs)"

domain=$(grep -E '^DOMAIN=' "$root/.env" | head -1 | cut -d= -f2- | tr -d '\r"' | xargs)
[ -n "$domain" ] || rollback_hint "DOMAIN is not set in $root/.env"
curl_opts=(-s -m 5)
[ "$domain" = localhost ] && curl_opts+=(-k)   # local test uses a self-signed certificate
for _ in $(seq 1 30); do
  if [ "$(curl "${curl_opts[@]}" "https://$domain/health" || true)" = ok ]; then
    echo "$release" > "$root/current-release"
    cat > "$root/dc" <<EOF
#!/bin/sh
# Runs docker compose for the release that is currently deployed. Written by scripts/deploy.sh.
root=\$(cd "\$(dirname "\$0")" && pwd)
exec docker compose --env-file "\$root/.env" -f "\$(cat "\$root/current-release")/docker-compose.yml" "\$@"
EOF
    chmod +x "$root/dc"
    echo "OK: https://$domain/health answers; running release $release"
    exit 0
  fi
  sleep 2
done
rollback_hint "https://$domain/health does not answer (the certificate may still be pending: check the caddy logs)"
