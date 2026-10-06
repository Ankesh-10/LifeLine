'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreIncident, rankIncidents, validateConfig } = require('../src/score');
const weights = require('../config/weights.json');

const NOW = '2026-12-01T05:00:00Z';
const incident = (extra = {}) => ({
  needType: 'rescue',
  needs: ['rescue'],
  people: 5,
  vulnerable: [],
  reportCount: 4,
  firstReportedAt: '2026-12-01T04:00:00Z',
  ...extra,
});
const evidence = (status, extra = {}) => ({
  status,
  stale: false,
  signals: { gauge: { levelM: 3.4, warningLevelM: 3, dangerLevelM: 4, trendMPerHour: 0.2 }, rainfall: null },
  ...extra,
});

test('score is the sum of factor contributions times the evidence multiplier', () => {
  const r = scoreIncident(incident(), evidence('corroborated'), { now: NOW });
  const sum = Object.values(r.factors).reduce((s, f) => s + f.contribution, 0);
  assert.ok(Math.abs(sum - r.base) < 0.05, `${sum} vs ${r.base}`);
  assert.equal(r.score, r.base);
  assert.ok(r.score > 0 && r.score <= 100);
  assert.deepEqual(Object.keys(r.factors).sort(), ['people', 'reports', 'severity', 'vulnerability', 'waiting', 'waterRisk']);
});

test('vulnerable people raise priority', () => {
  const plain = scoreIncident(incident(), evidence('corroborated'), { now: NOW }).score;
  const elderly = scoreIncident(incident({ vulnerable: ['elderly'] }), evidence('corroborated'), { now: NOW }).score;
  assert.ok(elderly > plain);
});

test('contradicted evidence halves the score; stale reduces it further', () => {
  const ok = scoreIncident(incident(), evidence('corroborated'), { now: NOW });
  const bad = scoreIncident(incident(), evidence('contradicted'), { now: NOW });
  assert.ok(Math.abs(bad.score - ok.score * 0.5) < 0.02);
  const stale = scoreIncident(incident(), evidence('corroborated', { stale: true }), { now: NOW });
  assert.ok(stale.score < ok.score);
  assert.deepEqual(stale.multiplier.reasons, ['evidence corroborated x1', 'stale x0.6']);
});

test('waiting time raises priority until the cap', () => {
  const early = scoreIncident(incident(), evidence('corroborated'), { now: '2026-12-01T04:10:00Z' }).score;
  const late = scoreIncident(incident(), evidence('corroborated'), { now: '2026-12-01T06:00:00Z' }).score;
  const later = scoreIncident(incident(), evidence('corroborated'), { now: '2026-12-01T09:00:00Z' }).score;
  assert.ok(late > early);
  assert.equal(later, late);
});

test('no sensor data gives a neutral water factor', () => {
  const r = scoreIncident(incident(), { status: 'unverified', signals: {} }, { now: NOW });
  assert.equal(r.factors.waterRisk.value, 0.5);
});

test('weights must sum to 1', () => {
  assert.throws(() => validateConfig({ ...weights, weights: { ...weights.weights, severity: 0.9 } }), /sum to 1/);
});

test('rankIncidents: score desc, ties to the longest waiting', () => {
  const ranked = rankIncidents([
    { id: 'a', score: 50, firstReportedAt: '2026-12-01T04:00:00Z' },
    { id: 'b', score: 80, firstReportedAt: '2026-12-01T04:30:00Z' },
    { id: 'c', score: 50, firstReportedAt: '2026-12-01T03:00:00Z' },
  ]);
  assert.deepEqual(ranked.map((i) => i.id), ['b', 'c', 'a']);
});
