'use strict';

// The whole SIMULATED demo through the real SQL and lifeline-core, exactly as the
// n8n workflows call them (n8n itself is the only thing missing):
// 30 messages -> 6 incidents -> plan -> approval -> blocked road -> silent boat -> resolution.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScenario, buildPayload } = require('../../sim/lib/scenario');
const { snapshot } = require('../../sim/lib/feeds');
const conditionsData = require('../../sim/conditions.json');
const { freshDb, rows, steps } = require('../lib/db');

const scenario = loadScenario();
const START = Date.parse(scenario.referenceStart);
const at = (min) => new Date(START + min * 60000).toISOString();
const truthOfMessage = new Map(scenario.messages.map((m) => [m.id, m.truthIncident]));
const WATCHDOG_ENV = { WATCHDOG_ACK_MINUTES: '1', WATCHDOG_HEARTBEAT_MINUTES: '1' };

let db;
const truth = {}; // truth id -> incident uuid
const live = {}; // truth id -> live dispatch row

async function incidentOf(truthId) {
  const [row] = await rows(db, 'SELECT status FROM incidents WHERE id = $1', [truth[truthId]]);
  return row;
}
async function liveDispatch(truthId) {
  const [row] = await rows(db, 'SELECT dispatch_id AS "dispatchId", resource_id AS "resourceId", dispatch_status AS status FROM v_live_dispatch WHERE incident_id = $1', [truth[truthId]]);
  return row;
}
const say = (truthId, text, intentHint, role = 'responder') => ({
  role, dispatchId: live[truthId].dispatchId, resourceId: live[truthId].resourceId, incidentId: truth[truthId], text, intentHint, simulated: true,
});

test.before(async () => { db = await freshDb(); });
test.after(async () => { await db.close(); });

