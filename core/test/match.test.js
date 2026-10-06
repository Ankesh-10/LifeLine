'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchResources } = require('../src/match');

// Positions along a line east of an origin, in km (1 deg lon ~ 108.47 km at 13 N).
const ORIGIN = { lat: 13, lon: 80.2 };
const east = (km) => ({ lat: ORIGIN.lat, lon: ORIGIN.lon + km / 108.47 });

const boat = (id, km, extra = {}) => ({ id, type: 'boat', terrain: 'water', capacity: 10, hasMedic: false, speedKmh: 8, status: 'available', location: east(km), ...extra });
const team = (id, km, extra = {}) => ({ id, type: 'volunteer_team', terrain: 'road', capacity: 6, hasMedic: false, speedKmh: 20, status: 'available', location: east(km), ...extra });
const ambulance = (id, km, extra = {}) => ({ id, type: 'ambulance', terrain: 'road', capacity: 2, hasMedic: true, speedKmh: 30, status: 'available', location: east(km), ...extra });
const incident = (id, km, extra = {}) => ({ id, score: 50, needType: 'rescue', needs: ['rescue'], people: 4, vulnerable: [], flooded: true, location: east(km), ...extra });

const byIncident = (result) => Object.fromEntries(result.assignments.map((a) => [a.incidentId, a]));

test('flooded area only accepts boats, with an explained rejection', () => {
  const r = matchResources({ incidents: [incident('I', 1)], resources: [ambulance('A', 0.5), boat('B', 3)] });
  assert.equal(byIncident(r).I.resourceId, 'B');
  assert.deepEqual(byIncident(r).I.rejected, [{ resourceId: 'A', reason: 'ambulance cannot reach a flooded area' }]);
});

test('capacity is a hard constraint for rescue', () => {
  const r = matchResources({ incidents: [incident('I', 0, { people: 9 })], resources: [boat('small', 1, { capacity: 6 }), boat('big', 4)] });
  assert.equal(byIncident(r).I.resourceId, 'big');
  assert.match(byIncident(r).I.rejected[0].reason, /capacity 6 < 9/);
});

test('scarce boat goes to the higher-priority incident; the other is explained', () => {
  const r = matchResources({
    incidents: [incident('low', 1, { score: 40 }), incident('high', 2, { score: 80 })],
    resources: [boat('B', 0)],
  });
  assert.equal(byIncident(r).high.resourceId, 'B');
  assert.deepEqual(r.unassigned.map((u) => u.incidentId), ['low']);
  assert.match(r.unassigned[0].reasons[0], /higher-priority/);
});

test('not just nearest: swap lowers total priority-weighted response time', () => {
  // Greedy gives H the nearest boat X and leaves L with far-away Y.
  // Swapping costs H 1.8 min and saves L ~38 min.
  const r = matchResources({
    incidents: [incident('H', 2.0, { score: 90 }), incident('L', -2.1, { score: 50 })],
    resources: [boat('X', 0), boat('Y', 4.2)],
  });
  const a = byIncident(r);
  assert.equal(a.H.resourceId, 'Y');
  assert.equal(a.L.resourceId, 'X');
  assert.match(a.H.reasons.join(' | '), /best option X .* went to incident L/);
});

test('swap guard: never delay the higher-priority incident by more than maxDelayMinutes', () => {
  const r = matchResources({
    incidents: [incident('H', 2.0, { score: 90 }), incident('L', -2.1, { score: 50 })],
    resources: [boat('X', 0), boat('Y', 7.0)],
  });
  assert.equal(byIncident(r).H.resourceId, 'X');
  assert.equal(byIncident(r).L.resourceId, 'Y');
});

test('blocked road removes road vehicles on that route, boats are unaffected', () => {
  const dry = incident('I', 2, { flooded: false });
  const blocks = [{ location: east(1), radiusM: 300, appliesTo: 'road', reason: 'tree down' }];
  const r = matchResources({ incidents: [dry], resources: [team('near', 0), team('far', 6)], blocks });
  assert.equal(byIncident(r).I.resourceId, 'far');
  assert.deepEqual(byIncident(r).I.rejected, [{ resourceId: 'near', reason: 'route blocked (tree down)' }]);

  const wet = matchResources({ incidents: [incident('W', 2)], resources: [boat('B', 0)], blocks });
  assert.equal(byIncident(wet).W.resourceId, 'B');
});

test('medic on board is a soft preference', () => {
  const injured = incident('I', 0, { needType: 'medical', needs: ['medical'], vulnerable: ['injured'] });
  const r = matchResources({ incidents: [injured], resources: [boat('plain', 1), boat('medic', 2, { hasMedic: true })] });
  assert.equal(byIncident(r).I.resourceId, 'medic');
  assert.ok(byIncident(r).I.reasons.includes('medic on board'));
});

test('dry-land medical needs an ambulance; unavailable resources are skipped', () => {
  const med = incident('I', 1, { needType: 'medical', needs: ['medical'], flooded: false });
  const r = matchResources({ incidents: [med], resources: [ambulance('busy', 0.2, { status: 'assigned' }), ambulance('free', 3)] });
  assert.equal(byIncident(r).I.resourceId, 'free');
  assert.equal(byIncident(r).I.rejected[0].reason, 'unavailable (assigned)');
});

test('no feasible resource: unassigned with deduplicated reasons', () => {
  const r = matchResources({ incidents: [incident('I', 0)], resources: [team('a', 1), team('b', 2)] });
  assert.deepEqual(r.unassigned[0].reasons, ['volunteer_team cannot reach a flooded area']);
});

test('deterministic for identical input', () => {
  const input = {
    incidents: [incident('a', 1, { score: 60 }), incident('b', 3, { score: 60 }), incident('c', 5, { score: 30 })],
    resources: [boat('x', 0), boat('y', 4), boat('z', 8)],
  };
  assert.deepEqual(matchResources(input), matchResources(input));
});
