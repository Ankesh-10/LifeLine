#!/usr/bin/env bash
# One-time local setup: .env, containers, database schema.
# Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example; fill in TELEGRAM_* and LLM_* before running workflows."
fi

# Generate the n8n encryption key once. Changing it later breaks saved credentials.
if grep -qE '^N8N_ENCRYPTION_KEY=$' .env; then
  key="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
  sed -i.bak "s/^N8N_ENCRYPTION_KEY=$/N8N_ENCRYPTION_KEY=${key}/" .env && rm -f .env.bak
  echo "Generated N8N_ENCRYPTION_KEY."
fi

docker compose up -d --build

echo "Waiting for Postgres..."
until docker compose exec -T db sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; do
  sleep 2
done

scripts/migrate.sh

if [[ -x scripts/import-workflows.sh ]] && compgen -G "n8n/workflows/*.json" >/dev/null; then
  scripts/import-workflows.sh
fi

echo "Ready: n8n at http://localhost:${N8N_PORT:-5678} (SIMULATED demo)."
