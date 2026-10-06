'use strict';

// Load, validate and schedule the SIMULATED message scenario.

const fs = require('node:fs');
const path = require('node:path');

const NEEDS = new Set(['rescue', 'medical', 'supplies']);
const VULNERABLE = new Set(['elderly', 'child', 'disabled', 'pregnant', 'injured']);
const DEFAULT_FILE = path.join(__dirname, '..', 'scenarios', 'flood-city.json');

function validate(scenario) {
  const errors = [];
  if (scenario.simulated !== true) errors.push('scenario must be marked simulated: true');
  const ids = new Set();
  const truthIds = new Set(scenario.truth.map((t) => t.id));
  for (const m of scenario.messages) {
    if (ids.has(m.id)) errors.push(`duplicate message id ${m.id}`);
    ids.add(m.id);
    if (!Number.isFinite(m.offsetMin)) errors.push(`${m.id}: offsetMin must be a number`);
    if (!m.text) errors.push(`${m.id}: text is required`);
    const x = m.extraction ?? {};
    if (!NEEDS.has(x.needType)) errors.push(`${m.id}: bad needType ${x.needType}`);
    if (!(Number.isInteger(x.people) && x.people >= 0)) errors.push(`${m.id}: bad people ${x.people}`);
    for (const v of x.vulnerable ?? []) if (!VULNERABLE.has(v)) errors.push(`${m.id}: bad vulnerable flag ${v}`);
    if (!(x.confidence >= 0 && x.confidence <= 1)) errors.push(`${m.id}: confidence must be 0..1`);
    if (!truthIds.has(m.truthIncident)) errors.push(`${m.id}: unknown truthIncident ${m.truthIncident}`);
  }
  if (errors.length) throw new Error(`invalid scenario:\n- ${errors.join('\n- ')}`);
  return scenario;
}

function loadScenario(file = DEFAULT_FILE) {
  return validate(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** Real-time delays for replay: scenario minutes compressed by `speed`. */
function schedule(messages, speed = 20) {
  if (!(speed > 0)) throw new RangeError('speed must be > 0');
  const sorted = [...messages].sort((a, b) => a.offsetMin - b.offsetMin || a.id.localeCompare(b.id));
  const t0 = sorted[0]?.offsetMin ?? 0;
  return sorted.map((msg) => ({ msg, delayMs: Math.round(((msg.offsetMin - t0) * 60000) / speed) }));
}

/**
 * Webhook payload for n8n 01-ingest. Ground truth never leaves the simulator;
 * the extraction is only a hint used when no LLM is configured (SIM_MODE).
 */
function buildPayload(msg, { runId, sentAt, withHint = true }) {
  const payload = {
    source: 'replay',
    externalId: `${runId}-${msg.id}`,
    senderId: `${runId}-${msg.senderId}`,
    sentAt,
    text: msg.text,
    simulated: true,
  };
  if (msg.pin) payload.pin = msg.pin;
  if (msg.media) payload.media = msg.media;
  if (withHint) payload.hint = { extraction: msg.extraction };
  return payload;
}

module.exports = { DEFAULT_FILE, validate, loadScenario, schedule, buildPayload };
