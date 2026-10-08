'use strict';

// Migrations, seeds, guards and individual workflow functions on real Postgres + PostGIS.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { freshDb, call, input, rows, steps } = require('../lib/db');

const NOW = '2026-12-01T04:00:00.000Z';
const at = (min) => new Date(Date.parse(NOW) + min * 60000).toISOString();
const body = (id, extra = {}) => ({
  source: 'replay', externalId: `t-${id}`, senderId: `s-${id}`, sentAt: NOW, simulated: true,
  text: 'Water inside our house in Velachery, 3 of us',
  hint: { extraction: { needType: 'rescue', people: 3, vulnerable: [], locationText: 'Velachery', inWater: true, confidence: 0.9 } },
  ...extra,
});

let db;
test.before(async () => { db = await freshDb(); });
test.after(async () => { await db.close(); });

test('migrations and seeds apply; seeds are re-runnable', async () => {
  const seedDir = path.join(__dirname, '..', '..', 'db', 'seed');
  for (const f of fs.readdirSync(seedDir)) await db.exec(fs.readFileSync(path.join(seedDir, f), 'utf8'));
  const [{ n }] = await rows(db, 'SELECT count(*)::int AS n FROM resources WHERE simulated');
  assert.equal(n, 10);
  const [{ lat }] = await rows(db, "SELECT ST_Y(geom::geometry) AS lat FROM resources WHERE id = 'B1'");
  assert.equal(lat, 12.979);
});

test('audit_log is append-only', async () => {
  await call(db, 'lifeline_log', { actor: 'system', actorId: 'test', action: 'test.event', entityType: 'test', reason: 'x' });
  for (const sql of ['UPDATE audit_log SET reason = NULL', 'DELETE FROM audit_log', 'TRUNCATE audit_log']) {
    await assert.rejects(db.exec(sql), /append-only/);
  }
});

test('boats must be water craft, road vehicles must not be', async () => {
  await assert.rejects(db.exec("INSERT INTO resources (id, name, type, terrain, capacity, speed_kmh, geom) VALUES ('X', 'x', 'boat', 'road', 1, 1, ST_MakePoint(80, 13)::geography)"), /check/i);
});

test('n8n-style literals survive quotes, backslashes and unicode', async () => {
  const text = "it's \"fine\" \\ back\\slash -- ; DROP TABLE reports; paid $100, $1 left; வெள்ளம்";
  const r = await steps.ingest(db, body('quote', { text }));
  const [{ raw_text: raw }] = await rows(db, 'SELECT raw_text FROM reports WHERE id = $1', [r.id]);
  assert.equal(raw, text);
});

test('ingest: duplicates are dropped and audited; failed extraction goes to review with its pin', async () => {
  const first = await steps.ingest(db, body('dup'));
  assert.equal(first.duplicate, false);
  assert.equal((await steps.ingest(db, body('dup'))).duplicate, true);
  const [{ n }] = await rows(db, "SELECT count(*)::int AS n FROM audit_log WHERE action = 'report.duplicate' AND entity_id = 't-dup'");
  assert.equal(n, 1);

  const noLlm = await steps.ingest(db, body('nollm', { hint: undefined, pin: { lat: 12.98, lon: 80.22 } }), { env: { SIM_MODE: 'false' } });
  const [rep] = await rows(db, 'SELECT status, review_reason, ST_Y(geom::geometry) AS lat FROM reports WHERE id = $1', [noLlm.id]);
  assert.deepEqual(rep, { status: 'needs_review', review_reason: 'extraction_failed', lat: 12.98 });
  const queue = await rows(db, 'SELECT review_reason FROM v_review_queue');
  assert.ok(queue.some((q) => q.review_reason === 'extraction_failed'));
});

