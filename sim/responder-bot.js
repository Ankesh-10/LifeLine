#!/usr/bin/env node
'use strict';

// SIMULATED responders. n8n 04-dispatch POSTs simulated dispatches here
// (resources whose contact_chat_id starts with "sim-"); the bot answers on the
// replies webhook following sim/responders.json.
//   POST /dispatch { dispatchId, incidentId, resourceId, resourceType, location: {lat, lon} }
//   GET  /health
// Env: BOT_PORT (4020), REPLIES_WEBHOOK_URL (default http://localhost:5678/webhook/lifeline/replies), BOT_SPEED (1).

const path = require('node:path');
const { startJsonServer, postJson } = require('./lib/http');
const { nearestPlace, chooseBehavior, planScript } = require('./lib/bot');

const config = require(path.join(__dirname, 'responders.json'));
const port = Number(process.env.BOT_PORT ?? 4020);
const repliesUrl = process.env.REPLIES_WEBHOOK_URL ?? 'http://localhost:5678/webhook/lifeline/replies';
const speed = Number(process.env.BOT_SPEED ?? 1);
const history = new Map();

function handleDispatch(_url, body) {
  const { dispatchId, incidentId, resourceId, resourceType, location } = body ?? {};
  if (!dispatchId || !resourceId || !location) {
    throw Object.assign(new Error('dispatchId, resourceId and location are required'), { status: 400 });
  }
  const place = nearestPlace(location);
  const behavior = chooseBehavior({ place, resourceType }, config.placeScripts, history);
  const script = planScript(behavior, { resourceId, place }, config.timingSec);
  console.log(`[bot] ${resourceId} -> ${place} (${behavior}): ${script.length} scripted message(s)`);

  for (const step of script) {
    setTimeout(async () => {
      const reply = { ...step, resourceId, dispatchId, incidentId, sentAt: new Date().toISOString(), simulated: true };
      delete reply.afterSec;
      try {
        await postJson(repliesUrl, reply);
        console.log(`[bot] ${resourceId} ${step.role}: ${step.intentHint}`);
      } catch (err) {
        console.error(`[bot] reply from ${resourceId} failed: ${err.message}`);
      }
    }, (step.afterSec * 1000) / speed);
  }
  return { accepted: true, place, behavior, steps: script.length };
}

startJsonServer(port, {
  'GET /health': () => ({ ok: true, simulated: true, speed, dispatchesByPlace: Object.fromEntries(history) }),
  'POST /dispatch': handleDispatch,
}, { name: 'responder-bot' });
