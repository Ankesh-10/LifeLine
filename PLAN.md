# Lifeline: backend build plan

Lifeline is decision support for a human flood-response coordinator. All feeds and responders are **simulated**, and it does not integrate with any government system.

**Scope (frozen):** one city, 3 resource types (`boat`, `ambulance`, `volunteer_team`) and 3 need types (`rescue`, `medical`, `supplies`). The map UI is **out of scope**. The backend exposes a `v_incident_map` view that a Leaflet page can read later.

---

## Architecture

```
Telegram / replay webhook ──► [01 ingest] ──► reports
Schedule (60s) ─────────────► [02 conditions] ──► gauge_readings, rainfall_readings
Schedule (20s) ─────────────► [03 triage]  cluster → fuse → score ──► incidents
                                   │
                                   ▼
Schedule (30s) / 03, 05, 06 ─► [04 dispatch]  match → policy ─┬─ auto ──────────────► message responder
                                                              └─ [04 approval gate] ─► Wait (coordinator link) ─► message responder
responder replies ──────────► [05 replies]  classify reply → lifecycle → re-plan
Schedule (30s) ─────────────► [06 watchdog] silence / stuck confirmation → reassign via 04
Every step ─────────────────► audit_log (append-only)        any failure ─► [99 error handler] ─► audit_log
```

- **Runtime:** self-hosted n8n and Postgres + PostGIS in Docker Compose. The SQL is Supabase-compatible, so you can switch to hosted Supabase when the map is built.
- **Reasoning code:** a pure-JS package, `lifeline-core`. It's unit-tested outside n8n and installed into a custom n8n image (`NODE_FUNCTION_ALLOW_EXTERNAL=lifeline-core`). Every Code node is one call into `core.pipeline` / `core.ingest` / `core.messages`.
- **Database writes:** each workflow reads with one `lifeline_*_input()` SQL function and writes a core-computed plan with one `lifeline_apply_*()` function (`db/migrations/009`). Every write and its `audit_log` row share a transaction.
- **LLM:** any OpenAI-compatible **free-tier** endpoint (Gemini, Groq, OpenRouter, Ollama), called by an HTTP Request node and chosen through `LLM_*` env vars. Answers are schema-validated in core. `SIM_MODE` falls back to the scenario's pre-recorded extractions. Prompts are versioned in `n8n/prompts/`.

---

## Final tree

```
LifeLine/
├── README.md  PLAN.md  CLAUDE.md  LICENSE  .gitignore  .editorconfig  .env.example
├── docker-compose.yml
├── infra/n8n/Dockerfile  .dockerignore
├── db/
│   ├── migrations/001_extensions.sql … 009_workflow_functions.sql
│   └── seed/resources.sql  seed/shelters.sql
├── core/                         # lifeline-core (no n8n dependency)
│   ├── package.json  eslint.config.js
│   ├── config/weights.json  policy.json  gazetteer.json
│   ├── src/index.js geo.js time.js geocode.js cluster.js fusion.js score.js match.js lifecycle.js policy.js
│   │       llm.js ingest.js messages.js pipeline.js        # workflow steps
│   └── test/*.test.js  test/fixtures/
├── n8n/
│   ├── workflows/01-ingest.json … 06-watchdog.json  04-approval-gate.json  99-error-handler.json
│   └── prompts/extract.md  responder-reply.md
├── sim/                          # lifeline-sim (no deps, reuses ../core)
│   ├── scenarios/flood-city.json   # 30 messages + 6 ground-truth incidents
│   ├── conditions.json  responders.json  package.json
│   ├── lib/scenario.js feeds.js bot.js http.js
│   ├── mock-feeds.js  replay.js  responder-bot.js
│   └── test/*.test.js
├── tests/                        # lifeline-tests: no Docker needed (PGlite)
│   ├── lib/db.js  lib/n8n.js     # PGlite harness, n8n workflow emulator
│   ├── db/*.test.js  n8n/*.test.js
│   └── e2e/scenario.test.js      # needs the live stack
├── bench/run.js  bench/manual-baseline.md
├── scripts/setup.sh  migrate.sh  import-workflows.sh  export-workflows.sh  normalize-workflows.js  reset-demo.sh
├── docs/ARCHITECTURE.md  DATA-MODEL.md  SAFETY.md  DEMO.md
└── .github/workflows/ci.yml
```

