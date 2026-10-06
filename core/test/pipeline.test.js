'use strict';

// End-to-end through the public API: 30 messages -> incidents -> evidence ->
// scores -> matching -> policy, using the same data as the demo seed.

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src');
const messages = require('./fixtures/messages-30.json');

const NOW = '2026-12-01T04:30:00Z';
const hoursAgo = (h) => new Date(Date.parse(NOW) - h * 3600000).toISOString();
const readings = (levels) => levels.map((levelM, i) => ({ at: hoursAgo(levels.length - 1 - i), levelM }));

// SIMULATED sensors: rising water everywhere except Tambaram.
const gauges = [
  { id: 'G-PALLI', lat: 12.94, lon: 80.215, warningLevelM: 3, dangerLevelM: 4, readings: readings([3.0, 3.2, 3.4]) },
  { id: 'G-MUDI', lat: 12.9156, lon: 80.0702, warningLevelM: 3, dangerLevelM: 4, readings: readings([3.1, 3.3, 3.6]) },
  { id: 'G-ADYAR', lat: 13.015, lon: 80.23, warningLevelM: 3, dangerLevelM: 4, readings: readings([2.8, 3.0, 3.2]) },
  { id: 'G-TAMB', lat: 12.9249, lon: 80.105, warningLevelM: 3, dangerLevelM: 4, readings: readings([2.2, 2.1, 2.0]) },
];
const rainfall = [{ areaId: 'tambaram', lat: 12.9249, lon: 80.1, at: NOW, mmLast3h: 1 }];

// Mirrors db/seed/resources.sql.
const r = (id, type, capacity, hasMedic, speedKmh, lat, lon) => ({
  id, type, terrain: type === 'boat' ? 'water' : 'road', capacity, hasMedic, speedKmh, status: 'available', location: { lat, lon },
});
const resources = [
  r('B1', 'boat', 10, false, 8, 12.979, 80.22),
  r('B2', 'boat', 10, false, 8, 13.023, 80.223),
  r('B3', 'boat', 10, false, 8, 12.925, 80.118),
  r('B4', 'boat', 6, true, 8, 13.018, 80.242),
  r('A1', 'ambulance', 2, true, 30, 13.0067, 80.2206),
  r('A2', 'ambulance', 2, true, 30, 13.0418, 80.2341),
  r('A3', 'ambulance', 2, true, 30, 13.0012, 80.2565),
  r('V1', 'volunteer_team', 6, false, 20, 12.9647, 80.1961),
  r('V2', 'volunteer_team', 6, false, 20, 12.9654, 80.2461),
  r('V3', 'volunteer_team', 6, false, 20, 13.035, 80.2121),
];

function runPipeline() {
  const truthOf = new Map(messages.map((m) => [m.id, m.truthIncident]));
  const { created } = core.assignReports({ reports: messages });
  const incidents = created.map((c) => {
    const truth = truthOf.get(c.reportIds[0]);
    const evidence = core.assessEvidence(c.summary, { gauges, rainfall, now: NOW });
    const { score } = core.scoreIncident(c.summary, evidence, { now: NOW });
    return { id: truth, ...c.summary, evidence, score, flooded: evidence.flooded };
  });
  const ranked = core.rankIncidents(incidents);
  const result = core.matchResources({ incidents: ranked, resources });
  return { incidents: Object.fromEntries(incidents.map((i) => [i.id, i])), ranked, result };
}

test('pipeline: 30 messages become 6 ranked, evidence-checked incidents', () => {
  const { ranked, incidents } = runPipeline();
  assert.equal(ranked.length, 6);
  assert.equal(incidents.I6.evidence.status, 'contradicted', 'Tambaram gauge is low and falling');
  assert.equal(ranked[ranked.length - 1].id, 'I6', 'contradicted claim ranks last');
  for (const id of ['I1', 'I2', 'I4']) assert.equal(incidents[id].evidence.status, 'corroborated', id);
});

test('pipeline: flooded incidents get boats, the contradicted one needs approval', () => {
  const { incidents, result } = runPipeline();
  const byIncident = Object.fromEntries(result.assignments.map((a) => [a.incidentId, a]));
  for (const a of result.assignments) {
    const type = resources.find((x) => x.id === a.resourceId).type;
    if (incidents[a.incidentId].flooded) assert.equal(type, 'boat', `${a.incidentId} got ${type}`);
  }
  assert.equal(byIncident.I2.resourceId, 'B3', 'I2 (Mudichur, 9 people) gets the nearby 10-seat boat');
  assert.ok(byIncident.I3.reasons.includes('medic on board'), 'injured person gets the medic boat');
  assert.deepEqual(result.unassigned.map((u) => u.incidentId), ['I5'], 'four boats, five flooded incidents: lowest priority waits');

  const decision = core.decide({ action: 'dispatch', evidence: incidents.I6.evidence, resourceType: 'volunteer_team', availableByType: { volunteer_team: 3 } });
  assert.equal(decision.decision, 'needs_approval');

  // Every incident is either assigned or carries an explanation.
  assert.equal(result.assignments.length + result.unassigned.length, 6);
  for (const u of result.unassigned) assert.ok(u.reasons.length > 0);
});
