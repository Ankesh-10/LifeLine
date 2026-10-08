# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Lifeline is a backend-only hackathon project: an n8n-based flood-response dispatcher. It turns messy distress messages into ranked incidents, matches them to boats, ambulances and volunteers, dispatches, and verifies help arrived.

- **`PLAN.md` is the source of truth.** It lists 30 planned commits, the files for each, and the order. Check `git log` to see what has landed. Use its commit messages and paths; don't invent a new layout.
- Built so far:
  - Committed (1–26): the foundation, the DB schema, `core/`, the simulation, and the workflow steps in core, the workflow SQL (migration 009), the import/export scripts and the n8n workflows. They're verified by PGlite and a workflow emulator, but haven't run in a real n8n yet.
  - Still to come: the live e2e test, the benchmark, CI and docs.

## Commit policy (user instruction, standing)

- **Do not commit**, and do not run `git init`, `git add` or `git commit`, until the user explicitly says so.
- Instead, **maintain the commit list in `PLAN.md`**. Whenever files are created, renamed, removed or re-scoped, update the matching commit row (message + files) in the same turn. Add new rows under the right purpose group, and keep numbering in order.
- Mark progress in each row's **Status** column: `todo`, `written` (files exist locally) or `committed`.

## Hard rules

- **Scope is frozen:** one city; resources are `boat`, `ambulance`, `volunteer_team`; needs are `rescue`, `medical`, `supplies`.
- **No frontend.** The map is out of scope. The backend only exposes the `v_incident_map` view.
- **Everything is simulated.** Label feeds, responders and messages **SIMULATED**. Never claim integration with government or emergency systems.
- **Human in the loop.** Approval is triggered by the risk of being wrong, never by urgency. Contradicted, conflicting or stale evidence, low extraction confidence, committing the last resource of a type, and any broadcast pass the n8n Wait-node gate. Rules live in `core/config/policy.json`.
- **Audit everything.** Every action writes to `audit_log`, which is append-only (a trigger blocks UPDATE and DELETE).
- **Logic lives in `core/`, not in workflow JSON.** n8n Code nodes are thin wrappers: `require('lifeline-core').cluster(...)`.

## Architecture

```
01-ingest  ─►  02-conditions  ─►  03-triage  ─►  04-dispatch  ─►  05-replies  ─►  06-watchdog
webhook +      weather/river      cluster →      match →          LLM reads        silence/blocked
vision LLM     poll               fuse → score   policy → Wait    reply → re-plan  → reassign via 04
                                                        99-error-handler → audit_log
```

**`core/` (`lifeline-core`)** is plain JS with no n8n dependency, tested with node:test. A custom image (`infra/n8n/Dockerfile`) installs it, and `NODE_FUNCTION_ALLOW_EXTERNAL=lifeline-core` lets Code nodes call it.

| Module | Contract |
|---|---|
| `cluster` | DBSCAN on haversine distance plus scaled time gap; merges into open incidents first |
| `fusion` | Checks gauge and rainfall data; returns `corroborated` / `unverified` / `contradicted` with reasons |
| `score` | Weighted sum (`core/config/weights.json`); must return a per-factor breakdown, stored as `incidents.score_breakdown` |
| `match` | Hard constraints, then priority-weighted ETA (greedy pass plus swaps); returns rejected options with reasons |
| `lifecycle` | `new → triaged → awaiting_approval → dispatched → en_route → on_scene → resolved` (+ reassign); resolves only when **both** responder and requester confirm |
| `policy` | `auto` vs `needs_approval`, with reasons; modes `manual` / `assisted` / `autonomous` |

All core functions are pure: they take plain objects (`{ lat, lon }` points, ISO-8601 times) and return results, patches and actions. They never perform I/O; n8n applies the results to the DB. Tune behaviour through `core/config/*.json` and each module's `DEFAULTS`, not by hard-coding values in workflows.

**Data:** Postgres + PostGIS, with Supabase-compatible SQL. `db/migrations/` are numbered and append-only.

**Locations:** `core.resolveLocation` tries a pin first, then the gazetteer (`core/config/gazetteer.json`, tolerating one typo), then gives `null` so the report goes to human review. Nothing is ever guessed.

**Simulation (`sim/`, no deps):**
- `scenarios/flood-city.json` holds 30 messages with ground truth of 6 incidents. It's derived from `core/test/fixtures/messages-30.json`, so change both together. `sim/test/demo.test.js` asserts the whole demo story (incidents, evidence, plan, both beats) without a DB. Re-run it after touching the scenario, `conditions.json`, the seed, or the core configs.
- The bot scripts its demo beats **by place**: a road vehicle to Saidapet reports a blocked road, and the first dispatch to Pallikaranai goes silent.
- The sim fixes the webhook contracts n8n must honour. They're listed under "Contracts fixed by the sim" in `PLAN.md`.

## Commands

