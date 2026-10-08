'use strict';

// Static checks on the exported workflows: wiring, the contracts fixed by the
// sim, thin Code nodes that only call lifeline-core, SQL functions that exist,
// env vars that are declared, and no credentials in the JSON.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../../core/src');
const { loadWorkflows } = require('../lib/n8n');

const ROOT = path.join(__dirname, '..', '..');
const workflows = loadWorkflows();
const byName = Object.fromEntries(workflows.map((w) => [w.name, w]));
const ids = new Set(workflows.map((w) => w.id));
const nodesOf = (type) => workflows.flatMap((w) => w.nodes.filter((n) => n.type === type).map((n) => ({ wf: w, node: n })));
const TRIGGERS = new Set(['n8n-nodes-base.webhook', 'n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.executeWorkflowTrigger', 'n8n-nodes-base.errorTrigger']);

test('the planned workflows exist, named after their files, with unique ids', () => {
  assert.deepEqual(Object.keys(byName).sort(), ['01-ingest', '02-conditions', '03-triage', '04-approval-gate', '04-dispatch', '05-replies', '06-watchdog', '99-error-handler']);
  for (const w of workflows) assert.equal(w.file, `${w.name}.json`);
  assert.equal(ids.size, workflows.length);
});

test('wiring: unique node names, connections point at real nodes, every node is reachable from a trigger', () => {
  for (const w of workflows) {
    const names = new Set(w.nodes.map((n) => n.name));
    assert.equal(names.size, w.nodes.length, `${w.name}: duplicate node names`);
    assert.equal(new Set(w.nodes.map((n) => n.id)).size, w.nodes.length, `${w.name}: duplicate node ids`);
    for (const [from, { main }] of Object.entries(w.connections)) {
      assert.ok(names.has(from), `${w.name}: connection from unknown node ${from}`);
      for (const t of main.flat()) assert.ok(names.has(t.node), `${w.name}: connection to unknown node ${t.node}`);
    }
    const seen = new Set(w.nodes.filter((n) => TRIGGERS.has(n.type)).map((n) => n.name));
    const queue = [...seen];
    while (queue.length) for (const t of (w.connections[queue.shift()]?.main ?? []).flat()) if (!seen.has(t.node)) { seen.add(t.node); queue.push(t.node); }
    assert.deepEqual(w.nodes.map((n) => n.name).filter((n) => !seen.has(n)), [], `${w.name}: unreachable nodes`);
  }
});

test('webhook paths match the contracts fixed by the sim', () => {
  const paths = nodesOf('n8n-nodes-base.webhook').map(({ node }) => node.parameters.path).sort();
  assert.deepEqual(paths, ['lifeline/replay', 'lifeline/replies', 'lifeline/telegram']);
  assert.match(fs.readFileSync(path.join(ROOT, 'sim/replay.js'), 'utf8'), /webhook\/lifeline\/replay/);
  assert.match(fs.readFileSync(path.join(ROOT, 'sim/responder-bot.js'), 'utf8'), /webhook\/lifeline\/replies/);
});

