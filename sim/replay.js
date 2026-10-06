#!/usr/bin/env node
'use strict';

// Replays the SIMULATED scenario into n8n 01-ingest.
//   node replay.js [--speed 20] [--webhook URL] [--limit N] [--no-hint] [--dry-run]
// Env: REPLAY_WEBHOOK_URL (default http://localhost:5678/webhook/lifeline/replay), SIM_SPEED.

const { loadScenario, schedule, buildPayload } = require('./lib/scenario');
const { postJson, parseArgs } = require('./lib/http');

const args = parseArgs(process.argv.slice(2));
const speed = Number(args.speed ?? process.env.SIM_SPEED ?? 20);
const webhook = args.webhook ?? process.env.REPLAY_WEBHOOK_URL ?? 'http://localhost:5678/webhook/lifeline/replay';
const dryRun = Boolean(args['dry-run']);

async function main() {
  const scenario = loadScenario(args.scenario);
  const plan = schedule(scenario.messages, speed).slice(0, args.limit ? Number(args.limit) : undefined);
  const runId = `run${Date.now().toString(36)}`;
  const totalSec = Math.round((plan.at(-1)?.delayMs ?? 0) / 1000);
  console.log(`[replay] ${scenario.name} (SIMULATED): ${plan.length} messages over ~${totalSec}s at ${speed}x -> ${dryRun ? 'dry run' : webhook}`);

  const start = Date.now();
  let sent = 0;
  let failed = 0;
  for (const { msg, delayMs } of plan) {
    const wait = start + delayMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const payload = buildPayload(msg, { runId, sentAt: new Date().toISOString(), withHint: !args['no-hint'] });
    if (dryRun) {
      console.log(JSON.stringify(payload));
      continue;
    }
    try {
      await postJson(webhook, payload);
      sent++;
      console.log(`[replay] +${Math.round((Date.now() - start) / 1000)}s ${msg.id} sent`);
    } catch (err) {
      failed++;
      console.error(`[replay] ${msg.id} FAILED: ${err.message}`);
    }
  }
  console.log(`[replay] done: ${sent} sent, ${failed} failed, run ${runId}`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