These work now:

| Task | Command |
|---|---|
| Core tests (94) | `cd core && npm test` |
| Single test file | `cd core && node --test test/cluster.test.js` |
| Lint core | `cd core && npm run lint` (`npm install` first) |
| Sim tests (17, including the demo story on a static snapshot) | `cd sim && npm test` |
| SQL + workflow tests (32), no Docker: migrations on PGlite, and the workflow JSON run by an emulator | `cd tests && npm install && npm test` |
| Print the emulated demo story | `cd tests && LIFELINE_DEBUG=1 node --test n8n/run.test.js` |
| Mock gauge/rain API on :4010 | `cd sim && npm run feeds` |
| Responder bot on :4020 | `cd sim && npm run bot` |
| Replay the scenario into n8n | `cd sim && node replay.js [--speed 20] [--dry-run]` |

These are written but unverified (Docker isn't installed on the dev machine yet):

| Task | Command |
|---|---|
| Start stack + migrate + seed + import workflows | `scripts/setup.sh`; afterwards `docker compose up -d` |
| Re-run migrations / seeds | `scripts/migrate.sh` |
| Import / export workflows | `scripts/import-workflows.sh` / `scripts/export-workflows.sh` |

These are planned (the files don't exist yet):

| Task | Command |
|---|---|
| Demo reset | `scripts/reset-demo.sh` |
| E2E / benchmark | `node --test tests/e2e/` / `node bench/run.js` |

After editing a workflow in the n8n UI, always run `scripts/export-workflows.sh` so the JSON in `n8n/workflows/` stays canonical; it strips credentials and timestamps, and `tests/n8n/workflows.test.js` fails on an un-normalised export. Each workflow reads with one `lifeline_*_input()` SQL function and writes with one `lifeline_apply_*()` (migration 009), and its Code nodes are one-line calls into `core.pipeline` / `core.ingest` / `core.messages`.

## Model guide

### For development work (`/model` in Claude Code)

| Model | Use for | Examples in this repo |
|---|---|---|
| **Opus 5.5**: default for hard work | Design and logic where correctness matters | `cluster`, `fusion`, `match`, `lifecycle`; workflow wiring across 03–06; reviewing core changes; stubborn bugs |
| **Sonnet 5** | Routine, well-specified work | SQL migrations, seeds, simulated scenario data, tests for an existing contract, docs, scripts, Dockerfile |
| **Haiku 4.5** | Mechanical and high-volume work | Renames, formatting, JSON reshaping, file searches; Explore subagents |

- **Effort:** use `high`/`xhigh` for `core/` and anything in the approval or audit path. Use `low`/`medium` for docs, seeds and mechanical edits. If Opus struggles, raise its effort before anything else.
- **Subagents:** send exploration and search to Haiku and parallel boilerplate to Sonnet. Keep core reasoning on Opus.
- **Escalate** to the next model up only after a concrete failure, such as a failing test or wrong output, not just in case.

### For the runtime LLM calls in n8n workflows

**Not final.** The runtime will use **free-tier APIs**; no paid credits are assumed. Keep the provider swappable.

- **Never hard-code a provider or model.** Read `LLM_PROVIDER`, `LLM_MODEL_EXTRACT`, `LLM_MODEL_CLASSIFY` and `LLM_API_KEY` from env. Prefer n8n's generic chat-model nodes, or an OpenAI-compatible HTTP call, so switching providers is a config change.
- **What each step needs** (choose any free model that meets it):

| Step | Needs | Volume |
|---|---|---|
| `01-ingest` extraction (text + photo → strict JSON) | Vision + reliable JSON output | Every message: the highest load |
| `05-replies` reply classification (6 labels) | Small, fast model; JSON or enum output | Every responder reply |
| `04-dispatch` responder message drafting | Small model, or a plain template (no LLM) | Per dispatch |

- **Candidate free options to evaluate:** Google Gemini API free tier (vision), Groq free tier (fast text models), OpenRouter `:free` models, or local Ollama (no limits, but slower and you need hardware). Check current rate limits before choosing; they change often.
- **Design for free-tier limits:**
  - Rate-limit and retry with backoff in n8n.
  - Cache extraction results by message hash so demo replays don't re-call the API.
  - Have `SIM_MODE` fall back to pre-recorded extractions in `sim/` so the demo works offline or rate-limited.
- **Deterministic code, never an LLM:** clustering, scoring, matching and policy. That keeps them explainable and testable, and means the free model's quality only affects extraction and reply reading.
- **Validate every LLM output** against a JSON schema. On failure, retry once, then send the item to the coordinator's queue.

## Environment

The dev machine is Windows; run shell scripts with Git Bash. Secrets go in `.env` (template: `.env.example`): Postgres, the n8n encryption key, the Telegram bot token, the `LLM_*` provider settings, the coordinator chat ID and `SIM_MODE`.
