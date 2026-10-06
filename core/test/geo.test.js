'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../src/geo');

test('haversine: one degree of latitude is ~111.2 km', () => {
  const d = geo.haversineMeters({ lat: 13, lon: 80 }, { lat: 14, lon: 80 });
  assert.ok(Math.abs(d - 111195) < 100, `got ${d}`);
});

test('haversine: identical points are 0 m apart', () => {
  assert.equal(geo.haversineMeters({ lat: 13, lon: 80 }, { lat: 13, lon: 80 }), 0);
});

test('pointToSegmentMeters: perpendicular distance and clamping to endpoints', () => {
  const a = { lat: 13, lon: 80 };
  const b = { lat: 13, lon: 80.01 }; // ~1.08 km east
  const above = { lat: 13.0009, lon: 80.005 }; // ~100 m north of the middle
  assert.ok(Math.abs(geo.pointToSegmentMeters(above, a, b) - 100) < 2);
  const beyond = { lat: 13, lon: 80.02 }; // past b: distance to b
  assert.ok(Math.abs(geo.pointToSegmentMeters(beyond, a, b) - geo.haversineMeters(beyond, b)) < 2);
});

test('centroid: weighted mean, falls back to equal weights', () => {
  const pts = [{ lat: 0, lon: 0 }, { lat: 10, lon: 10 }];
  assert.deepEqual(geo.centroid(pts, [3, 1]), { lat: 2.5, lon: 2.5 });
  assert.deepEqual(geo.centroid(pts, [0, 0]), { lat: 5, lon: 5 });
  assert.throws(() => geo.centroid([]), /at least one point/);
});

test('travelMinutes: distance, speed and detour', () => {
  assert.equal(geo.travelMinutes(10000, 20), 30);
  assert.equal(geo.travelMinutes(10000, 20, 1.5), 45);
  assert.throws(() => geo.travelMinutes(1000, 0), RangeError);
});

test('isPoint rejects missing or non-finite coordinates', () => {
  assert.equal(geo.isPoint({ lat: 1, lon: 2 }), true);
  assert.equal(geo.isPoint({ lat: 1 }), false);
  assert.equal(geo.isPoint({ lat: NaN, lon: 2 }), false);
  assert.equal(geo.isPoint(null), false);
});
