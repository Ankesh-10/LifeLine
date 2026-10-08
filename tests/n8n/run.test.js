'use strict';

// The full SIMULATED demo, end to end, through the exported workflow JSON:
// replay -> 01 -> 03 -> 04 -> (gate) -> responder bot -> 05 -> 06 -> resolution,
// with the real sim bot scripts, mock feeds and SQL. Only n8n itself is emulated.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScenario, buildPayload } = require('../../sim/lib/scenario');
const { snapshot } = require('../../sim/lib/feeds');
const { nearestPlace, chooseBehavior, planScript } = require('../../sim/lib/bot');
const responders = require('../../sim/responders.json');
const conditionsData = require('../../sim/conditions.json');
const { freshDb, rows } = require('../lib/db');
const { createN8n, createClock } = require('../lib/n8n');

const scenario = loadScenario();
const START = Date.parse(scenario.referenceStart);
const MIN = 60000;
const SPEED = 20; // as in the demo: node replay.js --speed 20, mock feeds SIM_SPEED=20
const END = START + 15 * MIN;
const truthOf = new Map(scenario.messages.map((m) => [`demo-${m.id}`, m.truthIncident]));

const ENV = {
  SIM_MODE: 'true',
  SIM_BOT_URL: 'http://bot.test:4020',
  WEATHER_API_URL: 'http://feeds.test:4010',
  APPROVAL_TIMEOUT_MINUTES: '5',
  WATCHDOG_ACK_MINUTES: '1',
  WATCHDOG_HEARTBEAT_MINUTES: '1',
  WATCHDOG_CONFIRM_MINUTES: '2',
};

let db;
let n8n;
const log = { dispatched: [], approvals: [], unexpectedHttp: [] };

test.before(async () => {
  db = await freshDb();
  const clock = createClock(START);
  const history = new Map();

  const http = async (req) => {
    if (req.url === 'http://feeds.test:4010/conditions') {
      return snapshot(conditionsData, { simMinutes: ((clock.now() - START) / MIN) * SPEED, nowMs: clock.now() });
    }
    if (req.url === 'http://bot.test:4020/dispatch') {
      // sim/responder-bot.js, minus the HTTP server: script replies onto the replies webhook.
      const { dispatchId, incidentId, resourceId, resourceType, location } = req.body;
      const place = nearestPlace(location);
      const behavior = chooseBehavior({ place, resourceType }, responders.placeScripts, history);
      log.dispatched.push({ resourceId, place, behavior, at: (clock.now() - START) / MIN });
      for (const step of planScript(behavior, { resourceId, place }, responders.timingSec)) {
        const { afterSec, ...reply } = step;
        clock.at(clock.now() + afterSec * 1000, () => n8n.webhook('05-replies', 'Replies webhook',
          { ...reply, resourceId, dispatchId, incidentId, sentAt: new Date(clock.now()).toISOString(), simulated: true }));
      }
      return { accepted: true, place, behavior };
    }
    log.unexpectedHttp.push(req.url);
    throw new Error(`unexpected HTTP call to ${req.url}`);
  };

  // Coordinator: approves, except claims that sensors contradict, which they dismiss.
  const onWait = ({ ctx }) => {
    const req = ctx.$('Prepare request').item.json;
    const decision = req.dispatch.incident.evidenceStatus === 'contradicted' ? 'dismiss' : 'approve';
    log.approvals.push({ resourceId: req.dispatch.resourceId, reasons: req.dispatch.approvalReasons, decision });
    return { decision, token: req.token, by: 'coordinator-1' };
  };

  n8n = createN8n({ db, env: ENV, http, clock, onWait });

  for (const msg of scenario.messages) {
    clock.at(START + (msg.offsetMin * MIN) / SPEED, () => n8n.webhook('01-ingest', 'Replay webhook', buildPayload(msg, { runId: 'demo', sentAt: new Date(clock.now()).toISOString() })));
  }
  clock.every(START, 60 * 1000, END, () => n8n.trigger('02-conditions', 'Every 60 seconds'));
  clock.every(START + 5000, 20 * 1000, END, () => n8n.trigger('03-triage', 'Every 20 seconds'));
  clock.every(START + 10000, 30 * 1000, END, () => n8n.trigger('04-dispatch', 'Every 30 seconds'));
  clock.every(START + 15000, 30 * 1000, END, () => n8n.trigger('06-watchdog', 'Every 30 seconds'));
  await clock.runUntil(END);
});

