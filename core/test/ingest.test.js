'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ingest = require('../src/ingest');

const extraction = { needType: 'rescue', people: 5, vulnerable: ['elderly'], locationText: 'Velacheri', inWater: true, confidence: 0.91 };
const replayBody = (extra = {}) => ({
  source: 'replay',
  externalId: 'run1-m01',
  senderId: 'run1-u-I1-0',
  sentAt: '2026-12-01T03:00:00Z',
  text: 'Water entered our house in Velacheri, 5 of us',
  hint: { extraction },
  simulated: true,
  ...extra,
});
const LLM_ENV = { LLM_PROVIDER: 'groq', LLM_MODEL_EXTRACT: 'm', LLM_API_KEY: 'k', SIM_MODE: 'true' };
const llmReply = (obj) => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });

test('fromReplay keeps the contract fields and a validated hint; rejects broken payloads', () => {
  const draft = ingest.fromReplay(replayBody({ pin: { lat: 12.98, lon: 80.21 }, media: { type: 'photo', description: 'SIMULATED photo' } }));
  assert.equal(draft.sentAt, '2026-12-01T03:00:00.000Z');
  assert.deepEqual(draft.pin, { lat: 12.98, lon: 80.21 });
  assert.equal(draft.media.description, 'SIMULATED photo');
  assert.deepEqual(draft.hint, { ...extraction });
  assert.equal(draft.simulated, true);
  assert.equal(ingest.fromReplay(replayBody({ hint: { extraction: { needType: 'x' } } })).hint, null, 'invalid hint is dropped');
  assert.throws(() => ingest.fromReplay({ text: 'hi' }), /externalId is required; sentAt must be/);
  assert.throws(() => ingest.fromReplay(replayBody({ pin: { lat: 'a' } })), /pin must be/);
});

test('fromTelegram: text, pin and a size-capped photo; opaque sender; ignores non-messages', () => {
  const update = {
    message: {
      message_id: 7,
      date: 1796097600,
      chat: { id: 555 },
      from: { id: 4242 },
      caption: 'stuck on terrace',
      location: { latitude: 12.93, longitude: 80.21 },
      photo: [
        { file_id: 'small', file_unique_id: 'u1', file_size: 2000 },
        { file_id: 'mid', file_unique_id: 'u2', file_size: 90000 },
        { file_id: 'huge', file_unique_id: 'u3', file_size: 5000000 },
      ],
    },
  };
  const d = ingest.fromTelegram(update);
  assert.equal(d.externalId, '555:7');
  assert.equal(d.text, 'stuck on terrace');
  assert.deepEqual(d.pin, { lat: 12.93, lon: 80.21 });
  assert.equal(d.media.telegramFileId, 'mid');
  assert.match(d.senderId, /^tg-[0-9a-f]{16}$/);
  assert.ok(!d.senderId.includes('4242'));
  assert.equal(d.senderId, ingest.fromTelegram(update).senderId, 'stable across messages');
  assert.equal(ingest.fromTelegram({ edited_message: {} }), null);
  assert.equal(ingest.fromTelegram({ message: { message_id: 1, date: 1, chat: { id: 1 }, sticker: {} } }), null);
});

test('planExtraction prefers cache, then the LLM, then the SIMULATED hint, then a human', () => {
  const draft = ingest.fromReplay(replayBody());
  assert.equal(ingest.planExtraction({ draft, cached: { extracted: extraction, model: 'm' }, env: LLM_ENV }).route, 'cached');
  const viaLlm = ingest.planExtraction({ draft, cached: null, env: LLM_ENV });
  assert.equal(viaLlm.route, 'llm');
  assert.match(viaLlm.hash, /^[0-9a-f]{64}$/);
  assert.equal(ingest.planExtraction({ draft, env: { SIM_MODE: 'true' } }).route, 'hint');
  const review = ingest.planExtraction({ draft, env: { SIM_MODE: 'false' } });
  assert.equal(review.route, 'review');
  assert.match(review.error, /no LLM configured/);
});

test('acceptExtraction: valid answer is cacheable; one retry; then hint (SIM_MODE) or the coordinator queue', () => {
  const plan = ingest.planExtraction({ draft: ingest.fromReplay(replayBody()), env: LLM_ENV });
  const ok = ingest.acceptExtraction({ plan, response: llmReply({ ...extraction, people: 4 }), attempt: 1 });
  assert.equal(ok.route, 'done');
  assert.equal(ok.extraction.people, 4);
  assert.equal(ok.cacheable, true);
  assert.equal(ok.model, 'm (extract/1)');

  const bad = llmReply({ needType: 'food' });
  assert.equal(ingest.acceptExtraction({ plan, response: bad, attempt: 1 }).route, 'retry');
  const fallback = ingest.acceptExtraction({ plan, response: bad, attempt: 2 });
  assert.equal(fallback.extractionSource, 'sim_hint_fallback');
  assert.match(fallback.error, /attempt 2/);

  const noHint = { ...plan, simMode: false };
  assert.equal(ingest.acceptExtraction({ plan: noHint, response: { error: { message: 'HTTP 429' } }, attempt: 2 }).extraction, null);
});

test('finalizeReport: typo-tolerant location, pin wins, failures go to review, cache only for LLM answers', () => {
  const draft = ingest.fromReplay(replayBody());
  const row = ingest.finalizeReport({ draft, extraction, extractionSource: 'sim_hint', model: 'sim-hint', hash: 'h' });
  assert.equal(row.status, 'extracted');
  assert.equal(row.extracted.location.place, 'Velachery');
  assert.equal(row.extracted.location.fuzzy, true);
  assert.equal(row.cache, null);

  const pinned = ingest.finalizeReport({ draft: { ...draft, pin: { lat: 1, lon: 2 } }, extraction, extractionSource: 'llm', model: 'm', hash: 'h', cacheable: true });
  assert.deepEqual(pinned.location, { lat: 1, lon: 2 });
  assert.deepEqual(pinned.cache, { hash: 'h', model: 'm', extracted: extraction });

  const failed = ingest.finalizeReport({ draft: { ...draft, pin: { lat: 1, lon: 2 } }, extraction: null, error: 'LLM down' });
  assert.equal(failed.status, 'needs_review');
  assert.equal(failed.reviewReason, 'extraction_failed');
  assert.deepEqual(failed.location, { lat: 1, lon: 2 }, 'a pin is kept even when extraction fails');
});

test('telegramAuthorized: open when no secret is set, exact match otherwise', () => {
  assert.equal(ingest.telegramAuthorized({}, {}), true);
  const env = { TELEGRAM_WEBHOOK_SECRET: 's3cret' };
  assert.equal(ingest.telegramAuthorized({ 'x-telegram-bot-api-secret-token': 's3cret' }, env), true);
  assert.equal(ingest.telegramAuthorized({ 'x-telegram-bot-api-secret-token': 'nope' }, env), false);
  assert.equal(ingest.telegramAuthorized({}, env), false);
});
