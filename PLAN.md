# Lifeline: backend build plan

Lifeline is decision support for a human flood-response coordinator. All feeds and responders are **simulated**, and it does not integrate with any government system.

**Scope (frozen):** one city, 3 resource types (`boat`, `ambulance`, `volunteer_team`) and 3 need types (`rescue`, `medical`, `supplies`). The map UI is **out of scope**. The backend exposes a `v_incident_map` view that a Leaflet page can read later.

---

## Architecture

```
Telegram / replay webhook ──► [01 ingest] ──► reports
Schedule (60s) ─────────────► [02 conditions] ──► gauge_readings, weather
Schedule (20s) ─────────────► [03 triage]  cluster → fuse → score ──► incidents
                                   │
                                   ▼
                              [04 dispatch]  match → policy ─┬─ auto ─────────► message responder
                                                             └─ Wait (approve) ─► message responder
responder replies ──────────► [05 replies]  agent reads reply → re-plan
Schedule (30s) ─────────────► [06 watchdog] silence / failed route → reassign
Every step ─────────────────► audit_log (append-only)
```

- **Runtime:** self-hosted n8n and Postgres + PostGIS in Docker Compose. The SQL is Supabase-compatible, so you can switch to hosted Supabase when the map is built.
- **Reasoning code:** a pure-JS package, `lifeline-core`. It's unit-tested outside n8n and installed into a custom n8n image (`NODE_FUNCTION_ALLOW_EXTERNAL=lifeline-core`). The Code nodes stay a few lines each (`require('lifeline-core').cluster(...)`). This keeps the hard logic testable instead of buried in workflow JSON.
- **LLM:** the n8n AI Agent with a vision-capable model from a **free-tier API**. The provider isn't chosen yet, so it's swappable through `LLM_*` env vars, and `SIM_MODE` can use pre-recorded extractions. Prompts are versioned in `n8n/prompts/`.

---

## Final tree

```
LifeLine/
├── README.md  PLAN.md  CLAUDE.md  LICENSE  .gitignore  .editorconfig  .env.example
├── docker-compose.yml
├── infra/n8n/Dockerfile  .dockerignore
├── db/
│   ├── migrations/001_extensions.sql … 008_audit_and_views.sql
│   └── seed/resources.sql  seed/shelters.sql
├── core/                         # lifeline-core (no n8n dependency)
│   ├── package.json  eslint.config.js
│   ├── config/weights.json  policy.json  gazetteer.json
│   ├── src/index.js geo.js time.js geocode.js cluster.js fusion.js score.js match.js lifecycle.js policy.js
│   └── test/*.test.js  test/fixtures/
├── n8n/
│   ├── workflows/01-ingest.json … 06-watchdog.json  99-error-handler.json
│   └── prompts/extract.md  responder-reply.md  dispatch-message.md
├── sim/                          # lifeline-sim (no deps, reuses ../core)
│   ├── scenarios/flood-city.json   # 30 messages + 6 ground-truth incidents
│   ├── conditions.json  responders.json  package.json
│   ├── lib/scenario.js feeds.js bot.js http.js
│   ├── mock-feeds.js  replay.js  responder-bot.js
│   └── test/*.test.js
├── bench/run.js  bench/manual-baseline.md
├── scripts/setup.sh  migrate.sh  import-workflows.sh  export-workflows.sh  reset-demo.sh
├── tests/e2e/scenario.test.js
├── docs/ARCHITECTURE.md  DATA-MODEL.md  SAFETY.md  DEMO.md
└── .github/workflows/ci.yml
```

---

## Commits, grouped by purpose

> **Nothing is committed yet.** This is a maintained list: it's updated whenever files change, and commits happen only when the user says so.
> Status: `todo` → `partial` → `written` (files exist locally) → `committed`.

### A. Foundation

