# Data model

Postgres 16 + PostGIS; the SQL is Supabase-compatible. Migrations in `db/migrations/` are numbered and append-only, and `scripts/migrate.sh` records them in `schema_migrations`. Every domain row has a `simulated` flag, `true` for all demo data.

## Flow

```
reports ──(cluster)──► incidents ──(match)──► dispatches ──► resources
                           ▲                      │
     gauges, rainfall ─────┘ (fusion)             └── route_blocks (from "road blocked" replies)

every decision ──► audit_log (append-only)
```

## Tables

| Table | Purpose | Written by |
|---|---|---|
| `reports` | One row per incoming message: the raw text and media, plus the validated LLM extraction (`need_type`, `people`, `vulnerable[]`, `geom`, `confidence`). `UNIQUE (source, external_id)` drops exact re-deliveries. | n8n `01-ingest` |
| `incidents` | A deduplicated cluster of reports: centroid, needs, people (max across reports, not sum), `score` + `score_breakdown`, `evidence_status` + `evidence`, `stale`, `status`. | n8n `03-triage` |
| `resources` | Boats, ambulances and volunteer teams: `terrain` (boats are `water`, the rest `road`, enforced by a CHECK), capacity, medic, speed, position, status. | seed, n8n `04`–`06` |
| `shelters` | Relief shelters with capacity and occupancy. | seed |
| `dispatches` | An incident↔resource assignment with the full match explanation (`match` jsonb), approval fields, heartbeat, and both confirmations. A partial unique index allows **one live dispatch per resource**. | n8n `04`–`06` |
| `route_blocks` | Blocked roads reported by responders. The matcher rejects road vehicles whose route passes within `radius_m`. | n8n `05-replies` |
| `gauges`, `gauge_readings` | River gauges (warning/danger levels) and their time series. | n8n `02-conditions` |
| `rainfall_readings` | Rainfall (mm in the last 3 h) per area. | n8n `02-conditions` |
| `audit_log` | Who did what, with what inputs, and why. UPDATE, DELETE and TRUNCATE raise an error. | every workflow |

## Status enums

- **incident_status:** `new → triaged → awaiting_approval → dispatched → en_route → on_scene → resolved`, plus `dismissed`. A reassignment sends the incident back to `triaged`. Transitions are enforced in `core/src/lifecycle.js`.
- **dispatch_status:** `awaiting_approval | rejected | sent | acknowledged | en_route | on_scene | completed | failed | reassigned | cancelled`. A dispatch is `completed` only when both `responder_confirmed_at` and `requester_confirmed_at` are set.
- **evidence_status:** `corroborated | unverified | contradicted` (see `core/src/fusion.js`).

## Views

| View | Use |
|---|---|
| `v_live_dispatch` | The current live dispatch per incident. |
| `v_incident_queue` | The coordinator's work queue: open incidents by score, with waiting minutes and the assigned resource. |
| `v_incident_map` | Flat lat/lon rows for a future map client, labelled `SIMULATED`. |

## Coordinates

Points are `geography(Point, 4326)`. Insert with `ST_MakePoint(lon, lat)::geography`; note the longitude comes first. Read back with `ST_Y(geom::geometry)` (lat) and `ST_X(geom::geometry)` (lon). `lifeline-core` uses `{ lat, lon }` objects.
