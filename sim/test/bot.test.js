'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { nearestPlace, chooseBehavior, planScript } = require('../lib/bot');
const config = require('../responders.json');

test('nearestPlace maps incident coordinates back to a locality', () => {
  assert.equal(nearestPlace({ lat: 13.021, lon: 80.2235 }), 'Saidapet');
  assert.equal(nearestPlace({ lat: 12.935, lon: 80.214 }), 'Pallikaranai');
});

test('place scripts misbehave once, then the replacement behaves normally', () => {
  const history = new Map();
  assert.equal(chooseBehavior({ place: 'Saidapet', resourceType: 'ambulance' }, config.placeScripts, history), 'blocked');
  assert.equal(chooseBehavior({ place: 'Saidapet', resourceType: 'ambulance' }, config.placeScripts, history), 'normal');
  assert.equal(chooseBehavior({ place: 'Pallikaranai', resourceType: 'boat' }, config.placeScripts, history), 'silent');
  assert.equal(chooseBehavior({ place: 'Pallikaranai', resourceType: 'boat' }, config.placeScripts, history), 'normal');
  assert.equal(chooseBehavior({ place: 'Velachery', resourceType: 'boat' }, config.placeScripts, history), 'normal');
});

test('road blocks only script road vehicles', () => {
  assert.equal(chooseBehavior({ place: 'Saidapet', resourceType: 'boat' }, config.placeScripts, new Map()), 'normal');
});

test('scripts: normal ends with requester confirmation; silent stops after ack; blocked asks for a new route', () => {
  const normal = planScript('normal', { resourceId: 'B1', place: 'Velachery' }, config.timingSec);
  assert.deepEqual(normal.map((s) => s.intentHint), ['ack', 'en_route', 'on_scene', 'resolved', 'confirmed']);
  assert.equal(normal.at(-1).role, 'requester');
  assert.ok(normal.every((s, i) => i === 0 || s.afterSec > normal[i - 1].afterSec), 'messages are in time order');

  assert.deepEqual(planScript('silent', { resourceId: 'B3', place: 'Pallikaranai' }, config.timingSec).map((s) => s.intentHint), ['ack']);
  const blocked = planScript('blocked', { resourceId: 'A1', place: 'Saidapet' }, config.timingSec);
  assert.equal(blocked.at(-1).intentHint, 'blocked');
  assert.match(blocked.at(-1).text, /blocked/);
  assert.throws(() => planScript('panic', { resourceId: 'X', place: 'Y' }, config.timingSec), RangeError);
});
