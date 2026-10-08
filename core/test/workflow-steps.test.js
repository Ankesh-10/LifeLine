'use strict';

// The functions n8n Code nodes call, one per workflow step (core/src/pipeline.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/pipeline');
const messages = require('./fixtures/messages-30.json');

const NOW = '2026-12-01T04:30:00Z';
const later = (min) => new Date(Date.parse(NOW) + min * 60000).toISOString();
const hoursAgo = (h) => new Date(Date.parse(NOW) - h * 3600000).toISOString();
const readings = (levels) => levels.map((levelM, i) => ({ at: hoursAgo(levels.length - 1 - i), levelM }));
const gauges = [
  { id: 'G-PALLI', lat: 12.94, lon: 80.215, warningLevelM: 3, dangerLevelM: 4, readings: readings([3.0, 3.2, 3.4]) },
  { id: 'G-TAMB', lat: 12.9249, lon: 80.105, warningLevelM: 3, dangerLevelM: 4, readings: readings([2.2, 2.1, 2.0]) },
];
const reports = messages.map(({ truthIncident: _t, ...r }) => ({ ...r, status: 'extracted' }));

const boat = (id, lat, lon, extra = {}) => ({ id, type: 'boat', terrain: 'water', capacity: 10, hasMedic: false, speedKmh: 8, status: 'available', location: { lat, lon }, ...extra });
const team = (id, lat, lon, extra = {}) => ({ id, type: 'volunteer_team', terrain: 'road', capacity: 6, hasMedic: false, speedKmh: 20, status: 'available', location: { lat, lon }, ...extra });
const incident = (id, extra = {}) => ({
  id, status: 'triaged', score: 60, needType: 'rescue', needs: ['rescue'], people: 4, vulnerable: [],
  location: { lat: 12.98, lon: 80.22 }, evidence: { status: 'corroborated', flooded: true, conflict: false, stale: false }, extractionConfidence: 0.9, ...extra,
});

