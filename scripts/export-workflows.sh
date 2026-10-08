#!/usr/bin/env bash
# Exports the workflows from the running n8n into n8n/workflows/ in canonical
# form (scripts/normalize-workflows.js): no credentials, no timestamps.
# Run this after every edit in the n8n UI so the JSON in git stays the source of truth.
set -euo pipefail
cd "$(dirname "$0")/.."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

docker compose exec -T n8n sh -c 'rm -rf /tmp/lifeline-export && n8n export:workflow --all --separate --output=/tmp/lifeline-export'
docker compose cp n8n:/tmp/lifeline-export/. "$tmp/"
docker compose exec -T n8n rm -rf /tmp/lifeline-export

node scripts/normalize-workflows.js "$tmp" n8n/workflows
echo "Exported to n8n/workflows/. Review the diff before committing."
