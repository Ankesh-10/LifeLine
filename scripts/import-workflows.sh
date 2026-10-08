#!/usr/bin/env bash
# Imports n8n/workflows/*.json into the running n8n container, creates the
# "Lifeline DB" Postgres credential the workflows reference (from .env), and
# activates the workflows that have triggers. Safe to re-run: fixed workflow and
# credential ids mean re-imports update in place.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -f .env ]] || { echo "No .env; run scripts/setup.sh first." >&2; exit 1; }
set -a; source .env; set +a

n8n() { docker compose exec -T n8n n8n "$@"; }

# 1. Credential with a fixed id. n8n encrypts plain credential data on import.
#    Built with node so passwords with quotes stay valid JSON; deleted right after.
cred_file="$(mktemp)"
trap 'rm -f "$cred_file"' EXIT
node -e '
  const e = process.env;
  console.log(JSON.stringify([{ id: "lifelinePostgres1", name: "Lifeline DB", type: "postgres",
    data: { host: "db", port: 5432, database: e.POSTGRES_DB, user: e.POSTGRES_USER, password: e.POSTGRES_PASSWORD, ssl: "disable" } }]));
' > "$cred_file"
docker compose cp "$cred_file" n8n:/tmp/lifeline-credentials.json
n8n import:credentials --input=/tmp/lifeline-credentials.json
docker compose exec -T n8n rm -f /tmp/lifeline-credentials.json

# 2. Workflows (the folder is mounted at /lifeline/workflows).
n8n import:workflow --separate --input=/lifeline/workflows

# 3. Activate everything with a trigger. 04-approval-gate and 99-error-handler
#    run as sub-workflows / error workflow and stay inactive.
for id in lifeline01ingest lifeline02condtn lifeline03triage lifeline04dispat lifeline05replys lifeline06watchd; do
  n8n update:workflow --id="$id" --active=true \
    || n8n publish:workflow --id="$id" \
    || echo "WARN: could not activate $id; activate it in the n8n UI." >&2
done

# CLI activation takes effect after a restart.
docker compose restart n8n
echo "Workflows imported and activated (SIMULATED demo)."