test('sqlJson makes a safe SQL literal: quotes doubled, no $ for pg-promise, NUL dropped, JSON intact', () => {
  const lit = p.sqlJson({ text: "it's ok'); DROP TABLE x; -- pay $100 or $1", nul: 'a\u0000b' });
  assert.ok(lit.startsWith("'") && lit.endsWith("'"));
  const inner = lit.slice(1, -1);
  assert.ok(!/(^|[^'])'([^']|$)/.test(inner), 'no lone quote can end the literal');
  assert.ok(!inner.includes('$'), 'no $n placeholders for pg-promise to substitute');
  assert.deepEqual(JSON.parse(inner.replace(/''/g, "'")), { text: "it's ok'); DROP TABLE x; -- pay $100 or $1", nul: 'ab' });
});

test('planConditions keeps valid gauges and rainfall only', () => {
  const plan = p.planConditions({
    gauges: [{ id: 'G1', lat: 13, lon: 80, warningLevelM: 3, dangerLevelM: 4, readings: [{ at: NOW, levelM: 3.1 }, { at: 'bad', levelM: 1 }] }, { id: 'G2', lat: 13 }],
    rainfall: [{ areaId: 'a', lat: 13, lon: 80, at: NOW, mmLast3h: 12 }, { areaId: 'b', lat: 13, lon: 80, at: NOW, mmLast3h: -1 }],
  }, NOW);
  assert.deepEqual(plan.gauges.map((g) => [g.id, g.readings.length]), [['G1', 1]]);
  assert.deepEqual(plan.rainfall.map((r) => r.areaId), ['a']);
  assert.equal(plan.hasChanges, true);
});

test('triage: 30 reports become 6 triaged incidents with evidence, score and extraction confidence', () => {
  const plan = p.triage({ now: NOW, reports, incidents: [], gauges, rainfall: [] });
  assert.equal(plan.created.length, 6);
  for (const c of plan.created) {
    assert.equal(c.status, 'triaged');
    assert.ok(c.score.score > 0 && c.score.factors.severity);
    assert.ok(c.extractionConfidence > 0.5 && c.extractionConfidence <= 1);
  }
  assert.equal(plan.hasChanges, true);
});

test('triage re-assessment writes only material changes', () => {
  const first = p.triage({ now: NOW, reports, incidents: [], gauges, rainfall: [] });
  const byId = new Map(reports.map((r) => [r.id, r]));
  const open = first.created.map((c, i) => ({
    id: `inc-${i}`, status: 'triaged', score: c.score.score, evidenceStatus: c.evidence.status, stale: c.evidence.stale, flooded: c.evidence.flooded,
    reports: c.reportIds.map((id) => byId.get(id)),
  }));
  const same = p.triage({ now: NOW, reports: [], incidents: open, gauges, rainfall: [] });
  assert.deepEqual([same.created.length, same.updated.length, same.rescored.length, same.hasChanges], [0, 0, 0, false]);

  const hourLater = p.triage({ now: later(60), reports: [], incidents: open, gauges, rainfall: [] });
  assert.ok(hourLater.rescored.length > 0, 'waiting time raises scores');
  assert.match(hourLater.rescored[0].changes.join(' '), /score/);
});

test('triage: unlocated reports are queued as no_location (retried), low confidence stays with the human', () => {
  const plan = p.triage({
    now: NOW,
    reports: [
      { id: 'x1', senderId: 'nobody', sentAt: NOW, needType: 'rescue', people: 2, confidence: 0.9, status: 'extracted' },
      { id: 'x2', senderId: 's', sentAt: NOW, lat: 13, lon: 80.2, needType: 'rescue', people: 2, confidence: 0.2, status: 'needs_review' },
    ],
  });
  assert.deepEqual(plan.reviews.map((r) => [r.reportId, r.reviewReason, r.alreadyQueued]), [['x2', 'low_confidence', true], ['x1', 'no_location', false]]);
});

test('planDispatch: auto for clean evidence, approval for contradicted, and the last boat of a batch is caught', () => {
  const plan = p.planDispatch({
    now: NOW,
    incidents: [
      incident('high', { score: 90, location: { lat: 12.98, lon: 80.22 } }),
      incident('mid', { score: 70, location: { lat: 12.93, lon: 80.21 } }),
      incident('doubt', { score: 20, location: { lat: 12.925, lon: 80.1 }, flooded: false, evidence: { status: 'contradicted', flooded: false } }),
      incident('busy', { status: 'dispatched' }),
    ],
    resources: [boat('B1', 12.979, 80.22), boat('B2', 12.94, 80.21), team('V1', 12.95, 80.14), team('V2', 13.0, 80.25)],
  });
  const by = Object.fromEntries(plan.dispatches.map((d) => [d.incidentId, d]));
  assert.deepEqual(Object.keys(by).sort(), ['doubt', 'high', 'mid'], 'only triaged incidents are planned');
  assert.equal(by.high.status, 'sent');
  assert.equal(by.high.incidentStatus, 'dispatched');
  assert.equal(by.mid.decision, 'needs_approval', 'second boat of two is the last available boat');
  assert.deepEqual(by.mid.policyReasons, ['commits the last available boat']);
  assert.equal(by.mid.incidentStatus, 'awaiting_approval');
  assert.ok(by.doubt.policyReasons.includes('evidence is contradicted'));
  assert.ok(by.high.match.reasons.length > 0);
});

test('planDispatch: a replacement is a reassign and skips excluded resources', () => {
  const plan = p.planDispatch({
    now: NOW,
    incidents: [incident('I', { replacesDispatchId: 'd-old', excludeResourceIds: ['B1'] })],
    resources: [boat('B1', 12.98, 80.22), boat('B2', 12.99, 80.22), boat('B3', 13.0, 80.22)],
  });
  assert.equal(plan.dispatches[0].action, 'reassign');
  assert.equal(plan.dispatches[0].resourceId, 'B2');
  assert.equal(plan.dispatches[0].replacesDispatchId, 'd-old');
  assert.equal(p.planDispatch({ now: NOW, incidents: [], resources: [] }).hasDispatches, false);
});

test('policyFromEnv switches modes; manual mode gates every dispatch', () => {
  const policyConfig = p.policyFromEnv({ POLICY_MODE: 'manual' });
  assert.equal(policyConfig.mode, 'manual');
  assert.equal(p.policyFromEnv({ POLICY_MODE: 'bogus' }).mode, 'assisted');
  const plan = p.planDispatch({ now: NOW, incidents: [incident('I')], resources: [boat('B1', 12.98, 80.22), boat('B2', 12.99, 80.22)] }, { policyConfig });
  assert.equal(plan.dispatches[0].status, 'awaiting_approval');
});

test('planApproval: approve, reject, dismiss, timeout and a forged link', () => {
  const dispatch = { dispatchId: 'd1', incidentId: 'i1', resourceId: 'B2' };
  const run = (query, extra = {}) => p.planApproval({ dispatch, query, expectedToken: 'tok', now: NOW, ...extra });

  const ok = run({ decision: 'approve', token: 'tok', by: 'asha' });
  assert.deepEqual([ok.dispatchPatch.status, ok.incidentStatus, ok.notifyResponder, ok.actorId], ['sent', 'dispatched', true, 'asha']);
  assert.equal(ok.dispatchPatch.sentAt, '2026-12-01T04:30:00.000Z');

  const reject = run({ decision: 'reject', token: 'tok' });
  assert.deepEqual([reject.dispatchPatch.status, reject.incidentStatus, reject.rematch], ['rejected', 'triaged', true]);
  assert.deepEqual(reject.actions, [{ type: 'release_resource', resourceId: 'B2' }]);

  assert.equal(run({ decision: 'dismiss', token: 'tok' }).incidentStatus, 'dismissed');
  const timeout = run(undefined, { timedOut: true });
  assert.deepEqual([timeout.dispatchPatch.closeReason, timeout.incidentStatus, timeout.rematch, timeout.actor], ['approval_timeout', 'triaged', true, 'system']);
  assert.equal(run({ decision: 'approve', token: 'wrong' }).decision, 'invalid');
  assert.equal(run({ decision: 'launch', token: 'tok' }).decision, 'invalid');
});

test('reply classification: LLM when configured, SIMULATED hint in SIM_MODE, otherwise unclear', () => {
  const reply = p.fromReplyWebhook({ role: 'responder', dispatchId: 'd1', text: 'Road blocked near bridge', intentHint: 'blocked', sentAt: NOW });
  assert.equal(p.planClassification({ reply, env: { SIM_MODE: 'true' } }).intent, 'blocked');
  assert.equal(p.planClassification({ reply, env: {} }).intent, 'unclear');
  const viaLlm = p.planClassification({ reply, env: { LLM_PROVIDER: 'groq', LLM_MODEL_EXTRACT: 'm', LLM_API_KEY: 'k' } });
  assert.equal(viaLlm.route, 'llm');
  const answer = (intent) => ({ choices: [{ message: { content: JSON.stringify({ intent }) } }] });
  assert.equal(p.acceptIntent({ plan: viaLlm, response: answer('blocked') }).intent, 'blocked');
  assert.equal(p.acceptIntent({ plan: viaLlm, response: answer('panic') }).intent, 'unclear');
  assert.throws(() => p.fromReplyWebhook({ role: 'boss', text: 'x' }), /role must be/);
});

test('planReplyEffects: blocked re-plans, both confirmations resolve, stale replies are ignored', () => {
  const incidentRow = { id: 'i1', status: 'dispatched', location: { lat: 13.02, lon: 80.22 } };
  const resource = { id: 'A1', location: { lat: 13.0, lon: 80.22 } };
  const d = { id: 'd1', incidentId: 'i1', resourceId: 'A1', status: 'acknowledged' };

  const blocked = p.planReplyEffects({ role: 'responder', intent: 'blocked', dispatch: d, incident: incidentRow, resource, now: NOW });
  assert.equal(blocked.incidentStatus, 'triaged');
  assert.equal(blocked.rematch, true);
  assert.deepEqual(blocked.actions.map((a) => a.type), ['add_route_block', 'release_resource', 'rematch']);

  const ack = p.planReplyEffects({ role: 'responder', intent: 'ack', dispatch: { ...d, status: 'en_route' }, incident: { ...incidentRow, status: 'en_route' }, resource, now: NOW });
  assert.equal(ack.incidentStatus, null, 'no backwards move');

  const done = p.planReplyEffects({ role: 'responder', intent: 'resolved', dispatch: { ...d, status: 'on_scene' }, incident: { ...incidentRow, status: 'on_scene' }, resource, now: NOW });
  assert.equal(done.dispatchPatch.status, 'on_scene');
  assert.equal(done.incidentStatus, null, 'waits for the requester');
  assert.match(done.notices[0], /waiting for the requester/);

  const confirmed = p.planReplyEffects({
    role: 'requester', intent: 'confirmed',
    dispatch: { ...d, status: 'on_scene', responderConfirmedAt: NOW }, incident: { ...incidentRow, status: 'on_scene' }, resource, now: later(1),
  });
  assert.equal(confirmed.dispatchPatch.status, 'completed');
  assert.equal(confirmed.incidentStatus, 'resolved');

  const late = p.planReplyEffects({ role: 'responder', intent: 'ack', dispatch: { ...d, status: 'reassigned' }, incident: incidentRow, resource, now: NOW });
  assert.equal(late.actions[0].type, 'ignore');
});

test('planWatchdog: env timeouts, silent team reassigned, escalation sent only once', () => {
  const opts = p.watchdogOptions({ WATCHDOG_ACK_MINUTES: '1', WATCHDOG_HEARTBEAT_MINUTES: '1', WATCHDOG_CONFIRM_MINUTES: 'x' });
  assert.deepEqual(opts, { ackTimeoutMinutes: 1, heartbeatTimeoutMinutes: 1 });
  const ago = (m) => new Date(Date.parse(NOW) - m * 60000).toISOString();
  const dispatches = [
    { id: 'd1', incidentId: 'i1', incidentStatus: 'dispatched', resourceId: 'B1', status: 'acknowledged', sentAt: ago(3), lastHeartbeatAt: ago(2) },
    { id: 'd2', incidentId: 'i2', incidentStatus: 'on_scene', resourceId: 'B2', status: 'on_scene', sentAt: ago(9), lastHeartbeatAt: ago(1), responderConfirmedAt: ago(5) },
  ];
  const plan = p.planWatchdog({ now: NOW, dispatches }, { ...opts, confirmTimeoutMinutes: 2 });
  assert.equal(plan.reassignments.length, 1);
  assert.deepEqual([plan.reassignments[0].incidentStatus, plan.reassignments[0].resourcePatch.status], ['triaged', 'offline']);
  assert.deepEqual(plan.escalations.map((e) => e.reason), ['requester_unconfirmed']);
  const again = p.planWatchdog({ now: NOW, dispatches: [dispatches[0], { ...dispatches[1], escalatedAt: ago(1) }] }, { ...opts, confirmTimeoutMinutes: 2 });
  assert.equal(again.escalations.length, 0);
});

test('audit helpers: delivery outcome and workflow errors', () => {
  const d = { dispatchId: 'd1', resourceId: 'B1' };
  assert.equal(p.deliveryEvent(d, { channel: 'sim' }, { accepted: true }).action, 'dispatch.delivered');
  assert.equal(p.deliveryEvent(d, { channel: 'sim' }, { error: { message: 'ECONNREFUSED' } }).payload.error, 'ECONNREFUSED');
  assert.equal(p.deliveryEvent(d, { channel: 'none', reason: 'no chat' }, {}).action, 'dispatch.delivery_skipped');
  const e = p.errorEvent({ execution: { id: '9', error: { message: 'boom' }, lastNodeExecuted: 'Apply' }, workflow: { id: 'w', name: '03-triage' } });
  assert.deepEqual([e.action, e.actorId, e.reason, e.payload.lastNodeExecuted], ['workflow.error', '03-triage', 'boom', 'Apply']);
});

test('triage: reports landing on a recently closed incident go to a human, not to a new dispatch', () => {
  const closedIncidents = [
    { id: 'done', status: 'resolved', location: { lat: 12.9815, lon: 80.218 }, lastReportedAt: NOW, closedAt: later(2), senderIds: ['fam'] },
    { id: 'gone', status: 'dismissed', location: { lat: 12.9249, lon: 80.1 }, lastReportedAt: NOW, closedAt: later(1), senderIds: [] },
  ];
  const r = (id, extra) => ({ id, senderId: `s-${id}`, sentAt: later(5), needType: 'rescue', people: 3, confidence: 0.9, status: 'extracted', ...extra });
  const plan = p.triage({
    now: later(6),
    closedIncidents,
    reports: [
      r('dup', { lat: 12.982, lon: 80.2181 }),
      r('relay', { senderId: 'fam' }), // no location, same sender as the resolved incident
      r('tamb', { lat: 12.925, lon: 80.1002 }),
      r('new', { lat: 13.0186, lon: 80.2413 }),
    ],
  });
  assert.deepEqual(plan.late.map((l) => [l.reportId, l.incidentId, l.reviewReason]), [
    ['dup', 'done', 'after_resolution'],
    ['relay', 'done', 'after_resolution'],
    ['tamb', 'gone', 'after_dismissal'],
  ]);
  assert.equal(plan.created.length, 1, 'a report somewhere else is still a new incident');
  assert.deepEqual(plan.created[0].reportIds, ['new']);
});
