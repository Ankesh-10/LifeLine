'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../../core/src');
const { validate, schedule, buildPayload } = require('../lib/scenario');
const { scenario, streamTriage, truthOf } = require('./helpers');

test('scenario is valid, simulated, 30 messages over 6 true incidents', () => {
  assert.equal(scenario.simulated, true);
  assert.equal(scenario.messages.length, 30);
  assert.equal(scenario.truth.length, 6);
  assert.throws(() => validate({ ...scenario, simulated: false }), /simulated/);
});

test('every message resolves to its true place, except the two deliberate no-location follow-ups', () => {
  const placeOf = new Map(scenario.truth.map((t) => [t.id, t.place]));
  const unresolved = [];
  for (const m of scenario.messages) {
    const loc = core.resolveLocation({ pin: m.pin, locationText: m.extraction.locationText, text: m.text });
    if (!loc) {
      unresolved.push(m.id);
      continue;
    }
    if (loc.source === 'gazetteer') assert.equal(loc.place, placeOf.get(m.truthIncident), `${m.id}: "${m.text}"`);
  }
  assert.deepEqual(unresolved.sort(), ['m09', 'm21']);
});

test('live triage (1-minute ticks): 30 messages become exactly the 6 true incidents', () => {
  const { incidents, pending } = streamTriage();
  assert.deepEqual(pending, [], 'no-location follow-ups must be attached via their sender');
  assert.equal(incidents.length, 6);
  const covered = new Set();
  for (const inc of incidents) {
    const truths = new Set(inc.reports.map((r) => truthOf.get(r.id)));
    assert.equal(truths.size, 1, `${inc.id} mixes ${[...truths]}`);
    covered.add([...truths][0]);
  }
  assert.equal(covered.size, 6);
});

test('replay schedule compresses scenario time; payload never leaks ground truth', () => {
  const plan = schedule(scenario.messages, 20);
  assert.equal(plan[0].delayMs, 0);
  assert.equal(plan.at(-1).delayMs, (52 * 60000) / 20);
  const payload = buildPayload(scenario.messages[0], { runId: 'r1', sentAt: '2026-12-01T03:00:00Z' });
  assert.equal(payload.simulated, true);
  assert.equal(payload.externalId, 'r1-m01');
  assert.equal('truthIncident' in payload, false);
  assert.ok(payload.hint.extraction);
  assert.equal('hint' in buildPayload(scenario.messages[0], { runId: 'r1', sentAt: 'x', withHint: false }), false);
});
