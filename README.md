# Lifeline

**Decision support for flood-response coordinators.** Lifeline fuses scattered distress messages with river-gauge and rainfall data. It collapses duplicates into incidents, ranks them by an explainable priority score, matches them to boats, ambulances and volunteer teams under real constraints, and verifies that help arrived. A human coordinator approves risky actions, and every step is audit-logged.

> ⚠️ **Simulated demo.** All feeds, responders and messages in this repo are simulated. Lifeline is not integrated with any government or emergency-service system, and it does not replace them.

## How it works

```
messages ─► extract (LLM) ─► cluster + dedupe ─► cross-check gauges/rain ─► score ─► match ─► approve? ─► dispatch ─► verify / re-plan
```

| Stage | Where |
|---|---|
| Orchestration (triggers, LLM calls, approval Wait node) | n8n workflows in `n8n/workflows/` |
| Reasoning (clustering, evidence fusion, scoring, matching, lifecycle, policy) | `core/` (`lifeline-core`), plain JS with unit tests |
| Storage, append-only audit log, map/queue views | Postgres + PostGIS, `db/` |
| Simulated flood scenario, feeds and responders | `sim/` |

## Quick start

```bash
scripts/setup.sh                 # creates .env, starts n8n + PostGIS, runs migrations
cd core && npm install && npm test
```

- n8n: http://localhost:5678
- Postgres: `localhost:5432`

## Status

Work in progress. `PLAN.md` holds the build plan and commit checklist.

## License

MIT