---

## Commits, grouped by purpose

> Commits 1–26 are in `git log`. The rest is a maintained list: it's updated whenever files change, and commits happen only when the user says so.
> Status: `todo` → `written` (files exist locally) → `committed`.

### A. Foundation

| # | Commit | Files | Status |
|---|---|---|---|
| 1 | `Initial setup` | `README.md`, `LICENSE`, `.gitignore`, `.editorconfig`, `.env.example`, `PLAN.md`, `CLAUDE.md` | committed |
| 2 | `Docker setup` | `docker-compose.yml`, `infra/n8n/Dockerfile`, `.dockerignore`, `scripts/setup.sh` | committed (not run: Docker not installed on dev machine) |

### B. Data layer

| # | Commit | Files | Status |
|---|---|---|---|
| 3 | `Database setup` | `scripts/migrate.sh`, `db/migrations/001_extensions.sql`, `002_enums.sql` | committed |
| 4 | `Database tables` | `003_reports.sql`, `004_incidents.sql`, `005_resources.sql` (+ shelters), `006_dispatches.sql` (+ route_blocks), `007_conditions.sql` (gauges, rainfall) | committed |
| 5 | `Audit log and views` | `008_audit_and_views.sql`, `docs/DATA-MODEL.md` | committed |
| 6 | `Seed data` | `db/seed/resources.sql`, `db/seed/shelters.sql` | committed |

Migrations 001–009 and both seeds now run in the PGlite tests (commit 19), so the SQL is verified on Postgres 17 + PostGIS even without Docker.

### C. Reasoning core (`lifeline-core`): the tech depth

| # | Commit | Files | Status |
|---|---|---|---|
| 7 | `Core setup` | `core/package.json`, `core/package-lock.json`, `core/eslint.config.js`, `core/src/geo.js`, `core/src/time.js`, `core/test/geo.test.js` | committed |
| 8 | `Clustering` | `core/src/cluster.js`, `core/test/cluster.test.js`, `core/test/fixtures/messages-30.json` | committed |
| 9 | `Evidence check` | `core/src/fusion.js`, `core/test/fusion.test.js` | committed |
| 10 | `Priority score` | `core/src/score.js`, `core/config/weights.json`, `core/test/score.test.js` | committed |
| 11 | `Resource matching` | `core/src/match.js`, `core/test/match.test.js` | committed |
| 12 | `Incident lifecycle` | `core/src/lifecycle.js`, `core/test/lifecycle.test.js` | committed |
| 13 | `Approval policy` | `core/src/policy.js`, `core/config/policy.json`, `core/test/policy.test.js` | committed |
| 14 | `Location lookup` | `core/src/geocode.js`, `core/config/gazetteer.json`, `core/test/geocode.test.js`, `core/src/index.js`, `core/test/pipeline.test.js` | committed |

