#!/usr/bin/env bash
# Deploy: Tests, Push nach GitHub, dann auf dem Server neu bauen.
#
#   npm run deploy
#
# Ziel laesst sich ueberschreiben: DEPLOY_HOST=root@anderer-host npm run deploy
set -euo pipefail

HOST="${DEPLOY_HOST:-root@nachrichten.helgenberger.net}"
DIR="${DEPLOY_DIR:-/usr/local/nachrichten-app}"

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "Arbeitsverzeichnis nicht sauber - erst committen." >&2
  exit 1
fi

npm test
npm run build
git push origin main

echo "==> $HOST:$DIR - git pull && docker compose up -d --build"
ssh "$HOST" "cd '$DIR' && git pull && docker compose up -d --build"
echo "==> fertig: $(git rev-parse --short HEAD) ist ausgeliefert"
