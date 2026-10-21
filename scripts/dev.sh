#!/usr/bin/env bash
# One-command local bring-up: migrate + seed the SQLite file, then API + web.
# No database server and no sudo needed: the database is ./data/pmtool.db.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || cp .env.example .env
set -a; source .env; set +a
pnpm install
pnpm --filter @pm/core build
pnpm --filter @pm/db build
pnpm db:migrate
pnpm db:seed || true
pnpm dev