What each module does:
- **cluster:** DBSCAN over a combined space-time distance, with a chaining guard so neighbouring reports can't merge into one huge cluster. New reports join open incidents first. Reports without a location inherit the incident of an earlier report from the same sender. Low-confidence or unlinkable reports go to human review. `people` is the max across reports, not the sum.
- **fusion:** checks the nearest gauge (level + least-squares trend) and the rainfall. It returns `corroborated` / `unverified` / `contradicted` with reasons. Three or more independent reporters override a sensor but set `conflict`. Medical and supplies needs are never contradicted by water data. It also outputs the `stale` and `flooded` flags.
- **score:** a 0–100 weighted sum of severity, vulnerability, people, water risk, report count and time waiting, times an evidence multiplier (contradicted ×0.5, stale ×0.6). It returns a per-factor breakdown.
- **match:** hard constraints (flooded → boat, capacity for rescue, blocked road, max ETA, resources that already failed this incident), then a greedy pass in priority order followed by local search (swaps, moves, refills) on priority-weighted cost. A swap never delays the higher-priority incident by more than 10 minutes. Every assignment explains itself, including its alternatives and the rejected options.
- **lifecycle:** the incident state machine, plus the effects of each responder reply: a blocked road becomes a route block, then the resource is released and the incident re-matched. Resolution needs **both** confirmations. A watchdog reassigns silent teams and escalates stuck confirmations.
- **policy:** approval depends on the risk of being wrong, not on urgency. It's required for contradicted, conflicting or stale evidence, low extraction confidence, committing the last available resource of a type, and any broadcast. Reassignment after silence or a blocked road runs automatically. Modes are `manual`, `assisted` and `autonomous`.

### D. Simulation (all labelled SIMULATED)

| # | Commit | Files | Status |
|---|---|---|---|
| 15 | `Flood scenario` | `sim/package.json`, `sim/scenarios/flood-city.json`, `sim/lib/scenario.js`, `sim/test/helpers.js`, `sim/test/scenario.test.js` | committed |
| 16 | `Mock sensor feeds` | `sim/conditions.json`, `sim/lib/feeds.js`, `sim/lib/http.js`, `sim/mock-feeds.js`, `sim/test/feeds.test.js` | committed |
| 17 | `Replay and responder bot` | `sim/replay.js`, `sim/responders.json`, `sim/lib/bot.js`, `sim/responder-bot.js`, `sim/test/bot.test.js`, `sim/test/demo.test.js` | committed |

