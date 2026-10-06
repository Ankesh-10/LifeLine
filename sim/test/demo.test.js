'use strict';

// The demo story, end to end on SIMULATED data:
// 30 messages -> 6 incidents -> evidence -> ranking -> dispatch -> blocked road -> silent team.

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../../core/src');
const conditions = require('../conditions.json');
const { snapshot } = require('../lib/feeds');
const { START_MS, streamTriage, truthOf, seedResources } = require('./helpers');

const SIM_MINUTES = 55;
const NOW_MS = START_MS + SIM_MINUTES * 60000;

function buildIncidents() {
  const { gauges, rainfall } = snapshot(conditions, { simMinutes: SIM_MINUTES, nowMs: NOW_MS });
  return streamTriage().incidents.map((inc) => {
    const summary = core.summarize(inc.reports);
    const evidence = core.assessEvidence(summary, { gauges, rainfall, now: NOW_MS });
    const { score } = core.scoreIncident(summary, evidence, { now: NOW_MS });
    return { ...summary, id: truthOf.get(inc.reports[0].id), evidence, score, flooded: evidence.flooded };
  });
}

const typeOf = (resources, id) => resources.find((r) => r.id === id).type;
const assignmentFor = (result, incidentId) => result.assignments.find((a) => a.incidentId === incidentId);

test('evidence: south is flooding, Tambaram claim is contradicted and ranks last', () => {
  const incidents = buildIncidents();
  const byId = Object.fromEntries(incidents.map((i) => [i.id, i]));
  for (const id of ['I1', 'I2', 'I4']) {
    assert.equal(byId[id].evidence.status, 'corroborated', id);
    assert.equal(byId[id].flooded, true, id);
  }
  assert.equal(byId.I3.flooded, false, 'Saidapet medical case is reachable by road');
  assert.equal(byId.I6.evidence.status, 'contradicted');
  assert.equal(core.rankIncidents(incidents).at(-1).id, 'I6');
});

test('dispatch plan: boats to flooded areas, ambulance to the injured, team to supplies; Tambaram needs approval', () => {
  const resources = seedResources();
  const result = core.matchResources({ incidents: buildIncidents(), resources });
  for (const id of ['I1', 'I2', 'I4']) assert.equal(typeOf(resources, assignmentFor(result, id).resourceId), 'boat', id);
  assert.equal(typeOf(resources, assignmentFor(result, 'I3').resourceId), 'ambulance');
  assert.equal(typeOf(resources, assignmentFor(result, 'I5').resourceId), 'volunteer_team');
  assert.deepEqual(result.unassigned, []);

  const i6 = buildIncidents().find((i) => i.id === 'I6');
  const decision = core.decide({ action: 'dispatch', evidence: i6.evidence, resourceType: 'volunteer_team', availableByType: { volunteer_team: 2 } });
  assert.equal(decision.decision, 'needs_approval');
  assert.ok(decision.reasons.includes('evidence is contradicted'));
});

test('beat: ambulance reports a blocked road -> block recorded -> different ambulance re-routed', () => {
  const incidents = buildIncidents();
  const resources = seedResources();
  const first = core.matchResources({ incidents, resources });
  const i3 = incidents.find((i) => i.id === 'I3');
  const original = assignmentFor(first, 'I3').resourceId;

  const plan = core.planReply({
    dispatch: { id: 'd-i3', incidentId: 'I3', resourceId: original, status: 'acknowledged' },
    intent: 'blocked',
    incident: i3,
    resource: resources.find((r) => r.id === original),
    now: NOW_MS,
  });
  const block = plan.actions.find((a) => a.type === 'add_route_block');
  const busy = new Set(first.assignments.filter((a) => a.incidentId !== 'I3').map((a) => a.resourceId));
  const pool = resources
    .filter((r) => r.id !== original)
    .map((r) => (busy.has(r.id) ? { ...r, status: 'assigned' } : r));

  const replan = core.matchResources({ incidents: [i3], resources: pool, blocks: [block] });
  const replacement = replan.assignments[0].resourceId;
  assert.notEqual(replacement, original);
  assert.equal(typeOf(resources, replacement), 'ambulance');
  assert.equal(core.decide({ action: 'reassign', evidence: i3.evidence, resourceType: 'ambulance', availableByType: { ambulance: 2 } }).decision, 'auto');
});

test('beat: boat to Pallikaranai goes silent -> watchdog reassigns the spare boat (last boat needs approval)', () => {
  const incidents = buildIncidents();
  const resources = seedResources();
  const first = core.matchResources({ incidents, resources });
  const silentBoat = assignmentFor(first, 'I4').resourceId;

  const [finding] = core.checkTimeouts(
    [{ id: 'd-i4', incidentId: 'I4', resourceId: silentBoat, status: 'acknowledged', sentAt: new Date(NOW_MS - 30 * 60000).toISOString(), lastHeartbeatAt: new Date(NOW_MS - 20 * 60000).toISOString() }],
    NOW_MS,
  );
  assert.equal(finding.reason, 'silent');
  const reassignment = core.planReassignment(finding, NOW_MS);
  assert.deepEqual(reassignment.resourcePatch, { id: silentBoat, status: 'offline' });

  const busy = new Set(first.assignments.filter((a) => a.incidentId !== 'I4').map((a) => a.resourceId));
  const pool = resources.map((r) => (r.id === silentBoat ? { ...r, status: 'offline' } : busy.has(r.id) ? { ...r, status: 'assigned' } : r));
  const replan = core.matchResources({ incidents: incidents.filter((i) => i.id === 'I4'), resources: pool });
  const spare = replan.assignments[0]?.resourceId;
  assert.ok(spare && spare !== silentBoat, 'a spare boat takes over');
  assert.equal(typeOf(resources, spare), 'boat');

  const availableBoats = pool.filter((r) => r.type === 'boat' && r.status === 'available').length;
  const decision = core.decide({ action: 'reassign', evidence: incidents.find((i) => i.id === 'I4').evidence, resourceType: 'boat', availableByType: { boat: availableBoats } });
  assert.equal(decision.decision, 'needs_approval');
  assert.deepEqual(decision.reasons, ['commits the last available boat']);
});