test('ingest: LLM extractions are cached by message hash and reused on replay', async () => {
  const env = { SIM_MODE: 'true', LLM_PROVIDER: 'groq', LLM_MODEL_EXTRACT: 'm', LLM_API_KEY: 'k' };
  const answer = { needType: 'medical', people: 2, vulnerable: ['injured'], locationText: 'Saidapet', inWater: false, confidence: 0.8 };
  let calls = 0;
  const llmResponse = (attempt) => {
    calls++;
    return attempt === 1 ? { choices: [{ message: { content: 'not json' } }] } : { choices: [{ message: { content: JSON.stringify(answer) } }] };
  };
  const text = 'My father fell and is bleeding, Saidapet bridge, 2 of us';
  await steps.ingest(db, body('llm1', { text }), { env, llmResponse });
  assert.equal(calls, 2, 'one retry after a bad answer');
  const second = await steps.ingest(db, body('llm2', { text }), { env, llmResponse });
  assert.equal(calls, 2, 'cache hit: no further LLM calls');
  const [rep] = await rows(db, "SELECT need_type, extracted->>'source' AS src FROM reports WHERE id = $1", [second.id]);
  assert.deepEqual(rep, { need_type: 'medical', src: 'cache' });
});

test('conditions: each poll replaces the gauge history instead of piling up re-stamped copies', async () => {
  const feed = (shiftMin) => ({
    gauges: [{ id: 'G1', name: 'g', lat: 12.98, lon: 80.22, warningLevelM: 3, dangerLevelM: 4, readings: [0, 30, 60].map((m, i) => ({ at: at(m - 60 - shiftMin), levelM: 3 + i * 0.1 })) }],
    rainfall: [{ areaId: 'a1', lat: 12.98, lon: 80.22, at: at(-shiftMin), mmLast3h: 40 }],
  });
  await steps.conditions(db, feed(0), NOW);
  await steps.conditions(db, feed(19), NOW);
  const [{ n }] = await rows(db, "SELECT count(*)::int AS n FROM gauge_readings WHERE gauge_id = 'G1'");
  const [{ r }] = await rows(db, "SELECT count(*)::int AS r FROM rainfall_readings WHERE area_id = 'a1'");
  assert.deepEqual([n, r], [3, 1]);
  const inp = await input(db, 'lifeline_triage_input', NOW);
  assert.equal(inp.gauges.find((g) => g.id === 'G1').readings.length, 3);
});

test('triage: a report with no location waits for its sender, then joins their incident', async () => {
  const sender = 'family-77';
  const vague = body('vague', { senderId: sender, sentAt: at(1), text: 'still waiting, water rising', hint: { extraction: { needType: 'rescue', people: 3, vulnerable: ['elderly'], locationText: null, inWater: true, confidence: 0.8 } } });
  await steps.ingest(db, vague);
  await steps.triage(db, at(2));
  const [held] = await rows(db, "SELECT status, review_reason FROM reports WHERE external_id = 't-vague'");
  assert.deepEqual(held, { status: 'needs_review', review_reason: 'no_location' });

  await steps.ingest(db, body('located', { senderId: sender, sentAt: at(3), pin: { lat: 13.0186, lon: 80.2413 }, text: 'Kotturpuram, 3 people' }));
  await steps.triage(db, at(4));
  const [joined] = await rows(db, "SELECT r.status, i.report_count, i.vulnerable FROM reports r JOIN incidents i ON i.id = r.incident_id WHERE r.external_id = 't-vague'");
  assert.equal(joined.status, 'clustered');
  assert.equal(joined.report_count, 2);
  assert.deepEqual(joined.vulnerable, ['elderly']);
  const audits = await rows(db, "SELECT action FROM audit_log WHERE entity_type = 'report' AND action = 'report.needs_review'");
  assert.equal(audits.length, 1, 'the retry is not re-audited on every run');
});

test('apply functions refuse stale plans instead of overwriting newer state', async () => {
  const plan = { now: NOW, dispatchId: '00000000-0000-0000-0000-000000000000', expectedDispatchStatus: 'awaiting_approval', dispatchPatch: { status: 'sent' }, actions: [], actor: 'system', actorId: 't', auditAction: 'dispatch.approved', decision: 'approve' };
  assert.equal((await call(db, 'lifeline_apply_approval', plan)).applied, false);
  const reply = await call(db, 'lifeline_apply_reply', { role: 'responder', intent: 'ack', dispatchId: null, actions: [{ type: 'ignore', reason: 'unknown dispatch' }] });
  assert.equal(reply.applied, false);
});
