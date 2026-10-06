'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lc = require('../src/lifecycle');
const { matchResources } = require('../src/match');

const NOW = '2026-12-01T05:00:00Z';
const minsAgo = (m) => new Date(Date.parse(NOW) - m * 60000).toISOString();
const dispatch = (extra = {}) => ({ id: 'd1', incidentId: 'i1', resourceId: 'V1', status: 'en_route', sentAt: minsAgo(10), lastHeartbeatAt: minsAgo(2), ...extra });
const incident = { location: { lat: 13, lon: 80.22 } };
const resource = { location: { lat: 13, lon: 80.2 } };

test('incident transitions: valid path and rejected jumps', () => {
  let s = 'new';
  for (const e of ['triage', 'dispatch', 'en_route', 'on_scene', 'resolve']) s = lc.transitionIncident(s, e);
  assert.equal(s, 'resolved');
  assert.throws(() => lc.transitionIncident('new', 'resolve'), lc.InvalidTransitionError);
  assert.throws(() => lc.transitionIncident('resolved', 'reassign'), /invalid incident transition/);
  assert.equal(lc.canTransition('dispatched', 'reassign'), true);
});

test('blocked reply: fail dispatch, record the block, free the team, re-match', () => {
  const plan = lc.planReply({ dispatch: dispatch(), intent: 'blocked', incident, resource, now: NOW });
  assert.equal(plan.dispatchPatch.status, 'failed');
  assert.equal(plan.dispatchPatch.closeReason, 'route_blocked');
  assert.equal(plan.incidentEvent, 'reassign');
  assert.deepEqual(plan.actions.map((a) => a.type), ['add_route_block', 'release_resource', 'rematch']);
  assert.equal(plan.actions[0].location.lat, 13);
  assert.ok(Math.abs(plan.actions[0].location.lon - 80.21) < 1e-9, 'block sits midway along the route');
  assert.deepEqual(plan.actions[2].excludeResourceIds, ['V1']);
});

test('re-plan: the recorded block makes the matcher route around it', () => {
  const plan = lc.planReply({ dispatch: dispatch(), intent: 'blocked', incident, resource, now: NOW });
  const block = plan.actions.find((a) => a.type === 'add_route_block');
  const team = (id, lon) => ({ id, type: 'volunteer_team', terrain: 'road', capacity: 6, speedKmh: 20, status: 'available', location: { lat: 13, lon } });
  const r = matchResources({
    incidents: [{ id: 'i1', score: 70, needType: 'rescue', needs: ['rescue'], people: 3, flooded: false, ...incident }],
    resources: [team('V1', 80.2), team('V2', 80.25)],
    blocks: [block],
  });
  assert.equal(r.assignments[0].resourceId, 'V2');
  assert.match(r.assignments[0].rejected[0].reason, /route blocked/);
});

test('resolution needs both responder and requester confirmation (either order)', () => {
  const first = lc.planReply({ dispatch: dispatch({ status: 'on_scene' }), intent: 'resolved', incident, resource, now: NOW });
  assert.equal(first.incidentEvent, null);
  assert.equal(first.dispatchPatch.status, 'on_scene');
  assert.deepEqual(first.actions.map((a) => a.type), ['ask_requester_confirmation']);

  const after = dispatch({ status: 'on_scene', responderConfirmedAt: first.dispatchPatch.responderConfirmedAt });
  const done = lc.planRequesterConfirmation(after, NOW);
  assert.equal(done.dispatchPatch.status, 'completed');
  assert.equal(done.incidentEvent, 'resolve');
  assert.deepEqual(done.actions, [{ type: 'release_resource', resourceId: 'V1' }]);

  const requesterFirst = lc.planRequesterConfirmation(dispatch({ status: 'on_scene' }), NOW);
  assert.deepEqual(requesterFirst.actions.map((a) => a.type), ['ask_responder_confirmation']);
  const responderSecond = lc.planReply({
    dispatch: dispatch({ status: 'on_scene', requesterConfirmedAt: requesterFirst.dispatchPatch.requesterConfirmedAt }),
    intent: 'resolved', incident, resource, now: NOW,
  });
  assert.equal(responderSecond.dispatchPatch.status, 'completed');
  assert.equal(responderSecond.incidentEvent, 'resolve');
});

test('replies to closed dispatches are ignored; unknown intents throw', () => {
  const plan = lc.planReply({ dispatch: dispatch({ status: 'completed' }), intent: 'ack', incident, resource, now: NOW });
  assert.deepEqual(plan.actions, [{ type: 'ignore', reason: 'dispatch is completed' }]);
  assert.throws(() => lc.planReply({ dispatch: dispatch(), intent: 'dance', incident, resource }), RangeError);
});

test('every reply is a heartbeat; ack moves sent -> acknowledged', () => {
  const plan = lc.planReply({ dispatch: dispatch({ status: 'sent' }), intent: 'ack', incident, resource, now: NOW });
  assert.equal(plan.dispatchPatch.status, 'acknowledged');
  assert.equal(plan.dispatchPatch.lastHeartbeatAt, new Date(NOW).toISOString());
});

test('watchdog: no ack and silence reassign; stuck confirmation escalates', () => {
  const findings = lc.checkTimeouts(
    [
      dispatch({ id: 'noack', status: 'sent', sentAt: minsAgo(6), lastHeartbeatAt: null }),
      dispatch({ id: 'silent', status: 'en_route', lastHeartbeatAt: minsAgo(20) }),
      dispatch({ id: 'unconfirmed', status: 'on_scene', responderConfirmedAt: minsAgo(40), lastHeartbeatAt: minsAgo(5) }),
      dispatch({ id: 'healthy', status: 'en_route', lastHeartbeatAt: minsAgo(3) }),
      dispatch({ id: 'closed', status: 'completed', lastHeartbeatAt: minsAgo(300) }),
    ],
    NOW,
  );
  assert.deepEqual(
    findings.map((f) => [f.dispatchId, f.reason, f.action]),
    [
      ['noack', 'no_ack', 'reassign'],
      ['silent', 'silent', 'reassign'],
      ['unconfirmed', 'requester_unconfirmed', 'escalate'],
    ],
  );
});

test('reassignment takes the silent resource offline and re-matches without it', () => {
  const [finding] = lc.checkTimeouts([dispatch({ status: 'en_route', lastHeartbeatAt: minsAgo(20) })], NOW);
  const plan = lc.planReassignment(finding, NOW);
  assert.equal(plan.dispatchPatch.status, 'reassigned');
  assert.deepEqual(plan.resourcePatch, { id: 'V1', status: 'offline' });
  assert.equal(plan.incidentEvent, 'reassign');
  assert.deepEqual(plan.actions[0].excludeResourceIds, ['V1']);
});