| # | Commit | Files | Status |
|---|---|---|---|
| 1 | `Initial setup` | `README.md`, `LICENSE`, `.gitignore`, `.editorconfig`, `.env.example`, `PLAN.md`, `CLAUDE.md` | written |
| 2 | `Docker setup` | `docker-compose.yml`, `infra/n8n/Dockerfile`, `.dockerignore`, `scripts/setup.sh` | written (not run: Docker not installed on dev machine) |

`.env.example` holds `POSTGRES_*`, `N8N_ENCRYPTION_KEY`, `WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `LLM_PROVIDER`, `LLM_MODEL_EXTRACT`, `LLM_MODEL_CLASSIFY`, `LLM_API_KEY`, `COORDINATOR_CHAT_ID`, `WEATHER_API_URL`, and `SIM_MODE=true`.

### B. Data layer

| # | Commit | Files | Status |
|---|---|---|---|
| 3 | `Database setup` | `scripts/migrate.sh`, `db/migrations/001_extensions.sql`, `002_enums.sql` | written (SQL not run yet) |
| 4 | `Database tables` | `003_reports.sql`, `004_incidents.sql`, `005_resources.sql` (+ shelters), `006_dispatches.sql` (+ route_blocks), `007_conditions.sql` (gauges, rainfall) | written (SQL not run yet) |
| 5 | `Audit log and views` | `008_audit_and_views.sql`, `docs/DATA-MODEL.md` | written (SQL not run yet) |
| 6 | `Seed data` | `db/seed/resources.sql`, `db/seed/shelters.sql` | written |

The tables are documented in `docs/DATA-MODEL.md`. Additions beyond the original plan: `route_blocks` (for the blocked-road re-plan), `gauges` / `gauge_readings` / `rainfall_readings` (sensor evidence) and `scripts/migrate.sh` (tracks applied migrations).

### C. Reasoning core (`lifeline-core`): the tech depth

| # | Commit | Files | Status |
|---|---|---|---|
| 7 | `Core setup` | `core/package.json`, `core/package-lock.json`, `core/eslint.config.js`, `core/src/geo.js`, `core/src/time.js`, `core/test/geo.test.js` | written, tested |
| 8 | `Clustering` | `core/src/cluster.js`, `core/test/cluster.test.js`, `core/test/fixtures/messages-30.json` | written, tested |
| 9 | `Evidence check` | `core/src/fusion.js`, `core/test/fusion.test.js` | written, tested |
| 10 | `Priority score` | `core/src/score.js`, `core/config/weights.json`, `core/test/score.test.js` | written, tested |
| 11 | `Resource matching` | `core/src/match.js`, `core/test/match.test.js` | written, tested |
| 12 | `Incident lifecycle` | `core/src/lifecycle.js`, `core/test/lifecycle.test.js` | written, tested |
| 13 | `Approval policy` | `core/src/policy.js`, `core/config/policy.json`, `core/test/policy.test.js` | written, tested |
| 14 | `Location lookup` | `core/src/geocode.js`, `core/config/gazetteer.json`, `core/test/geocode.test.js`, `core/src/index.js`, `core/test/pipeline.test.js` | written, tested |

`index.js` and `pipeline.test.js` load every core module, so they land in 14. That way each earlier commit runs on its own.

**Core status:** 62/62 tests pass (`cd core && npm test`), and ESLint is clean.

What each module does:
- **cluster:** DBSCAN over a combined space-time distance, with a chaining guard so neighbouring reports can't merge into one huge cluster. New reports join open incidents first. Reports without a location inherit the incident of an earlier report from the same sender. Low-confidence or unlinkable reports go to human review. `people` is the max across reports, not the sum. Test: the 30 fixture messages produce exactly the 6 true incidents.
- **fusion:** checks the nearest gauge (level + least-squares trend) and the rainfall. It returns `corroborated` / `unverified` / `contradicted` with reasons. Three or more independent reporters override a sensor but set `conflict`. Medical and supplies needs are never contradicted by water data. It also outputs the `stale` and `flooded` flags.
- **score:** a 0–100 weighted sum of severity, vulnerability, people, water risk, report count and time waiting, times an evidence multiplier (contradicted ×0.5, stale ×0.6). It returns a per-factor breakdown.
- **match:** hard constraints (flooded → boat, capacity for rescue, blocked road, max ETA), then a greedy pass in priority order followed by local search (swaps, moves, refills) on priority-weighted cost. A swap never delays the higher-priority incident by more than 10 minutes. Not having a medic on board is a soft penalty. Every assignment explains itself, including its alternatives and the rejected options.
- **lifecycle:** the incident state machine, plus the effects of each responder reply: a blocked road becomes a route block, then the resource is released and the incident re-matched. Resolution needs **both** confirmations. A watchdog reassigns silent teams and escalates stuck confirmations.
- **policy:** approval depends on the risk of being wrong, not on urgency. It's required for contradicted, conflicting or stale evidence, low extraction confidence, committing the last available resource of a type, and any broadcast. Reassignment after silence or a blocked road runs automatically. Modes are `manual`, `assisted` and `autonomous`.

### D. Simulation (all labelled SIMULATED)

| # | Commit | Files | Status |
|---|---|---|---|
| 15 | `Flood scenario` | `sim/package.json`, `sim/scenarios/flood-city.json`, `sim/lib/scenario.js`, `sim/test/helpers.js`, `sim/test/scenario.test.js` | written, tested |
| 16 | `Mock sensor feeds` | `sim/conditions.json`, `sim/lib/feeds.js`, `sim/lib/http.js`, `sim/mock-feeds.js`, `sim/test/feeds.test.js` | written, tested, smoke-run over HTTP |
| 17 | `Replay and responder bot` | `sim/replay.js`, `sim/responders.json`, `sim/lib/bot.js`, `sim/responder-bot.js`, `sim/test/bot.test.js`, `sim/test/demo.test.js` | written, tested, smoke-run over HTTP |

**Sim status:** 17/17 tests pass (`cd sim && npm test`). The sim has no npm dependencies and reuses `../core`.

- The scenario has 30 messy messages: duplicates, typos ("Velacheri", "Pallikarnai"), 12 map pins, one photo, and two follow-ups with no location that are attached via their sender. Tambaram's claims are contradicted by a low, falling gauge. Each message carries the extraction an LLM should produce (`hint`, used in `SIM_MODE` and by the benchmark). Ground truth never leaves the simulator.
- Feed readings are timestamped relative to now, so river trends stay in true m/h even when the replay runs at 20×.
- The bot's scripts are keyed by **place**, not resource, because live assignments depend on arrival order:
  - the first *road* vehicle sent to Saidapet reports "road blocked", so an ambulance gets re-routed;
  - the first dispatch to Pallikaranai acknowledges and then goes silent, so the watchdog reassigns the spare boat (B2), which needs approval because it's the last boat.
  - Replacements behave normally, and normal runs end with the requester confirming.
- `demo.test.js` checks this whole story on the simulated data. The tested plan is: I2→B3, I1→B1, I4→B4, I3→A1, I5→V3, and I6→V1 (needs approval).

### E. n8n workflows

| # | Commit | Files | Status |
|---|---|---|---|
| 18 | `Workflow import/export` | `scripts/import-workflows.sh`, `scripts/export-workflows.sh` | todo |
| 19 | `Ingest workflow` | `n8n/workflows/01-ingest.json`, `n8n/prompts/extract.md` | todo |
| 20 | `Conditions workflow` | `n8n/workflows/02-conditions.json` | todo |
| 21 | `Triage workflow` | `n8n/workflows/03-triage.json` | todo |
| 22 | `Dispatch workflow` | `n8n/workflows/04-dispatch.json`, `n8n/prompts/dispatch-message.md` | todo |
| 23 | `Replies workflow` | `n8n/workflows/05-replies.json`, `n8n/prompts/responder-reply.md` | todo |
| 24 | `Watchdog workflow` | `n8n/workflows/06-watchdog.json`, `n8n/workflows/99-error-handler.json` | todo |

Contracts fixed by the sim (the workflows must match them):
- **Replay webhook** `POST /webhook/lifeline/replay` takes `{source, externalId, senderId, sentAt, text, pin?, media?, hint?, simulated}`.
- **Simulated dispatch:** for resources whose `contact_chat_id` starts with `sim-`, 04 posts `{dispatchId, incidentId, resourceId, resourceType, location}` to the bot (`http://host.docker.internal:4020/dispatch`) instead of Telegram.
- **Replies webhook** `POST /webhook/lifeline/replies` takes `{role: responder|requester, resourceId, dispatchId, incidentId, text, intentHint?, sentAt}`.
- **Triage** must re-try reports held back only for missing location on every run; low-confidence reports stay with the human.
- **Watchdog timeouts** must come from env so the demo can use about 1 minute instead of 15.

