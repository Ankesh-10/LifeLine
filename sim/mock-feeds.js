#!/usr/bin/env node
'use strict';

// SIMULATED river gauge + rainfall API for n8n 02-conditions.
//   GET /health | /gauges | /rainfall | /conditions   (optional ?simMinutes=N to pin the clock)
// Env: FEEDS_PORT (4010), SIM_SPEED (20), SIM_START (ISO; defaults to server start).

const path = require('node:path');
const { startJsonServer } = require('./lib/http');
const { simMinutesAt, snapshot } = require('./lib/feeds');

const conditions = require(path.join(__dirname, 'conditions.json'));
const port = Number(process.env.FEEDS_PORT ?? 4010);
const speed = Number(process.env.SIM_SPEED ?? 20);
const startMs = process.env.SIM_START ? Date.parse(process.env.SIM_START) : Date.now();

function current(url) {
  const nowMs = Date.now();
  const pinned = url.searchParams.get('simMinutes');
  const simMinutes = pinned != null ? Number(pinned) : simMinutesAt(nowMs, { startMs, speed });
  return { simMinutes: Math.round(simMinutes * 10) / 10, ...snapshot(conditions, { simMinutes, nowMs }) };
}

startJsonServer(port, {
  'GET /health': () => ({ ok: true, simulated: true, speed, startedAt: new Date(startMs).toISOString() }),
  'GET /gauges': (url) => current(url).gauges,
  'GET /rainfall': (url) => current(url).rainfall,
  'GET /conditions': (url) => current(url),
}, { name: 'mock-feeds' });