test.after(async () => {
  if (process.env.LIFELINE_DEBUG && db) {
    // LIFELINE_DEBUG=1 npm test: print the story the emulated run produced.
    console.log({ dispatched: log.dispatched, approvals: log.approvals });
    console.table(await rows(db, 'SELECT action, count(*)::int AS n FROM audit_log GROUP BY action ORDER BY action'));
    console.table(await rows(db, 'SELECT review_reason, count(*)::int AS n FROM reports WHERE status = \'needs_review\' GROUP BY 1'));
  }
  await db?.close();
});

test('no workflow failed and nothing called a real service', async () => {
  assert.deepEqual(n8n.errors.map((e) => `${e.workflow}: ${e.message}`), []);
  assert.deepEqual(log.unexpectedHttp, []);
  const [{ n }] = await rows(db, "SELECT count(*)::int AS n FROM audit_log WHERE action = 'workflow.error'");
  assert.equal(n, 0);
});

test('30 messages became exactly the 6 true incidents', async () => {
  const reports = await rows(db, 'SELECT external_id, incident_id FROM reports');
  assert.equal(reports.length, 30);
  const truth = {};
  for (const r of reports) {
    const id = truthOf.get(r.external_id);
    truth[id] ??= r.incident_id;
    assert.equal(r.incident_id, truth[id], `${r.external_id} belongs with ${id}`);
  }
  assert.equal(new Set(Object.values(truth)).size, 6);
  const [{ n }] = await rows(db, 'SELECT count(*)::int AS n FROM incidents');
  assert.equal(n, 6, 'late duplicates must not spawn new incidents');
  const late = await rows(db, "SELECT review_reason FROM v_review_queue WHERE review_reason LIKE 'after_%'");
  for (const r of late) assert.match(r.review_reason, /^after_(resolution|dismissal)$/);
});

test('both scripted beats happened: a blocked road at Saidapet and a silent boat at Pallikaranai', async () => {
  const behaviors = log.dispatched.map((d) => `${d.place}:${d.behavior}`);
  assert.ok(behaviors.includes('Saidapet:blocked'), behaviors.join(', '));
  assert.ok(behaviors.includes('Pallikaranai:silent'), behaviors.join(', '));
  const [block] = await rows(db, 'SELECT reported_by FROM route_blocks');
  assert.match(block.reported_by, /^A\d$/, 'an ambulance reported the block');
  const [{ n }] = await rows(db, "SELECT count(*)::int AS n FROM audit_log WHERE action = 'dispatch.reassigned'");
  assert.equal(n, 1);
});

test('the coordinator was asked only when being wrong was likely, and Tambaram was dismissed', async () => {
  assert.ok(log.approvals.length >= 1);
  for (const a of log.approvals) assert.ok(a.reasons.length > 0);
  assert.ok(log.approvals.some((a) => a.decision === 'dismiss' && a.reasons.includes('evidence is contradicted')));
  const statuses = await rows(db, 'SELECT status::text AS status, count(*)::int AS n FROM incidents GROUP BY status ORDER BY 1');
  assert.deepEqual(statuses, [{ status: 'dismissed', n: 1 }, { status: 'resolved', n: 5 }]);
});

test('every resolution was confirmed by both sides, and the trail is complete', async () => {
  const done = await rows(db, "SELECT close_reason, responder_confirmed_at IS NOT NULL AS r, requester_confirmed_at IS NOT NULL AS q FROM dispatches WHERE status = 'completed'");
  assert.equal(done.length, 5);
  assert.ok(done.every((d) => d.close_reason === 'confirmed_by_both' && d.r && d.q));
  const actions = new Set((await rows(db, 'SELECT DISTINCT action FROM audit_log')).map((r) => r.action));
  for (const a of ['report.received', 'incident.created', 'dispatch.sent', 'dispatch.delivered', 'approval.requested', 'reply.blocked', 'route_block.added', 'dispatch.reassigned', 'incident.resolved', 'conditions.updated']) {
    assert.ok(actions.has(a), `audit has ${a}`);
  }
});