What each workflow does:
- **01-ingest:** Telegram Trigger plus a replay webhook. The AI Agent (vision) extracts strict JSON: need, people, vulnerability, location, confidence. If no LLM is configured or the call fails, it falls back to `hint` in `SIM_MODE`. Then `core.resolveLocation` (pin → gazetteer → null) runs, the report is inserted into `reports`, and the audit log is written.
- **02-conditions:** a Schedule node feeds HTTP Request nodes (weather + gauges) and upserts the readings.
- **03-triage:** a Schedule node runs the Code nodes `cluster` → `fusion` → `score`, upserts incidents, and calls 04 for each new incident.
- **04-dispatch:** the `match` and `policy` Code nodes, then branches. Approval goes through a Wait node and a resume URL sent to the coordinator on Telegram. Then it messages the responder, inserts the dispatch and writes the audit log.
- **05-replies:** the Agent classifies a reply as `ack` / `en_route` / `on_scene` / `blocked` / `need_backup` / `resolved`. Then `lifecycle` decides the next step: re-match, re-rank or close.
- **06-watchdog:** dispatches with no heartbeat for N minutes are reassigned via 04. An incident is resolved only once **both** the responder and the requester confirm.
- **99:** catches any workflow failure and logs it to `audit_log`.

### F. Verification, benchmark, CI, docs

