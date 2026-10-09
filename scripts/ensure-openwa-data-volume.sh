#!/bin/sh
# Creates the external Docker volume used by docker-compose.yml before deploy.
# Dokploy/Coolify sometimes run `docker compose down -v`, which wipes non-external volumes;
# `external: true` keeps accounts (auth.sqlite) and sessions across redeploys.
set -e
VOLUME_NAME="${OPENWA_DATA_VOLUME_NAME:-openwa_openwa-data}"
if docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
  echo "Data volume $VOLUME_NAME already exists."
else
  docker volume create "$VOLUME_NAME"
  echo "Created data volume $VOLUME_NAME."
fi
