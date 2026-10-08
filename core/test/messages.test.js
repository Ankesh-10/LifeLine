'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const messages = require('../src/messages');

const dispatch = (extra = {}) => ({
  dispatchId: 'd1',
  incidentId: 'i1',
  resourceId: 'B1',
  resourceType: 'boat',
  contactChatId: 'sim-B1',
  etaMinutes: 12.4,
  approvalReasons: ['commits the last available boat'],
  incident: { needType: 'rescue', people: 5, vulnerable: ['elderly'], location: { lat: 12.982, lon: 80.218 }, score: 71.2 },
  ...extra,
});

test('simulated resources go to the responder bot with the sim contract body', () => {
  const d = messages.deliveryFor(dispatch(), { SIM_BOT_URL: 'http://bot:4020/' });
  assert.equal(d.channel, 'sim');
  assert.equal(d.url, 'http://bot:4020/dispatch');
  assert.deepEqual(Object.keys(d.body), ['dispatchId', 'incidentId', 'resourceId', 'resourceType', 'location']);
  assert.equal(messages.deliveryFor(dispatch()).url, 'http://host.docker.internal:4020/dispatch');
});

test('real chats need a bot token; the token never appears in the delivery spec', () => {
  const tg = messages.deliveryFor(dispatch({ contactChatId: '12345' }), { TELEGRAM_BOT_TOKEN: 'tok' });
  assert.equal(tg.channel, 'telegram');
  assert.equal(tg.body.chat_id, '12345');
  assert.ok(!JSON.stringify(tg).includes('tok'));
  assert.equal(messages.deliveryFor(dispatch({ contactChatId: '12345' }), {}).channel, 'none');
  assert.equal(messages.deliveryFor(dispatch({ contactChatId: null }), { TELEGRAM_BOT_TOKEN: 'tok' }).channel, 'none');
});

test('texts are labelled SIMULATED and name the place', () => {
  const text = messages.dispatchText(dispatch());
  assert.match(text, /^SIMULATED/);
  assert.match(text, /Boat B1: go to Velachery/);
  assert.match(text, /5 people, elderly/);
  const links = messages.approvalLinks('http://n8n/webhook-waiting/42', 'a b');
  assert.equal(links.approve, 'http://n8n/webhook-waiting/42?decision=approve&token=a%20b');
  const approval = messages.approvalText(dispatch(), links);
  assert.match(approval, /last available boat/);
  assert.match(approval, /Dismiss incident: http/);
});

test('coordinator notices need both a bot token and a chat id', () => {
  assert.equal(messages.coordinatorNotice('hi', { TELEGRAM_BOT_TOKEN: 't' }).channel, 'none');
  assert.deepEqual(messages.coordinatorNotice('hi', { TELEGRAM_BOT_TOKEN: 't', COORDINATOR_CHAT_ID: '9' }).body, { chat_id: '9', text: 'hi', disable_web_page_preview: true });
});

test('approval tokens are random 128-bit hex', () => {
  const a = messages.newApprovalToken();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, messages.newApprovalToken());
});