| # | Commit | Files | Status |
|---|---|---|---|
| 25 | `End-to-end test` | `tests/e2e/scenario.test.js`, `scripts/reset-demo.sh` | todo |
| 26 | `Benchmark` | `bench/run.js`, `bench/manual-baseline.md` | todo |
| 27 | `CI` | `.github/workflows/ci.yml` | todo |
| 28 | `Docs` | `docs/ARCHITECTURE.md`, `docs/SAFETY.md`, `docs/DEMO.md`, `README.md` | todo |

- **25:** replays the scenario against the live stack and asserts 6 incidents, all dispatched, one re-route, one reassignment and a complete audit trail. The no-DB version of this story already passes in `sim/test/demo.test.js`.
- **26:** reports messages → incidents, dedupe precision/recall against ground truth, LLM extraction accuracy against `hint`, and time to full dispatch. The manual baseline states its assumptions, for example 45 s per message to read, tag and forward.

---

## Owner split (3 accounts)

| Account | Commits |
|---|---|
| 1: sim + data (map later) | 3–6, 15–17 |
| 2: n8n + prompts | 2, 18–24 |
| 3: core + bench + pitch | 7–14, 25–28 |

Commit 1 lands first. B, C and D can run in parallel. E depends on B and C, and uses D for testing.

## Risks
- **Vague locations:** use a fixed gazetteer of about 30 localities. Reports below a confidence threshold go to the coordinator's queue instead of being guessed.
- **The Wait node's resume URL must be publicly reachable for Telegram:** use a cloudflared tunnel in the demo, with a manual approve webhook as a fallback.
- **Demo determinism:** the replay uses fixed timestamps with a speed-up factor, and the mock feeds stand in for live APIs during the demo.
