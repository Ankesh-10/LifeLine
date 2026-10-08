'use strict';

// 01-ingest steps: normalise an incoming message (replay webhook or Telegram),
// decide where its extraction comes from (cache, LLM, SIMULATED hint, human),
// validate the LLM answer, and build the reports row. No I/O here.

const crypto = require('node:crypto');
const { isPoint } = require('./geo');
const { toIso } = require('./time');
const { resolveLocation } = require('./geocode');
const llm = require('./llm');

const MAX_PHOTO_BYTES = 1_000_000;

const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());
const opaqueId = (prefix, raw) => `${prefix}-${crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 16)}`;

function validHint(hint) {
  const checked = hint?.extraction ? llm.validateExtraction(hint.extraction) : null;
  return checked?.ok ? checked.value : null;
}

/** Replay webhook body (contract fixed by sim/lib/scenario.js) -> draft. Throws on a broken payload. */
function fromReplay(body) {
  const problems = [];
  if (!body || typeof body !== 'object') throw new Error('replay payload must be a JSON object');
  if (typeof body.externalId !== 'string' || !body.externalId) problems.push('externalId is required');
  if (Number.isNaN(Date.parse(body.sentAt))) problems.push('sentAt must be an ISO-8601 time');
  if (typeof body.text !== 'string' && !body.media) problems.push('text or media is required');
  if (body.pin != null && !isPoint(body.pin)) problems.push('pin must be {lat, lon}');
  if (problems.length) throw new Error(`invalid replay payload: ${problems.join('; ')}`);

  return {
    source: 'replay',
    externalId: body.externalId,
    senderId: body.senderId ? String(body.senderId) : null,
    sentAt: toIso(body.sentAt),
    text: body.text ?? '',
    pin: body.pin ? { lat: body.pin.lat, lon: body.pin.lon } : null,
    media: body.media ? { type: String(body.media.type ?? 'photo'), description: body.media.description ?? null } : null,
    hint: validHint(body.hint),
    simulated: true, // the replay only ever carries SIMULATED scenario messages
  };
}

/** If TELEGRAM_WEBHOOK_SECRET is set, Telegram must echo it in X-Telegram-Bot-Api-Secret-Token. */
function telegramAuthorized(headers = {}, env = {}) {
  const secret = (env.TELEGRAM_WEBHOOK_SECRET ?? '').trim();
  if (!secret) return true;
  const sent = headers['x-telegram-bot-api-secret-token'] ?? '';
  return sent.length === secret.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(secret));
}

/** Telegram Update -> draft, or null for updates that are not a usable message. */
function fromTelegram(update) {
  const msg = update?.message;
  if (!msg || !msg.chat) return null;
  const text = msg.text ?? msg.caption ?? '';
  const pin = msg.location ? { lat: msg.location.latitude, lon: msg.location.longitude } : null;
  // Telegram lists photo sizes smallest first; take the largest that stays small enough for an LLM call.
  const sizes = Array.isArray(msg.photo) ? msg.photo : [];
  const photo = sizes.filter((p) => !p.file_size || p.file_size <= MAX_PHOTO_BYTES).at(-1) ?? sizes[0];
  if (!text && !pin && !photo) return null;

  return {
    source: 'telegram',
    externalId: `${msg.chat.id}:${msg.message_id}`,
    senderId: opaqueId('tg', msg.from?.id ?? msg.chat.id),
    sentAt: toIso(msg.date * 1000),
    text,
    pin: isPoint(pin) ? pin : null,
    media: photo ? { type: 'photo', telegramFileId: photo.file_id, fileUniqueId: photo.file_unique_id ?? photo.file_id } : null,
    hint: null,
    simulated: true, // demo deployment: every report is labelled SIMULATED
  };
}

/** Attach a downloaded photo as a data URL for the vision model. Never stored in the DB. */
function attachPhoto(draft, base64, mimeType = 'image/jpeg') {
  if (!draft.media || !base64) return draft;
  return { ...draft, media: { ...draft.media, imageUrl: `data:${mimeType};base64,${base64}` } };
}

function extractionHash(draft, config) {
  const media = draft.media?.fileUniqueId ?? draft.media?.description ?? null;
  return llm.contentHash({ text: draft.text, media, model: config.extractModel, prompt: llm.loadPrompt('extract').version });
}

