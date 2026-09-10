#!/bin/sh
set -eu

DEPLOY_DIR=${LBC_DEPLOY_DIR:-/home/nrk/lbc/deploy}
ENV_FILE=${LBC_ENV_FILE:-$DEPLOY_DIR/.env}

# Docker Engine peut finir de démarrer après cron au boot.
for _attempt in $(seq 1 60); do
  if /usr/bin/docker --context default info >/dev/null 2>&1; then
    cd "$DEPLOY_DIR"
    DOCKER_CONTEXT=default /usr/bin/docker compose --env-file "$ENV_FILE" up -d
    exit 0
  fi
  sleep 2
done

echo "Docker Engine unavailable after 120 seconds" >&2
exit 1