test('Code nodes are thin: they compile, require only lifeline-core, and call functions that exist', () => {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  for (const { wf, node } of nodesOf('n8n-nodes-base.code')) {
    const code = node.parameters.jsCode;
    const where = `${wf.name}/${node.name}`;
    assert.doesNotThrow(() => new AsyncFunction('$input', '$json', '$env', '$', '$execution', '$runIndex', '$itemIndex', 'require', code), where);
    for (const [, mod] of code.matchAll(/require\('([^']+)'\)/g)) assert.equal(mod, 'lifeline-core', `${where} requires ${mod}`);
    for (const [, mod, fn] of code.matchAll(/core\.(\w+)\.(\w+)\(/g)) assert.equal(typeof core[mod]?.[fn], 'function', `${where}: core.${mod}.${fn} does not exist`);
    assert.ok(code.split('\n').length <= 12, `${where}: logic belongs in lifeline-core, not workflow JSON`);
  }
});

test('Postgres nodes use the Lifeline DB credential and call SQL functions that migration 009 defines', () => {
  const sql = fs.readdirSync(path.join(ROOT, 'db/migrations')).map((f) => fs.readFileSync(path.join(ROOT, 'db/migrations', f), 'utf8')).join('\n');
  const defined = new Set([...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (\w+)/g)].map((m) => m[1]));
  for (const { wf, node } of nodesOf('n8n-nodes-base.postgres')) {
    assert.deepEqual(node.credentials, { postgres: { id: 'lifelinePostgres1', name: 'Lifeline DB' } }, `${wf.name}/${node.name}`);
    for (const [fn] of node.parameters.query.matchAll(/lifeline_\w+(?=\()/g)) assert.ok(defined.has(fn), `${wf.name}/${node.name}: ${fn} is not defined`);
    assert.ok(!/\$\d/.test(node.parameters.query), `${wf.name}/${node.name}: $n placeholders clash with pg-promise`);
  }
});

test('sub-workflow calls and error handling point at real workflows', () => {
  for (const { wf, node } of nodesOf('n8n-nodes-base.executeWorkflow')) {
    assert.ok(ids.has(node.parameters.workflowId.value), `${wf.name}/${node.name}`);
    assert.equal(node.parameters.options.waitForSubWorkflow, false, `${wf.name}/${node.name} should not block`);
  }
  for (const w of workflows) {
    if (w.name === '99-error-handler') assert.equal(w.settings.errorWorkflow, undefined);
    else assert.equal(w.settings.errorWorkflow, byName['99-error-handler'].id, w.name);
  }
  const gateCall = byName['04-dispatch'].nodes.find((n) => n.name === 'Ask coordinator');
  assert.equal(gateCall.parameters.mode, 'each', 'one gate execution (and resume URL) per approval');
});

test('every $env variable a workflow reads is declared in .env.example and docker-compose.yml', () => {
  const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
  const raw = workflows.map((w) => JSON.stringify(w)).join('\n');
  const used = new Set([...raw.matchAll(/\$env\.([A-Z_]+)/g)].map((m) => m[1]));
  // Core reads these through the whole $env object.
  for (const v of ['SIM_MODE', 'LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_MODEL_EXTRACT', 'LLM_MODEL_CLASSIFY', 'POLICY_MODE', 'SIM_BOT_URL', 'COORDINATOR_CHAT_ID', 'TELEGRAM_WEBHOOK_SECRET', 'WATCHDOG_ACK_MINUTES', 'WATCHDOG_HEARTBEAT_MINUTES', 'WATCHDOG_CONFIRM_MINUTES']) used.add(v);
  for (const v of used) {
    assert.match(envExample, new RegExp(`^${v}=`, 'm'), `${v} missing from .env.example`);
    assert.match(compose, new RegExp(`^\\s+${v}:`, 'm'), `${v} missing from docker-compose.yml`);
  }
});

test('no secrets or foreign credentials in the exports', () => {
  for (const w of workflows) {
    const raw = JSON.stringify(w);
    assert.ok(!/"password"|api[_-]?key"\s*:|bot\d{6,}:/i.test(raw), `${w.name} looks like it contains a secret`);
    for (const n of w.nodes) if (n.credentials) assert.deepEqual(Object.keys(n.credentials), ['postgres'], `${w.name}/${n.name}`);
    assert.equal(w.active, false, `${w.name}: exports are inactive; import-workflows.sh activates them`);
  }
});

test('exports are normalised (scripts/normalize-workflows.js leaves them unchanged)', () => {
  const { normalizeWorkflow } = require('../../scripts/normalize-workflows');
  for (const w of workflows) {
    const { file: _f, ...json } = w;
    assert.deepEqual(normalizeWorkflow(json), json, `${w.name}: run scripts/export-workflows.sh (or normalize) before committing`);
  }
});
