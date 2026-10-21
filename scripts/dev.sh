#!/usr/bin/env bash
# One-command local bring-up: Postgres (Podman), migrate, seed, API + web.
# Uses `podman compose` (Podman 4.1+), falling back to `podman-compose`. If
# neither is available, point DATABASE_URL at an existing Postgres 15+.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || cp .env.example .env
set -a; source .env; set +a

compose=""
if command -v podman >/dev/null 2>&1; then
  if podman compose version >/dev/null 2>&1; then compose="podman compose";
  elif command -v podman-compose >/dev/null 2>&1; then compose="podman-compose"; fi
fi

if [ -n "$compose" ]; then
  $compose up -d postgres
  echo "waiting for postgres..."
  until podman exec "$(podman ps -q --filter name=postgres | head -n1)" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
else
  echo "podman compose not found; assuming Postgres is reachable at ${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/pmtool}"
fi

pnpm install
pnpm --filter @pm/core build
pnpm db:migrate
pnpm db:seed || true
pnpm dev
