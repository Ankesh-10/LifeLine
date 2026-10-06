'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assessEvidence, gaugeState } = require('../src/fusion');

const NOW = '2026-12-01T06:00:00Z';
const hoursAgo = (h) => new Date(Date.parse(NOW) - h * 3600000).toISOString();
const loc = { lat: 13, lon: 80.2 };

const incident = (extra = {}) => ({
  location: loc,
  needs: ['rescue'],
  uniqueSenders: 1,
  lastReportedAt: hoursAgo(0.5),
  waterReported: false,
  ...extra,
});
const gauge = (levels, extra = {}) => ({
  id: 'G1',
  lat: 13.01,
  lon: 80.2,
  warningLevelM: 3,
  dangerLevelM: 4,
  readings: levels.map((levelM, i) => ({ at: hoursAgo(levels.length - 1 - i), levelM })),
  ...extra,
});
const rain = (mmLast3h) => ({ areaId: 'A1', lat: 13, lon: 80.21, at: hoursAgo(0), mmLast3h });

test('gaugeState: least-squares trend in m/h', () => {
  const s = gaugeState(gauge([2.0, 2.3, 2.6]).readings, Date.parse(NOW), 3);
  assert.equal(s.levelM, 2.6);
  assert.equal(s.trendMPerHour, 0.3);
});

test('rising river above warning corroborates a flood rescue', () => {
  const e = assessEvidence(incident(), { gauges: [gauge([2.8, 3.1, 3.4])], now: NOW });
  assert.equal(e.status, 'corroborated');
  assert.equal(e.signals.waterSignal, 'high');
  assert.equal(e.flooded, true);
  assert.equal(e.conflict, false);
});

test('normal, falling river and no rain contradicts a lone flood rescue claim', () => {
  const e = assessEvidence(incident(), { gauges: [gauge([2.0, 1.9, 1.8])], rainfall: [rain(1)], now: NOW });
  assert.equal(e.status, 'contradicted');
  assert.equal(e.flooded, false);
  assert.match(e.reasons.join(' | '), /not supported/);
});

test('enough independent reporters outweigh the sensor, flagged as a conflict', () => {
  const e = assessEvidence(incident({ uniqueSenders: 4 }), { gauges: [gauge([2.0, 1.9, 1.8])], now: NOW });
  assert.equal(e.status, 'corroborated');
  assert.equal(e.conflict, true);
});

test('medical needs are not contradicted by low water', () => {
  const e = assessEvidence(incident({ needs: ['medical'] }), { gauges: [gauge([2.0, 1.9, 1.8])], now: NOW });
  assert.equal(e.status, 'unverified');
});

test('no sensors nearby: unverified, and far-away gauges are ignored', () => {
  const far = gauge([3.5, 3.6], { lat: 13.2 }); // ~22 km away
  const e = assessEvidence(incident(), { gauges: [far], now: NOW });
  assert.equal(e.status, 'unverified');
  assert.equal(e.signals.gauge, null);
  assert.match(e.reasons.join(' | '), /no gauge or rainfall/);
});

test('heavy rain alone is enough to corroborate', () => {
  const e = assessEvidence(incident(), { rainfall: [rain(45)], now: NOW });
  assert.equal(e.status, 'corroborated');
});

test('stale: very old reports, or old reports while water recedes', () => {
  const old = assessEvidence(incident({ lastReportedAt: hoursAgo(7) }), { now: NOW });
  assert.equal(old.stale, true);
  const receding = assessEvidence(incident({ lastReportedAt: hoursAgo(4), uniqueSenders: 5 }), {
    gauges: [gauge([3.4, 3.2, 3.0])],
    now: NOW,
  });
  assert.equal(receding.stale, true);
  const fresh = assessEvidence(incident(), { gauges: [gauge([3.4, 3.2, 3.0])], now: NOW });
  assert.equal(fresh.stale, false);
});
