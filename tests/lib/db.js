'use strict';

// In-process Postgres + PostGIS (PGlite) with every migration and seed applied,
// plus one helper per n8n workflow that runs the same calls the workflow's
// nodes make: SQL input function -> lifeline-core step -> SQL apply function.

const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { postgis } = require('@electric-sql/pglite-postgis');
const core = require('../../core/src');

const DB_DIR = path.join(__dirname, '..', '..', 'db');
const sqlFiles = (dir) => fs.readdirSync(path.join(DB_DIR, dir)).filter((f) => f.endsWith('.sql')).sort().map((f) => path.join(DB_DIR, dir, f));

async function freshDb({ seed = true } = {}) {
  const db = await PGlite.create({ extensions: { postgis } });
  for (const file of sqlFiles('migrations')) await db.exec(fs.readFileSync(file, 'utf8'));
  if (seed) for (const file of sqlFiles('seed')) await db.exec(fs.readFileSync(file, 'utf8'));
  return db;
}

/** Call a jsonb function exactly like the n8n Postgres nodes do: the plan inlined as a quoted literal. */
async function call(db, fn, arg) {
  const { rows } = await db.query(`SELECT ${fn}(${core.pipeline.sqlJson(arg)}::jsonb) AS result`);
  return rows[0].result;
}

async function input(db, fn, now) {
  const { rows } = await db.query(`SELECT ${fn}($1::timestamptz) AS result`, [new Date(now).toISOString()]);
  return rows[0].result;
}

const rows = async (db, sql, params) => (await db.query(sql, params)).rows;

// ---- one helper per workflow ----------------------------------------------------

/** 01-ingest: normalise -> cache lookup -> plan -> (LLM) -> finalize -> insert. */
async function ingest(db, body, { env = { SIM_MODE: 'true' }, llmResponse } = {}) {
  const draft = core.ingest.fromReplay(body);
  const hash = core.ingest.extractionKey(draft, env);
  const [{ cached }] = await rows(db, `SELECT (SELECT jsonb_build_object('extracted', extracted, 'model', model) FROM extraction_cache WHERE hash = $1) AS cached`, [hash]);
  let plan = core.ingest.planExtraction({ draft, cached, env });
  if (plan.route === 'llm') {
    for (let attempt = 1; plan.route !== 'done'; attempt++) plan = core.ingest.acceptExtraction({ plan, response: llmResponse(attempt), attempt });
  }
  return call(db, 'lifeline_ingest_report', core.ingest.finalizeReport(plan));
}

/** 02-conditions */
async function conditions(db, feed, now) {
  return call(db, 'lifeline_apply_conditions', core.pipeline.planConditions(feed, now));
}

/** 03-triage */
async function triage(db, now) {
  const plan = core.pipeline.triage(await input(db, 'lifeline_triage_input', now));
  return plan.hasChanges ? call(db, 'lifeline_apply_triage', plan) : null;
}

/** 04-dispatch */
async function dispatch(db, now, { env = {} } = {}) {
  const plan = core.pipeline.planDispatch(await input(db, 'lifeline_dispatch_input', now), { policyConfig: core.pipeline.policyFromEnv(env) });
  return plan.hasDispatches ? call(db, 'lifeline_apply_dispatch', plan) : { dispatches: [], skipped: 0 };
}

/** 04-approval-gate: store the resume URL + token, then apply the coordinator's decision. */
async function approve(db, row, query, now, { timedOut = false } = {}) {
  const token = 'test-token';
  await call(db, 'lifeline_set_approval', { dispatchId: row.dispatchId, url: `http://n8n.test/webhook-waiting/${row.dispatchId}`, token, channel: 'none', reasons: row.approvalReasons.join('; ') });
  const plan = core.pipeline.planApproval({ dispatch: row, query: query && { token, ...query }, expectedToken: token, timedOut, now });
  const result = await call(db, 'lifeline_apply_approval', plan);
  if (result.rematch) result.replan = await dispatch(db, now);
  return result;
}

/** 05-replies */
async function reply(db, body, now, { env = { SIM_MODE: 'true' } } = {}) {
  const ctx = await call(db, 'lifeline_reply_context', core.pipeline.fromReplyWebhook(body));
  const cls = core.pipeline.planClassification({ reply: ctx.reply, env });
  const effects = core.pipeline.planReplyEffects({
    role: ctx.reply.role, intent: cls.intent, intentSource: cls.intentSource, text: ctx.reply.text,
    dispatch: ctx.dispatch, incident: ctx.incident, resource: ctx.resource, replyLocation: ctx.reply.location, now,
  });
  const result = await call(db, 'lifeline_apply_reply', effects);
  if (result.rematch) result.replan = await dispatch(db, now);
  return result;
}

/** 06-watchdog */
async function watchdog(db, now, { env = {} } = {}) {
  const plan = core.pipeline.planWatchdog(await input(db, 'lifeline_watchdog_input', now), core.pipeline.watchdogOptions(env));
  if (!plan.hasChanges) return { reassigned: 0, escalated: 0 };
  const result = await call(db, 'lifeline_apply_watchdog', plan);
  if (result.reassigned) result.replan = await dispatch(db, now);
  return result;
}

module.exports = { freshDb, call, input, rows, steps: { ingest, conditions, triage, dispatch, approve, reply, watchdog } };
