#!/usr/bin/env bash
# Applies pending db/migrations/*.sql in order, then (re)applies idempotent seeds.
# Tracks applied migrations in schema_migrations. Runs psql inside the db container.
set -euo pipefail
cd "$(dirname "$0")/.."

psql_db() {
  docker compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' psql "$@"
}

psql_db -c "CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);"

for file in db/migrations/*.sql; do
  version="$(basename "$file" .sql)"
  applied="$(psql_db -tA -c "SELECT 1 FROM schema_migrations WHERE version = '${version}'")"
  if [[ -z "$applied" ]]; then
    echo "Applying ${version}"
    # Run the migration and record it in one transaction.
    psql_db -1 -f "/lifeline/${file}" -c "INSERT INTO schema_migrations (version) VALUES ('${version}')"
  fi
done

for file in db/seed/*.sql; do
  echo "Seeding $(basename "$file")"
  psql_db -f "/lifeline/${file}"
done

echo "Database up to date."
