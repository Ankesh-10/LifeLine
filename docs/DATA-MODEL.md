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
| `extraction_cache` | LLM extractions keyed by a hash of message text, media, model and prompt version, so demo replays don't re-call a free-tier API. | n8n `01-ingest` |

Migration 009 also adds `reports.review_reason` (`no_location`, retried by triage; `low_confidence`; `extraction_failed`; `after_resolution` / `after_dismissal` for reports landing on a closed incident) and `reports.content_hash`, `incidents.extraction_confidence` and `incidents.closed_at`, and `dispatches.approval_url`, `approval_token` and `escalated_at`.

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
| `v_approval_queue` | Dispatches waiting for the coordinator, with ready-to-click approve / reject / dismiss links (the fallback when Telegram isn't configured). |
| `v_review_queue` | Reports a human must look at, with the reason and, for late reports, the closed incident they landed on. |

## Workflow functions (009)

Each n8n workflow makes one read and one write. The write applies a plan computed by `lifeline-core` and records its `audit_log` rows in the same transaction. Plans are JSON (camelCase keys, ISO-8601 times, `{lat, lon}` points), inlined by the Postgres node as a quoted literal from `core.pipeline.sqlJson()`.

| Workflow | Read | Core step | Write |
|---|---|---|---|
| 01-ingest | `extraction_cache` lookup | `core.ingest.*` | `lifeline_ingest_report` |
| 02-conditions | (feed over HTTP) | `core.pipeline.planConditions` | `lifeline_apply_conditions` |
| 03-triage | `lifeline_triage_input()` | `core.pipeline.triage` | `lifeline_apply_triage` |
| 04-dispatch | `lifeline_dispatch_input()` | `core.pipeline.planDispatch` | `lifeline_apply_dispatch` |
| 04-approval-gate | (Wait node) | `core.pipeline.planApproval` | `lifeline_set_approval`, `lifeline_apply_approval` |
| 05-replies | `lifeline_reply_context()` | `core.pipeline.planReplyEffects` | `lifeline_apply_reply` |
| 06-watchdog | `lifeline_watchdog_input()` | `core.pipeline.planWatchdog` | `lifeline_apply_watchdog` |
| 99 / deliveries | | `core.pipeline.errorEvent`, `deliveryEvent` | `lifeline_log` |

Apply functions re-check state under row locks (`expectedDispatchStatus`, `fromIncidentStatus`, resource still available). If another run got there first, they skip and audit the skip (`dispatch.skipped`, `reply.stale`, `approval.stale`) instead of overwriting newer state. `tests/db/` runs all of this on in-process Postgres + PostGIS (PGlite).

## Coordinates

Points are `geography(Point, 4326)`. Insert with `ST_MakePoint(lon, lat)::geography`; note the longitude comes first. Read back with `ST_Y(geom::geometry)` (lat) and `ST_X(geom::geometry)` (lon). `lifeline-core` uses `{ lat, lon }` objects.
