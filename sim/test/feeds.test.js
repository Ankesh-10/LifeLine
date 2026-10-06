'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { gaugeState } = require('../../core/src/fusion');
const conditions = require('../conditions.json');
const { snapshot, simMinutesAt } = require('../lib/feeds');

const NOW = Date.parse('2026-12-01T04:00:00Z');

test('simMinutesAt: real elapsed time times speed', () => {
  assert.equal(simMinutesAt(NOW, { startMs: NOW - 3 * 60000, speed: 20 }), 60);
});

test('snapshot only reveals readings up to the scenario clock; latest is stamped now', () => {
  const early = snapshot(conditions, { simMinutes: -100, nowMs: NOW });
  const late = snapshot(conditions, { simMinutes: 60, nowMs: NOW });
  const palliEarly = early.gauges.find((g) => g.id === 'G-PALLI');
  const palliLate = late.gauges.find((g) => g.id === 'G-PALLI');
  assert.equal(palliEarly.readings.length, 3);
  assert.equal(palliLate.readings.length, 9);
  assert.equal(palliLate.readings.at(-1).at, new Date(NOW).toISOString());
  assert.ok(late.gauges.every((g) => g.simulated === true));
});

test('trends come out in true metres per hour regardless of replay speed', () => {
  const { gauges } = snapshot(conditions, { simMinutes: 30, nowMs: NOW });
  const trend = (id) => gaugeState(gauges.find((g) => g.id === id).readings, NOW, 3).trendMPerHour;
  assert.equal(trend('G-PALLI'), 0.2);
  assert.equal(trend('G-TAMB'), -0.1);
  assert.ok(Math.abs(trend('G-ADYAR')) < 0.05, 'Adyar is flat');
});

test('rainfall returns the latest reading per area', () => {
  const { rainfall } = snapshot(conditions, { simMinutes: 10, nowMs: NOW });
  assert.equal(rainfall.find((r) => r.areaId === 'mudichur').mmLast3h, 52);
  assert.equal(rainfall.find((r) => r.areaId === 'tambaram').mmLast3h, 1);
  assert.equal(snapshot(conditions, { simMinutes: -200, nowMs: NOW }).rainfall.length, 0);
});
