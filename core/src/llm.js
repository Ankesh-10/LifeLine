'use strict';

// Provider-agnostic LLM helpers for the n8n workflows. Every free-tier option
// we consider (Gemini, Groq, OpenRouter, Ollama) exposes an OpenAI-compatible
// chat-completions endpoint, so switching provider is an env change.
// This module builds requests and validates responses; n8n does the HTTP call
// and adds the API key header itself, so the key never lands in item data.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { REPLY_INTENTS } = require('./lifecycle');

const PROVIDER_BASE_URLS = Object.freeze({
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://host.docker.internal:11434/v1',
});

const NEEDS = Object.freeze(['rescue', 'medical', 'supplies']);
const VULNERABLE = Object.freeze(['elderly', 'child', 'disabled', 'pregnant', 'injured']);
const REQUESTER_INTENTS = Object.freeze(['confirmed', 'not_confirmed', 'unclear']);

// Prompts live in n8n/prompts; the n8n image copies them next to src/.
const PROMPT_DIRS = [
  process.env.LIFELINE_PROMPTS_DIR,
  path.join(__dirname, '..', 'prompts'),
  path.join(__dirname, '..', '..', 'n8n', 'prompts'),
].filter(Boolean);

const promptCache = new Map();

/** @returns {{ name, version, text }} */
function loadPrompt(name) {
  if (promptCache.has(name)) return promptCache.get(name);
  for (const dir of PROMPT_DIRS) {
    const file = path.join(dir, `${name}.md`);
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    const version = raw.match(/^Version:\s*(\S+)/m)?.[1] ?? 'unversioned';
    const prompt = { name, version, text: raw.replace(/^Version:.*\n+/m, '').trim() };
    promptCache.set(name, prompt);
    return prompt;
  }
  throw new Error(`prompt ${name}.md not found in ${PROMPT_DIRS.join(', ')}`);
}

/**
 * Read LLM settings from env. Not configured is a normal state: SIM_MODE then
 * falls back to pre-recorded extractions.
 */
function llmConfig(env = {}) {
  const provider = (env.LLM_PROVIDER ?? '').trim().toLowerCase();
  const baseUrl = (env.LLM_BASE_URL ?? '').trim() || PROVIDER_BASE_URLS[provider];
  const config = {
    provider: provider || null,
    baseUrl: baseUrl ? baseUrl.replace(/\/+$/, '') : null,
    extractModel: (env.LLM_MODEL_EXTRACT ?? '').trim() || null,
    classifyModel: (env.LLM_MODEL_CLASSIFY ?? '').trim() || (env.LLM_MODEL_EXTRACT ?? '').trim() || null,
    hasKey: Boolean((env.LLM_API_KEY ?? '').trim()),
  };
  const missing = [];
  if (!config.baseUrl) missing.push(provider ? `LLM_BASE_URL (unknown provider ${provider})` : 'LLM_PROVIDER');
  if (!config.extractModel) missing.push('LLM_MODEL_EXTRACT');
  if (!config.hasKey && provider !== 'ollama') missing.push('LLM_API_KEY');
  return { ...config, configured: missing.length === 0, missing };
}

function chatRequest(config, { model, system, user, imageUrl, maxTokens = 300 }) {
  const content = imageUrl
    ? [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: imageUrl } }]
    : user;
  return {
    url: `${config.baseUrl}/chat/completions`,
    body: {
      model,
      temperature: 0,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content },
      ],
    },
  };
}

/** Request for 01-ingest: message text (+ photo or its SIMULATED description) -> extraction JSON. */
function buildExtractionRequest(config, { text, imageUrl, mediaDescription }) {
  const prompt = loadPrompt('extract');
  const parts = [`Message:\n"""${text ?? ''}"""`];
  if (mediaDescription) parts.push(`Attached photo (description): ${mediaDescription}`);
  return {
    ...chatRequest(config, { model: config.extractModel, system: prompt.text, user: parts.join('\n\n'), imageUrl }),
    model: config.extractModel,
    promptVersion: prompt.version,
  };
}

/** Request for 05-replies: reply text -> {intent}. */
function buildReplyRequest(config, { role, text }) {
  const prompt = loadPrompt('responder-reply');
  const who = role === 'requester' ? 'REQUESTER' : 'RESPONDER';
  return {
    ...chatRequest(config, { model: config.classifyModel, system: prompt.text, user: `Sender: ${who}\nReply:\n"""${text ?? ''}"""`, maxTokens: 50 }),
    model: config.classifyModel,
    promptVersion: prompt.version,
  };
}

/** Pull the JSON object out of a chat-completions response (tolerates code fences and chatter). */
function parseJsonContent(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    return { ok: false, error: response?.error?.message ?? response?.error ?? 'empty LLM response' };
  }
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end < start) return { ok: false, error: 'no JSON object in LLM response' };
  try {
    return { ok: true, value: JSON.parse(content.slice(start, end + 1)) };
  } catch (err) {
    return { ok: false, error: `invalid JSON from LLM: ${err.message}` };
  }
}

/** Strict schema check for an extraction. Returns a normalised copy or the list of problems. */
function validateExtraction(x) {
  const errors = [];
  if (x == null || typeof x !== 'object' || Array.isArray(x)) return { ok: false, errors: ['extraction must be an object'] };

  const needType = typeof x.needType === 'string' ? x.needType.trim().toLowerCase() : x.needType;
  if (!NEEDS.includes(needType)) errors.push(`needType must be one of ${NEEDS.join('|')}`);

  const people = x.people ?? null;
  if (people !== null && !(Number.isInteger(people) && people >= 0 && people <= 1000)) errors.push('people must be an integer 0..1000 or null');

  const vulnerable = x.vulnerable ?? [];
  if (!Array.isArray(vulnerable)) errors.push('vulnerable must be an array');
  const flags = Array.isArray(vulnerable) ? [...new Set(vulnerable.map((v) => String(v).trim().toLowerCase()))] : [];
  const unknown = flags.filter((v) => !VULNERABLE.includes(v));
  if (unknown.length) errors.push(`unknown vulnerable flag(s): ${unknown.join(', ')}`);

  const locationText = x.locationText ?? null;
  if (locationText !== null && typeof locationText !== 'string') errors.push('locationText must be a string or null');

  const inWater = x.inWater ?? null;
  if (inWater !== null && typeof inWater !== 'boolean') errors.push('inWater must be true, false or null');

  if (!(typeof x.confidence === 'number' && x.confidence >= 0 && x.confidence <= 1)) errors.push('confidence must be a number 0..1');

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      needType,
      people,
      vulnerable: flags.sort(),
      locationText: locationText?.trim() || null,
      inWater,
      confidence: Math.round(x.confidence * 100) / 100,
    },
  };
}

function validateIntent(x, role = 'responder') {
  const labels = role === 'requester' ? REQUESTER_INTENTS : REPLY_INTENTS;
  const intent = typeof x?.intent === 'string' ? x.intent.trim().toLowerCase() : null;
  return labels.includes(intent) ? { ok: true, value: intent } : { ok: false, errors: [`intent must be one of ${labels.join('|')}`] };
}

/** Cache key for an extraction: same message, model and prompt -> same answer. */
function contentHash(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

module.exports = {
  PROVIDER_BASE_URLS,
  NEEDS,
  VULNERABLE,
  REQUESTER_INTENTS,
  loadPrompt,
  llmConfig,
  buildExtractionRequest,
  buildReplyRequest,
  parseJsonContent,
  validateExtraction,
  validateIntent,
  contentHash,
};