- The scenario has 30 messy messages: duplicates, typos ("Velacheri", "Pallikarnai"), 12 map pins, one photo, and two follow-ups with no location that are attached via their sender. Tambaram's claims are contradicted by a low, falling gauge. Each message carries the extraction an LLM should produce (`hint`, used in `SIM_MODE` and by the benchmark). Ground truth never leaves the simulator.
- Feed readings are timestamped relative to now, so river trends stay in true m/h even when the replay runs at 20×.
- The bot's scripts are keyed by **place**, not resource, because live assignments depend on arrival order: the first *road* vehicle sent to Saidapet reports "road blocked", and the first dispatch to Pallikaranai acknowledges and then goes silent. Replacements behave normally, and normal runs end with the requester confirming.
- `demo.test.js` checks the story on a static snapshot. The tested plan is: I2→B3, I1→B1, I4→B4, I3→A1, I5→V3, and I6→V1 (needs approval). In the live run (commit 26's emulated test) the order of arrival changes some picks: for example, the boat that finished Velachery takes over the silent one at Pallikaranai.

### E. n8n workflows

| # | Commit | Files | Status |
|---|---|---|---|
| 18 | `Workflow steps` | `core/src/llm.js`, `core/src/ingest.js`, `core/src/messages.js`, `core/src/pipeline.js`, `core/src/index.js`, `core/src/match.js`, `core/test/llm.test.js`, `core/test/ingest.test.js`, `core/test/messages.test.js`, `core/test/workflow-steps.test.js`, `core/test/match.test.js`, `n8n/prompts/extract.md`, `n8n/prompts/responder-reply.md` | committed |
| 19 | `Workflow database functions` | `db/migrations/009_workflow_functions.sql`, `docs/DATA-MODEL.md`, `tests/package.json`, `tests/package-lock.json`, `tests/lib/db.js`, `tests/db/schema.test.js`, `tests/db/story.test.js` | committed (tested on PGlite) |
| 20 | `Workflow import/export` | `scripts/import-workflows.sh`, `scripts/export-workflows.sh`, `scripts/normalize-workflows.js`, `infra/n8n/Dockerfile`, `docker-compose.yml`, `.env.example`, `.dockerignore` | committed (not run: no Docker) |
| 21 | `Ingest workflow` | `n8n/workflows/01-ingest.json` | committed |
| 22 | `Conditions workflow` | `n8n/workflows/02-conditions.json` | committed |
| 23 | `Triage workflow` | `n8n/workflows/03-triage.json` | committed |
| 24 | `Dispatch workflow` | `n8n/workflows/04-dispatch.json`, `n8n/workflows/04-approval-gate.json` | committed |
| 25 | `Replies workflow` | `n8n/workflows/05-replies.json` | committed |
| 26 | `Watchdog workflow` | `n8n/workflows/06-watchdog.json`, `n8n/workflows/99-error-handler.json`, `tests/lib/n8n.js`, `tests/n8n/workflows.test.js`, `tests/n8n/run.test.js` | committed (emulated) |

**Status:** core 94/94, sim 17/17, tests 32/32 (`cd tests && npm install && npm test`, no Docker). The workflow JSON has been run only by the emulator in `tests/lib/n8n.js`, not by a real n8n yet.

- **18:** one function per Code node (`core.pipeline.triage`, `planDispatch`, `planApproval`, `planReplyEffects`, `planWatchdog`, …), the LLM request builders and schema validation (`core.llm`), message normalisation and the extraction fallback chain (`core.ingest`), and outgoing texts (`core.messages`, plain templates, no LLM). `sqlJson()` inlines plans as safe SQL literals (quotes doubled, `$` escaped for pg-promise). Prompts live here because `core.llm` loads them; the planned `dispatch-message.md` was dropped in favour of the template.
- **19:** migration 009 adds the input/apply functions, `extraction_cache`, `v_approval_queue` (clickable approve/reject/dismiss links, the fallback when Telegram isn't set up) and `v_review_queue`. `tests/db/story.test.js` runs the whole demo through the real SQL and core.
- **20:** `import-workflows.sh` creates the "Lifeline DB" credential from `.env` with a fixed id, imports the workflows and activates the ones with triggers. `export-workflows.sh` exports and normalises (no credentials, no timestamps). The image now also carries `n8n/prompts`.
- **26:** `tests/lib/n8n.js` emulates the n8n features these workflows use and runs the exported JSON against PGlite. `tests/n8n/run.test.js` replays the scenario at 20× with the real bot scripts and feeds, and asserts 6 incidents, both beats, a dismissed Tambaram claim and 5 two-sided resolutions.

Contracts fixed by the sim (the workflows match them, and `tests/n8n/workflows.test.js` checks the paths):
- **Replay webhook** `POST /webhook/lifeline/replay` takes `{source, externalId, senderId, sentAt, text, pin?, media?, hint?, simulated}`.
- **Telegram webhook** `POST /webhook/lifeline/telegram` takes Telegram updates (point `setWebhook` at it; optional `TELEGRAM_WEBHOOK_SECRET`). A plain webhook, so no n8n Telegram credential is needed.
- **Simulated dispatch:** for resources whose `contact_chat_id` starts with `sim-`, 04 posts `{dispatchId, incidentId, resourceId, resourceType, location}` to `SIM_BOT_URL/dispatch` instead of Telegram.
- **Replies webhook** `POST /webhook/lifeline/replies` takes `{role: responder|requester, resourceId, dispatchId, incidentId, text, intentHint?, sentAt}`.
- **Triage** re-tries reports held back only for missing location on every run; low-confidence reports stay with the human. Reports that land on an incident resolved or dismissed in the last 2 h attach to it and go to the review queue (`after_resolution` / `after_dismissal`), never to a new dispatch.
- **Watchdog timeouts** come from env (`WATCHDOG_ACK_MINUTES`, `WATCHDOG_HEARTBEAT_MINUTES`, `WATCHDOG_CONFIRM_MINUTES`), so the demo can use about 1 minute instead of 15.

What each workflow does:
- **01-ingest:** replay and Telegram webhooks → normalise → extraction cache lookup → LLM (OpenAI-compatible HTTP, one retry on a schema failure) or, in `SIM_MODE`, the `hint` → `core.resolveLocation` (pin → gazetteer → null) → `lifeline_ingest_report` (dedupe on `externalId`, cache, audit). Telegram photos go to the vision model as data URLs and are never stored.
- **02-conditions:** a Schedule node fetches `WEATHER_API_URL/conditions` and replaces the gauge and rainfall history.
- **03-triage:** `cluster` → `fusion` → `score` over new reports and every open incident; writes only material changes, then calls 04 if anything is waiting.
- **04-dispatch:** `match` → `policy`. Auto dispatches go straight to the responder; risky ones go to **04-approval-gate**, one execution per approval: it stores the Wait node's resume URL with a random token, messages the coordinator (Telegram, or `v_approval_queue`), and waits. Approve sends; reject re-plans without that resource; dismiss closes the incident; a timeout cancels and re-asks.
- **05-replies:** classifies the reply (LLM, or `intentHint` in `SIM_MODE`, or "unclear"), applies `lifecycle` (heartbeat, route block + re-plan, two-sided resolution), and notifies the coordinator when needed.
- **06-watchdog:** dispatches with no acknowledgement or heartbeat are reassigned via 04 (the silent resource goes offline); stuck confirmations escalate once.
- **99:** catches any workflow failure and logs it to `audit_log`.

### F. Verification, benchmark, CI, docs

| # | Commit | Files | Status |
|---|---|---|---|
| 27 | `End-to-end test` | `tests/e2e/scenario.test.js`, `scripts/reset-demo.sh` | todo |
| 28 | `Benchmark` | `bench/run.js`, `bench/manual-baseline.md` | todo |
| 29 | `CI` | `.github/workflows/ci.yml` | todo |
| 30 | `Docs` | `docs/ARCHITECTURE.md`, `docs/SAFETY.md`, `docs/DEMO.md`, `README.md` | todo |

- **27:** replays the scenario against the live stack (real n8n) and asserts 6 incidents, all handled, one re-route, one reassignment and a complete audit trail. The emulated version already passes in `tests/n8n/run.test.js`.
- **28:** reports messages → incidents, dedupe precision/recall against ground truth, LLM extraction accuracy against `hint`, and time to full dispatch. The manual baseline states its assumptions, for example 45 s per message to read, tag and forward.
- **29:** runs core lint + tests, sim tests and the `tests/` package (PGlite and the workflow emulator need no services).

---

## Owner split (3 accounts)

| Account | Commits |
|---|---|
| 1: sim + data (map later) | 3–6, 15–17, 19 |
| 2: n8n + prompts | 2, 20–26 |
| 3: core + bench + pitch | 7–14, 18, 27–30 |

Commit 1 lands first. B, C and D can run in parallel. E depends on B and C, and uses D for testing.

## Risks
- **Vague locations:** use a fixed gazetteer of about 30 localities. Reports below a confidence threshold go to the coordinator's queue instead of being guessed.
- **The Wait node's resume URL must be reachable by the coordinator:** use a cloudflared tunnel in the demo (`WEBHOOK_URL`); `v_approval_queue` lists ready-to-click links as the fallback.
- **The workflows have not run in a real n8n yet:** node parameter shapes and versions follow n8n 1.x and were checked only by the emulator. Pin `N8N_VERSION` in `infra/n8n/Dockerfile` once a version is tested, and re-export after any fix in the UI.
- **Demo determinism:** the replay uses fixed timestamps with a speed-up factor, and the mock feeds stand in for live APIs during the demo.