/** Cache key for a draft, known before any LLM call (n8n looks it up first). */
function extractionKey(draft, env = {}) {
  return extractionHash(draft, llm.llmConfig(env));
}

/**
 * Decide where the extraction comes from.
 * @param {object} p  { draft, cached: {extracted, model}|null, env }
 * @returns {{ draft, hash, route: 'cached'|'llm'|'hint'|'review', llm?, extraction?, extractionSource?, model?, error? }}
 */
function planExtraction({ draft, cached, env = {} }) {
  const config = llm.llmConfig(env);
  const hash = extractionHash(draft, config);
  const base = { draft, hash, simMode: truthy(env.SIM_MODE) };

  const fromCache = cached?.extracted ? llm.validateExtraction(cached.extracted) : null;
  if (fromCache?.ok) return { ...base, route: 'cached', extraction: fromCache.value, extractionSource: 'cache', model: cached.model ?? null };
  if (config.configured) {
    const request = llm.buildExtractionRequest(config, { text: draft.text, imageUrl: draft.media?.imageUrl, mediaDescription: draft.media?.description });
    return { ...base, route: 'llm', llm: request };
  }
  if (base.simMode && draft.hint) return { ...base, route: 'hint', extraction: draft.hint, extractionSource: 'sim_hint', model: 'sim-hint' };
  return { ...base, route: 'review', error: `no LLM configured (missing ${config.missing.join(', ')}) and no SIMULATED hint` };
}

/**
 * Check the LLM answer. One retry on a bad answer; then the SIMULATED hint
 * (SIM_MODE only) or the coordinator's queue.
 * @param {object} p  { plan (from planExtraction), response (HTTP node output), attempt (1-based) }
 */
function acceptExtraction({ plan, response, attempt = 1 }) {
  const parsed = llm.parseJsonContent(response);
  const checked = parsed.ok ? llm.validateExtraction(parsed.value) : { ok: false, errors: [parsed.error] };
  if (checked.ok) {
    return { ...plan, route: 'done', extraction: checked.value, extractionSource: 'llm', model: `${plan.llm.model} (${plan.llm.promptVersion})`, cacheable: true, error: null };
  }
  const error = `LLM attempt ${attempt}: ${checked.errors.join('; ')}`;
  if (attempt < 2) return { ...plan, route: 'retry', error };
  if (plan.simMode && plan.draft.hint) {
    return { ...plan, route: 'done', extraction: plan.draft.hint, extractionSource: 'sim_hint_fallback', model: 'sim-hint', error };
  }
  return { ...plan, route: 'done', extraction: null, extractionSource: null, model: plan.llm.model, error };
}

function mediaRef(media) {
  if (!media) return null;
  if (media.telegramFileId) return `telegram-file:${media.telegramFileId}`;
  return `simulated-${media.type ?? 'photo'}`;
}

/**
 * Build the reports row. Reports without a location still go to triage: they
 * may inherit their sender's earlier location. Failed extractions go to review.
 */
function finalizeReport({ draft, extraction, extractionSource, model, hash, error, cacheable = false }) {
  const location = resolveLocation({ pin: draft.pin, locationText: extraction?.locationText, text: extraction ? draft.text : null });
  return {
    source: draft.source,
    externalId: draft.externalId,
    senderId: draft.senderId,
    sentAt: draft.sentAt,
    rawText: draft.text,
    mediaUrl: mediaRef(draft.media),
    extracted: extraction ? { ...extraction, source: extractionSource, location } : null,
    extractionModel: model ?? null,
    needType: extraction?.needType ?? null,
    people: extraction?.people ?? null,
    vulnerable: extraction?.vulnerable ?? [],
    locationText: extraction?.locationText ?? null,
    location: location ? { lat: location.lat, lon: location.lon } : null,
    confidence: extraction?.confidence ?? null,
    status: extraction ? 'extracted' : 'needs_review',
    reviewReason: extraction ? null : 'extraction_failed',
    error: error ?? null,
    contentHash: hash ?? null,
    cache: cacheable && extraction ? { hash, model, extracted: extraction } : null,
    simulated: draft.simulated !== false,
  };
}

module.exports = { fromReplay, telegramAuthorized, fromTelegram, attachPhoto, extractionKey, planExtraction, acceptExtraction, finalizeReport, truthy };