test('the demo story', async (t) => {
  await t.test('ingest + triage on a 1-minute tick: 30 messages become the 6 true incidents', async () => {
    const end = Math.max(...scenario.messages.map((m) => m.offsetMin)) + 3;
    for (let minute = 0; minute <= end; minute++) {
      for (const msg of scenario.messages.filter((m) => m.offsetMin > minute - 1 && m.offsetMin <= minute)) {
        const result = await steps.ingest(db, buildPayload(msg, { runId: 'story', sentAt: at(msg.offsetMin) }));
        assert.equal(result.duplicate, false);
      }
      if (minute % 5 === 0) await steps.conditions(db, snapshot(conditionsData, { simMinutes: minute, nowMs: START + minute * 60000 }), at(minute));
      await steps.triage(db, at(minute));
    }
    await steps.conditions(db, snapshot(conditionsData, { simMinutes: 55, nowMs: START + 55 * 60000 }), at(55));
    await steps.triage(db, at(55));

    const reports = await rows(db, 'SELECT external_id, incident_id, status FROM reports');
    assert.equal(reports.length, 30);
    assert.ok(reports.every((r) => r.status === 'clustered'), 'every report is attached, including the two with no location');
    for (const r of reports) {
      const id = truthOfMessage.get(r.external_id.replace('story-', ''));
      truth[id] ??= r.incident_id;
      assert.equal(r.incident_id, truth[id], `${r.external_id} belongs with ${id}`);
    }
    assert.equal(new Set(Object.values(truth)).size, 6);
    const [{ n }] = await rows(db, "SELECT count(*)::int AS n FROM incidents WHERE status = 'triaged'");
    assert.equal(n, 6);
    const [tamb] = await rows(db, 'SELECT evidence_status FROM incidents WHERE id = $1', [truth.I6]);
    assert.equal(tamb.evidence_status, 'contradicted');
  });

  await t.test('dispatch: the tested plan goes out, Tambaram waits for the coordinator', async () => {
    const { dispatches } = await steps.dispatch(db, at(55));
    const byTruth = Object.fromEntries(Object.entries(truth).map(([k, v]) => [k, dispatches.find((d) => d.incidentId === v)]));
    assert.deepEqual(
      Object.fromEntries(Object.entries(byTruth).map(([k, d]) => [k, `${d.resourceId}:${d.status}`])),
      { I1: 'B1:sent', I2: 'B3:sent', I3: 'A1:sent', I4: 'B4:sent', I5: 'V3:sent', I6: 'V1:awaiting_approval' },
    );
    assert.ok(byTruth.I6.approvalReasons.includes('evidence is contradicted'));
    assert.equal((await incidentOf('I6')).status, 'awaiting_approval');
    Object.assign(live, byTruth);

    const queue = await rows(db, 'SELECT dispatch_id FROM v_approval_queue');
    assert.equal(queue.length, 1);
  });

  await t.test('coordinator dismisses the contradicted Tambaram claim; the team is freed', async () => {
    const result = await steps.approve(db, live.I6, { decision: 'dismiss', by: 'coordinator-1' }, at(55.5));
    assert.equal(result.applied, true);
    assert.equal((await incidentOf('I6')).status, 'dismissed');
    const [v1] = await rows(db, "SELECT status FROM resources WHERE id = 'V1'");
    assert.equal(v1.status, 'available');
    assert.deepEqual(result.replan?.dispatches ?? [], [], 'dismissed incidents are not re-planned');
  });

  await t.test('beat 1: the ambulance to Saidapet reports a blocked road; another ambulance is re-routed automatically', async () => {
    for (const id of ['I1', 'I2', 'I3', 'I4', 'I5']) await steps.reply(db, say(id, `${live[id].resourceId} copy`, 'ack'), at(56));
    const result = await steps.reply(db, say('I3', 'Road to Saidapet is blocked, fallen tree near the bridge', 'blocked'), at(56.5));
    assert.equal(result.rematch, true);
    const [block] = await rows(db, "SELECT reported_by, applies_to FROM route_blocks WHERE active");
    assert.deepEqual(block, { reported_by: 'A1', applies_to: 'road' });

    const replacement = result.replan.dispatches[0];
    assert.notEqual(replacement.resourceId, 'A1');
    assert.equal(replacement.resourceType, 'ambulance');
    assert.equal(replacement.status, 'sent', 'reassignment after a blocked road needs no approval');
    assert.equal(replacement.action, 'reassign');
    live.I3 = replacement;
    const [old] = await rows(db, "SELECT status, close_reason FROM dispatches WHERE resource_id = 'A1'");
    assert.deepEqual(old, { status: 'failed', close_reason: 'route_blocked' });
  });

  await t.test('beat 2: the boat to Pallikaranai goes silent; the watchdog hands the job to the last boat, which needs approval', async () => {
    for (const id of ['I1', 'I2', 'I3', 'I5']) await steps.reply(db, say(id, 'on the way', id === 'I3' ? 'ack' : 'en_route'), at(57.5));
    const result = await steps.watchdog(db, at(58), { env: WATCHDOG_ENV });
    assert.equal(result.reassigned, 1, 'only the silent boat');
    const [b4] = await rows(db, "SELECT status FROM resources WHERE id = 'B4'");
    assert.equal(b4.status, 'offline');

    const next = result.replan.dispatches[0];
    assert.deepEqual([next.resourceId, next.status, next.action], ['B2', 'awaiting_approval', 'reassign']);
    assert.deepEqual(next.approvalReasons, ['commits the last available boat']);

    const decision = await steps.approve(db, next, { decision: 'approve', by: 'coordinator-1' }, at(58.5));
    assert.equal(decision.notifyResponder, true);
    assert.equal(decision.dispatch.status, 'sent');
    assert.equal((await incidentOf('I4')).status, 'dispatched');
    live.I4 = await liveDispatch('I4');
    assert.equal(live.I4.resourceId, 'B2');
  });

  await t.test('resolution needs both confirmations', async () => {
    await steps.reply(db, say('I1', 'Reached Velachery, starting evacuation', 'on_scene'), at(59));
    await steps.reply(db, say('I1', 'All people moved to safety. B1 done here.', 'resolved'), at(60));
    assert.equal((await incidentOf('I1')).status, 'on_scene', 'responder alone cannot close it');

    await steps.reply(db, say('I1', 'Yes, the team reached us, we are safe now', 'confirmed', 'requester'), at(61));
    assert.equal((await incidentOf('I1')).status, 'resolved');
    const [d] = await rows(db, "SELECT status, close_reason FROM dispatches WHERE resource_id = 'B1'");
    assert.deepEqual(d, { status: 'completed', close_reason: 'confirmed_by_both' });
    const [b1] = await rows(db, "SELECT status, ST_Y(geom::geometry) AS lat FROM resources WHERE id = 'B1'");
    assert.equal(b1.status, 'available');
    assert.notEqual(b1.lat, 12.979, 'the boat is now where the incident was');
  });

  await t.test('a late reply from the silent boat is ignored, not applied', async () => {
    const [old] = await rows(db, "SELECT id FROM dispatches WHERE resource_id = 'B4'");
    const result = await steps.reply(db, { role: 'responder', dispatchId: old.id, resourceId: 'B4', text: 'sorry, radio died, on the way', intentHint: 'en_route' }, at(62));
    assert.equal(result.applied, false);
  });

  await t.test('the audit trail tells the whole story', async () => {
    const counts = Object.fromEntries((await rows(db, 'SELECT action, count(*)::int AS n FROM audit_log GROUP BY action')).map((r) => [r.action, r.n]));
    assert.equal(counts['report.received'], 30);
    assert.equal(counts['incident.created'], 6);
    assert.equal(counts['dispatch.sent'], 6, '5 initial + the re-routed ambulance');
    assert.equal(counts['dispatch.approval_requested'], 2);
    for (const action of ['incident.dismissed', 'dispatch.approved', 'reply.blocked', 'route_block.added', 'dispatch.reassigned', 'incident.resolved', 'reply.ignored', 'conditions.updated']) {
      assert.ok(counts[action] >= 1, `audit has ${action}`);
    }
    const map = await rows(db, 'SELECT data_label FROM v_incident_map');
    assert.equal(map.length, 5, 'dismissed incident is off the map');
    assert.ok(map.every((m) => m.data_label === 'SIMULATED'));
    assert.equal((await rows(db, 'SELECT 1 FROM v_approval_queue')).length, 0);
  });
});
