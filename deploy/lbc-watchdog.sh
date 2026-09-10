#!/bin/sh
set -eu

DEPLOY_DIR=${LBC_DEPLOY_DIR:-/home/nrk/lbc/deploy}
ENV_FILE=${LBC_ENV_FILE:-$DEPLOY_DIR/.env}
STATE_DIR=${LBC_WATCHDOG_STATE_DIR:-/var/lib/lbc-watchdog}
FAIL_FILE=$STATE_DIR/failures

mkdir -p "$STATE_DIR"

env_value() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r'
}

LBC_BIND_IP=${LBC_BIND_IP:-$(env_value LBC_BIND_IP)}
LBC_PORT=${LBC_PORT:-$(env_value LBC_PORT)}
LBC_BIND_IP=${LBC_BIND_IP:-127.0.0.1}
LBC_PORT=${LBC_PORT:-8899}
HEALTH_URL="http://$LBC_BIND_IP:$LBC_PORT/api/v1/status"

if /usr/bin/curl --fail --silent --show-error --max-time 15 "$HEALTH_URL" >/dev/null; then
  printf '0\n' > "$FAIL_FILE"
  exit 0
fi

failures=0
if [ -f "$FAIL_FILE" ]; then
  failures=$(cat "$FAIL_FILE" 2>/dev/null || printf '0')
fi
case "$failures" in
  ''|*[!0-9]*) failures=0 ;;
esac
failures=$((failures + 1))
printf '%s\n' "$failures" > "$FAIL_FILE"

# Deux ratés peuvent correspondre à un redémarrage ou une courte saturation.
# Le troisième confirme une panne locale et justifie une réparation.
if [ "$failures" -lt 3 ]; then
  echo "Leboncoin healthcheck failed ($failures/3): $HEALTH_URL" >&2
  exit 0
fi

echo "Leboncoin unavailable after $failures checks; recreating its stack" >&2
cd "$DEPLOY_DIR"
DOCKER_CONTEXT=default /usr/bin/docker compose --env-file "$ENV_FILE" up -d --force-recreate
printf '0\n' > "$FAIL_FILE"
