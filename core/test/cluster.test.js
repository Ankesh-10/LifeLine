'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assignReports, summarize } = require('../src/cluster');
const messages = require('./fixtures/messages-30.json');

const at = (min) => new Date(Date.parse('2026-12-01T03:00:00Z') + min * 60000).toISOString();
const report = (id, lat, lon, min, extra = {}) => ({ id, senderId: `s-${id}`, sentAt: at(min), lat, lon, needType: 'rescue', people: 2, confidence: 0.9, ...extra });

test('fixture: 30 messy messages collapse into exactly the 6 true incidents', () => {
  const { created, updated, needsReview } = assignReports({ reports: messages });
  assert.equal(updated.length, 0);
  assert.deepEqual(needsReview, []);
  assert.equal(created.length, 6);

  const truthOf = new Map(messages.map((m) => [m.id, m.truthIncident]));
  const seen = new Set();
  for (const c of created) {
    const truths = new Set(c.reportIds.map((id) => truthOf.get(id)));
    assert.equal(truths.size, 1, `cluster ${c.key} mixes incidents: ${[...truths]}`);
    seen.add([...truths][0]);
  }
  assert.equal(seen.size, 6);
  assert.equal(created.reduce((s, c) => s + c.reportIds.length, 0), 30);
});

test('fixture: unlocated follow-ups join their sender\'s incident; people is max not sum', () => {
  const { created } = assignReports({ reports: messages });
  const byReport = new Map(created.flatMap((c) => c.reportIds.map((id) => [id, c])));
  const i2 = byReport.get('m09');
  assert.ok(i2.reportIds.includes('m10'), 'm09 (no location) should sit with m10 from the same sender');
  assert.equal(i2.summary.people, 9);
  assert.ok(i2.summary.vulnerable.includes('child'));
  assert.ok(byReport.get('m21').reportIds.includes('m20'));
});

test('same place, 6 hours apart: two separate incidents', () => {
  const { created } = assignReports({ reports: [report('a', 13, 80.2, 0), report('b', 13, 80.2, 360)] });
  assert.equal(created.length, 2);
});

test('chaining guard: a 3 km line of reports does not become one blob', () => {
  const line = Array.from({ length: 11 }, (_, i) => report(`r${i}`, 13 + i * 0.0027, 80.2, i));
  const { created } = assignReports({ reports: line });
  assert.ok(created.length > 1, `expected several clusters, got ${created.length}`);
  for (const c of created) assert.ok(c.summary.radiusM <= 800, `radius ${c.summary.radiusM}`);
  assert.equal(created.reduce((s, c) => s + c.reportIds.length, 0), 11);
});

test('new report near an open incident merges into it instead of creating a new one', () => {
  const incidents = [{ id: 'inc-1', reports: [report('old1', 13, 80.2, 0), report('old2', 13.0005, 80.2, 5)] }];
  const { updated, created } = assignReports({ incidents, reports: [report('new', 13.0009, 80.2005, 25)] });
  assert.equal(created.length, 0);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].incidentId, 'inc-1');
  assert.deepEqual(updated[0].addedReportIds, ['new']);
  assert.equal(updated[0].summary.reportCount, 3);
});

test('low confidence and unlinkable unlocated reports go to human review', () => {
  const { created, needsReview } = assignReports({
    reports: [
      report('weak', 13, 80.2, 0, { confidence: 0.3 }),
      { id: 'lost', senderId: 'nobody', sentAt: at(1), needType: 'rescue', confidence: 0.9 },
    ],
  });
  assert.equal(created.length, 0);
  assert.deepEqual(needsReview.map((r) => r.reportId).sort(), ['lost', 'weak']);
});

test('summarize: needs ordered by severity, vulnerability union, distinct senders', () => {
  const s = summarize([
    report('a', 13, 80.2, 0, { needType: 'supplies', vulnerable: ['child'], senderId: 'x' }),
    report('b', 13.001, 80.2, 10, { needType: 'medical', vulnerable: ['elderly', 'child'], senderId: 'x' }),
    report('c', 13.002, 80.2, 20, { needType: 'rescue', senderId: 'y', inWater: true }),
  ]);
  assert.deepEqual(s.needs, ['rescue', 'medical', 'supplies']);
  assert.equal(s.needType, 'rescue');
  assert.deepEqual(s.vulnerable, ['child', 'elderly']);
  assert.equal(s.uniqueSenders, 2);
  assert.equal(s.waterReported, true);
  assert.equal(s.firstReportedAt, at(0));
  assert.equal(s.lastReportedAt, at(20));
});
