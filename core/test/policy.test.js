'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../src/policy');
const config = require('../config/policy.json');

const plenty = { boat: 3, ambulance: 2, volunteer_team: 3 };
const good = { status: 'corroborated', conflict: false, stale: false };

test('well-corroborated dispatch with spare resources runs automatically', () => {
  const r = decide({ action: 'dispatch', evidence: good, extractionConfidence: 0.9, resourceType: 'boat', availableByType: plenty });
  assert.equal(r.decision, 'auto');
});

test('doubtful evidence needs approval, with every reason listed', () => {
  const r = decide({
    action: 'dispatch',
    evidence: { status: 'contradicted', conflict: false, stale: true },
    extractionConfidence: 0.4,
    resourceType: 'boat',
    availableByType: plenty,
  });
  assert.equal(r.decision, 'needs_approval');
  assert.deepEqual(r.reasons, ['evidence is contradicted', 'reports may be outdated', 'low extraction confidence (0.4)']);
  assert.equal(r.timeoutMinutes, 5);
  assert.equal(r.onTimeout, 'escalate');
});

test('sensor/crowd conflict needs approval', () => {
  const r = decide({ action: 'dispatch', evidence: { ...good, conflict: true }, resourceType: 'boat', availableByType: plenty });
  assert.deepEqual(r.reasons, ['sensors and reporters disagree']);
});

test('committing the last available resource of a type needs approval', () => {
  const r = decide({ action: 'dispatch', evidence: good, resourceType: 'boat', availableByType: { boat: 1 } });
  assert.deepEqual(r.reasons, ['commits the last available boat']);
});

test('reassignment after silence or a blocked road is automatic', () => {
  const r = decide({ action: 'reassign', evidence: good, resourceType: 'boat', availableByType: plenty });
  assert.equal(r.decision, 'auto');
  assert.match(r.reasons.join(' '), /time-critical/);
});

test('broadcast always needs approval, even in autonomous mode', () => {
  assert.equal(decide({ action: 'broadcast' }).decision, 'needs_approval');
  assert.equal(decide({ action: 'broadcast' }, { ...config, mode: 'autonomous' }).decision, 'needs_approval');
});

test('modes: manual gates everything, autonomous skips evidence checks', () => {
  const doubtful = { action: 'dispatch', evidence: { status: 'contradicted' }, resourceType: 'boat', availableByType: plenty };
  assert.equal(decide({ action: 'dispatch', evidence: good, availableByType: plenty }, { ...config, mode: 'manual' }).decision, 'needs_approval');
  assert.equal(decide(doubtful, { ...config, mode: 'autonomous' }).decision, 'auto');
});

test('unknown actions are rejected', () => {
  assert.throws(() => decide({ action: 'launch' }), RangeError);
});
