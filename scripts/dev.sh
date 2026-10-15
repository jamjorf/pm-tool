#!/usr/bin/env bash
# One-command local bring-up: Postgres (docker), migrate, seed, API + web.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || cp .env.example .env
set -a; source .env; set +a
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker compose up -d postgres
  until docker compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
fi
pnpm install
pnpm --filter @pm/core build
pnpm db:migrate
pnpm db:seed || true
pnpm dev
