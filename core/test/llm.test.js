'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../src/llm');

const reply = (content) => ({ choices: [{ message: { content } }] });
const good = { needType: 'rescue', people: 5, vulnerable: ['elderly'], locationText: 'Velachery', inWater: true, confidence: 0.91 };

test('llmConfig: not configured is explicit; known providers need only a model and key', () => {
  assert.deepEqual(llm.llmConfig({}).missing, ['LLM_PROVIDER', 'LLM_MODEL_EXTRACT', 'LLM_API_KEY']);
  const groq = llm.llmConfig({ LLM_PROVIDER: 'Groq', LLM_MODEL_EXTRACT: 'some-model', LLM_API_KEY: 'k' });
  assert.equal(groq.configured, true);
  assert.equal(groq.baseUrl, 'https://api.groq.com/openai/v1');
  assert.equal(groq.classifyModel, 'some-model', 'classify falls back to the extract model');
  assert.equal(llm.llmConfig({ LLM_PROVIDER: 'ollama', LLM_MODEL_EXTRACT: 'llava' }).configured, true, 'local Ollama needs no key');
  const custom = llm.llmConfig({ LLM_PROVIDER: 'other', LLM_BASE_URL: 'http://x/v1/', LLM_MODEL_EXTRACT: 'm', LLM_API_KEY: 'k' });
  assert.equal(custom.baseUrl, 'http://x/v1');
  assert.match(llm.llmConfig({ LLM_PROVIDER: 'other', LLM_MODEL_EXTRACT: 'm', LLM_API_KEY: 'k' }).missing[0], /unknown provider/);
});

test('extraction request: OpenAI-compatible, JSON mode, versioned prompt, no API key in the body', () => {
  const config = llm.llmConfig({ LLM_PROVIDER: 'gemini', LLM_MODEL_EXTRACT: 'vision-model', LLM_API_KEY: 'secret-key' });
  const req = llm.buildExtractionRequest(config, { text: 'help in Velachery', mediaDescription: 'SIMULATED photo: water' });
  assert.equal(req.url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(req.body.response_format.type, 'json_object');
  assert.equal(req.promptVersion, 'extract/1');
  assert.match(req.body.messages[0].content, /strict JSON/);
  assert.match(req.body.messages[1].content, /help in Velachery[\s\S]*SIMULATED photo/);
  assert.ok(!JSON.stringify(req).includes('secret-key'));

  const withPhoto = llm.buildExtractionRequest(config, { text: 't', imageUrl: 'data:image/jpeg;base64,AAAA' });
  assert.equal(withPhoto.body.messages[1].content[1].image_url.url, 'data:image/jpeg;base64,AAAA');
});

test('parseJsonContent tolerates fences and chatter, reports empty and broken answers', () => {
  assert.deepEqual(llm.parseJsonContent(reply('```json\n{"a":1}\n```')).value, { a: 1 });
  assert.deepEqual(llm.parseJsonContent(reply('Sure! {"a":2} hope that helps')).value, { a: 2 });
  assert.equal(llm.parseJsonContent(reply('')).ok, false);
  assert.match(llm.parseJsonContent(reply('{"a":')).error, /no JSON object|invalid JSON/);
  assert.equal(llm.parseJsonContent({ error: { message: 'rate limited' } }).error, 'rate limited');
});

test('validateExtraction normalises good output and lists every problem in bad output', () => {
  const ok = llm.validateExtraction({ ...good, needType: ' Rescue ', vulnerable: ['Elderly', 'elderly', 'child'], confidence: 0.912 });
  assert.deepEqual(ok.value, { ...good, vulnerable: ['child', 'elderly'], confidence: 0.91 });
  assert.deepEqual(llm.validateExtraction({ ...good, people: undefined, locationText: '  ', inWater: undefined }).value, { ...good, people: null, locationText: null, inWater: null });

  const bad = llm.validateExtraction({ needType: 'food', people: -1, vulnerable: ['old'], locationText: 3, inWater: 'yes', confidence: 2 });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 6);
  assert.equal(llm.validateExtraction(null).ok, false);
});

test('validateIntent uses the label set for the sender role', () => {
  assert.equal(llm.validateIntent({ intent: 'Blocked' }).value, 'blocked');
  assert.equal(llm.validateIntent({ intent: 'confirmed' }).ok, false, 'not a responder label');
  assert.equal(llm.validateIntent({ intent: 'confirmed' }, 'requester').value, 'confirmed');
});

test('contentHash is stable and sensitive to every part', () => {
  const a = llm.contentHash({ text: 'x', model: 'm', prompt: 'extract/1' });
  assert.equal(a, llm.contentHash({ text: 'x', model: 'm', prompt: 'extract/1' }));
  assert.notEqual(a, llm.contentHash({ text: 'x', model: 'm', prompt: 'extract/2' }));
  assert.match(a, /^[0-9a-f]{64}$/);
});
