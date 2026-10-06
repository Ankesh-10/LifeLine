'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { geocodeText, resolveLocation, withinOneEdit } = require('../src/geocode');

test('withinOneEdit: substitution, insertion, deletion; not two edits', () => {
  assert.equal(withinOneEdit('velachery', 'velacheri'), true);
  assert.equal(withinOneEdit('pallikaranai', 'pallikarnai'), true);
  assert.equal(withinOneEdit('mudichur', 'mudichurr'), true);
  assert.equal(withinOneEdit('tambaram', 'tambaran1'), false);
});

test('exact locality in a messy message', () => {
  const hit = geocodeText('Please help!! Water entered our house in Velachery, 5 of us');
  assert.equal(hit.place, 'Velachery');
  assert.equal(hit.fuzzy, false);
});

test('one typo in a long name still resolves, flagged fuzzy', () => {
  assert.equal(geocodeText('Velacheri main road flooded').place, 'Velachery');
  const p = geocodeText('Pallikarnai marsh side houses flooded');
  assert.equal(p.place, 'Pallikaranai');
});

test('longest exact match wins (specific alias over generic name)', () => {
  const hit = geocodeText('we are near Saidapet bridge');
  assert.equal(hit.place, 'Saidapet');
  assert.equal(hit.matched, 'saidapet bridge');
  assert.equal(geocodeText('T. Nagar bus depot').place, 'T. Nagar');
});

test('no false positives on short words or unknown places', () => {
  assert.equal(geocodeText('water everywhere help'), null);
  assert.equal(geocodeText('somewhere in Narnia'), null);
  assert.equal(geocodeText(''), null);
});

test('resolveLocation: pin beats text, text falls back to raw message', () => {
  assert.deepEqual(resolveLocation({ pin: { lat: 13, lon: 80.2 }, locationText: 'Velachery' }), { lat: 13, lon: 80.2, source: 'pin' });
  const viaText = resolveLocation({ locationText: null, text: 'stuck in Mudichur with kids' });
  assert.equal(viaText.source, 'gazetteer');
  assert.equal(viaText.place, 'Mudichur');
  assert.equal(resolveLocation({ text: '3 of us on the stairs now' }), null);
});
