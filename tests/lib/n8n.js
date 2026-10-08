'use strict';

// A small n8n emulator: runs the exported workflow JSON in n8n/workflows/ against
// PGlite, so wiring mistakes (wrong node names, expressions, SQL, branch outputs)
// fail a test instead of the live demo. It covers only the node types and
// semantics these workflows use; it is not n8n. What it emulates:
//   - "={{ }}" expressions with $json, $env, $('Node').item/.first()/.all(), $execution
//   - Code nodes (all items / each item), require('lifeline-core') only, this.helpers.getBinaryDataBuffer
//   - Postgres executeQuery per item (or once), rejecting $n text that pg-promise would substitute
//   - IF v2 (string equals, boolean true with strict types), HTTP Request via a stub,
//     Execute Workflow (once/each), Wait (resolved by a callback), Error Trigger -> 99
//   - paired items: each item remembers which item it came from at every earlier node

const fs = require('node:fs');
const path = require('node:path');
const core = require('../../core/src');

const WORKFLOW_DIR = path.join(__dirname, '..', '..', 'n8n', 'workflows');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function loadWorkflows(dir = WORKFLOW_DIR) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

function createN8n({ db, env = {}, http = async () => ({}), clock = { now: () => Date.now() }, onWait = () => null, workflows = loadWorkflows() }) {
  const byId = new Map(workflows.map((w) => [w.id, w]));
  const byName = new Map(workflows.map((w) => [w.name, w]));
  const errors = [];
  const stats = { executions: 0, nodeRuns: {} };
  let executionSeq = 0;

  class FakeDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(clock.now()); }
    static now() { return clock.now(); }
  }

  async function execute(wf, triggerName, triggerItems) {
    const execution = { id: String(++executionSeq), resumeUrl: `http://n8n.test/webhook-waiting/${executionSeq}` };
    const runData = new Map(); // node -> output items of its latest run (all outputs flattened)
    const runCount = new Map();
    const nodes = new Map(wf.nodes.map((n) => [n.name, n]));
    stats.executions++;

    const ctxFor = (item, items, index) => {
      const ref = (name) => ({
        get item() {
          const hit = item?.lineage?.get(name);
          if (!hit) throw new Error(`$('${name}').item: no paired item from "${name}"`);
          return hit;
        },
        first: () => (runData.get(name) ?? [])[0],
        all: () => runData.get(name) ?? [],
        itemMatching: (i) => {
          const hit = items[i]?.lineage?.get(name);
          if (!hit) throw new Error(`$('${name}').itemMatching(${i}): no paired item`);
          return hit;
        },
      });
      return {
        $json: item?.json,
        $env: env,
        $: ref,
        $execution: execution,
        $input: { all: () => items, first: () => items[0], item },
        $itemIndex: index,
      };
    };

    const evaluate = (value, ctx) => {
      if (typeof value !== 'string' || !value.startsWith('=')) return value;
      const template = value.slice(1);
      const run = (expr) => new Function(...Object.keys(ctx), `return (${expr});`)(...Object.values(ctx));
      const whole = template.match(/^\{\{([\s\S]*)\}\}$/);
      if (whole && !whole[1].includes('}}')) return run(whole[1]);
      return template.replace(/\{\{([\s\S]*?)\}\}/g, (_m, expr) => {
        const v = run(expr);
        return typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
      });
    };

    const derive = (nodeName, input, out) => {
      const lineage = new Map(input?.lineage ?? []);
      const item = { json: clone(out.json ?? {}), binary: clone(out.binary), lineage };
      lineage.set(nodeName, item);
      return item;
    };

    async function runNode(node, items) {
      const p = node.parameters ?? {};
      const runIndex = runCount.get(node.name) ?? 0;
      runCount.set(node.name, runIndex + 1);
      stats.nodeRuns[`${wf.name}/${node.name}`] = (stats.nodeRuns[`${wf.name}/${node.name}`] ?? 0) + 1;

      switch (node.type) {
        case 'n8n-nodes-base.webhook':
        case 'n8n-nodes-base.scheduleTrigger':
        case 'n8n-nodes-base.executeWorkflowTrigger':
        case 'n8n-nodes-base.errorTrigger':
          return [items.map((it) => derive(node.name, null, it))];

        case 'n8n-nodes-base.code': {
          const fn = new AsyncFunction('$input', '$json', '$env', '$', '$execution', '$runIndex', '$itemIndex', 'require', 'Date', p.jsCode);
          const requireCore = (name) => {
            if (name !== 'lifeline-core') throw new Error(`Code node "${node.name}" may only require lifeline-core, not ${name}`);
            return core;
          };
          const helpers = { getBinaryDataBuffer: async (i, prop) => Buffer.from(items[i].binary[prop].data, 'base64') };
          const call = (ctx) => fn.call({ helpers }, ctx.$input, ctx.$json, env, ctx.$, execution, runIndex, ctx.$itemIndex, requireCore, FakeDate);
          if (p.mode === 'runOnceForEachItem') {
            const out = [];
            for (let i = 0; i < items.length; i++) {
              const r = await call(ctxFor(items[i], items, i));
              if (r == null) continue;
              for (const o of Array.isArray(r) ? r : [r]) out.push(derive(node.name, items[i], o));
            }
            return [out];
          }
          const r = (await call(ctxFor(items[0], items, 0))) ?? [];
          if (!Array.isArray(r)) throw new Error(`Code node "${node.name}" (all items) must return an array`);
          return [r.map((o, k) => derive(node.name, items[r.length === items.length ? k : 0], o))];
        }

        case 'n8n-nodes-base.postgres': {
          const out = [];
          const targets = node.executeOnce ? items.slice(0, 1) : items;
          for (let i = 0; i < targets.length; i++) {
            let sql = String(evaluate(p.query, ctxFor(targets[i], items, i)));
            if (/\$\d/.test(sql)) throw new Error(`Postgres node "${node.name}": query contains $n, which pg-promise would substitute`);
            // The emulator's clock: input functions get "now" from it instead of the real time.
            sql = sql.replace(/(lifeline_\w+_input)\(\)/g, `$1('${new Date(clock.now()).toISOString()}'::timestamptz)`);
            const { rows } = await db.query(sql);
            for (const row of rows) out.push(derive(node.name, targets[i], { json: row }));
          }
          return [out];
        }

        case 'n8n-nodes-base.if': {
          const [t, f] = [[], []];
          items.forEach((it, i) => {
            const ctx = ctxFor(it, items, i);
            const results = p.conditions.conditions.map((c) => {
              const left = evaluate(c.leftValue, ctx);
              const { type, operation } = c.operator;
              if (type === 'boolean' && operation === 'true') {
                if (typeof left !== 'boolean') throw new Error(`IF "${node.name}": expected a boolean, got ${typeof left} (strict type validation)`);
                return left;
              }
              if (type === 'string' && operation === 'equals') return String(left) === String(evaluate(c.rightValue, ctx));
              throw new Error(`IF "${node.name}": emulator does not support ${type}.${operation}`);
            });
            const pass = p.conditions.combinator === 'or' ? results.some(Boolean) : results.every(Boolean);
            (pass ? t : f).push(derive(node.name, it, { json: it.json, binary: it.binary }));
          });
          return [t, f];
        }

        case 'n8n-nodes-base.httpRequest': {
          const out = [];
          for (let i = 0; i < items.length; i++) {
            const ctx = ctxFor(items[i], items, i);
            const request = {
              method: p.method ?? 'GET',
              url: evaluate(p.url, ctx),
              headers: Object.fromEntries((p.headerParameters?.parameters ?? []).map((hd) => [hd.name, evaluate(hd.value, ctx)])),
              body: p.sendBody ? JSON.parse(evaluate(p.jsonBody, ctx)) : undefined,
              node: `${wf.name}/${node.name}`,
            };
            try {
              const res = await http(request);
              out.push(derive(node.name, items[i], res?.binary ? res : { json: res ?? {} }));
            } catch (err) {
              if (node.onError !== 'continueRegularOutput') throw err;
              out.push(derive(node.name, items[i], { json: { error: { message: err.message } } }));
            }
          }
          return [out];
        }

        case 'n8n-nodes-base.executeWorkflow': {
          const target = byId.get(p.workflowId?.value ?? p.workflowId);
          if (!target) throw new Error(`Execute Workflow "${node.name}": unknown workflow ${JSON.stringify(p.workflowId)}`);
          const trigger = target.nodes.find((n) => n.type === 'n8n-nodes-base.executeWorkflowTrigger');
          const payload = items.map((it) => ({ json: clone(it.json) }));
          if (p.mode === 'each') for (const one of payload) await run(target, trigger.name, [one]);
          else await run(target, trigger.name, payload);
          return [items.map((it) => derive(node.name, it, { json: it.json }))];
        }

        case 'n8n-nodes-base.wait': {
          const out = [];
          for (let i = 0; i < items.length; i++) {
            const ctx = ctxFor(items[i], items, i);
            const query = await onWait({ workflow: wf.name, execution, item: items[i], ctx, timeoutMinutes: evaluate(p.resumeAmount, ctx) });
            out.push(derive(node.name, items[i], query ? { json: { headers: {}, params: {}, query, body: {} } } : { json: items[i].json }));
          }
          return [out];
        }

        default:
          throw new Error(`emulator does not support node type ${node.type}`);
      }
    }

    // Depth-first, output 0 first (n8n "v1" execution order).
    const stack = [{ name: triggerName, items: triggerItems.map((it) => ({ json: clone(it.json ?? {}), binary: clone(it.binary), lineage: new Map() })) }];
    while (stack.length) {
      const { name, items } = stack.pop();
      const node = nodes.get(name);
      if (!node) throw new Error(`${wf.name}: no node named "${name}"`);
      const outputs = await runNode(node, items);
      runData.set(name, outputs.flat());
      const next = [];
      (wf.connections[name]?.main ?? []).forEach((targets, output) => {
        const outItems = outputs[output] ?? [];
        if (!outItems.length) return;
        for (const t of targets ?? []) next.push({ name: t.node, items: outItems });
      });
      for (let k = next.length - 1; k >= 0; k--) stack.push(next[k]);
    }
    return runData;
  }

  async function run(wf, triggerName, items) {
    try {
      return await execute(wf, triggerName, items);
    } catch (err) {
      errors.push({ workflow: wf.name, message: err.message, stack: err.stack });
      const handler = byId.get(wf.settings?.errorWorkflow);
      if (handler && handler.id !== wf.id) {
        const trigger = handler.nodes.find((n) => n.type === 'n8n-nodes-base.errorTrigger');
        await execute(handler, trigger.name, [{ json: { execution: { id: 'emulated', error: { message: err.message, stack: err.stack }, lastNodeExecuted: null, mode: 'trigger' }, workflow: { id: wf.id, name: wf.name } } }]);
      }
      return null;
    }
  }

  /** Fire a trigger node of a workflow (by workflow name). */
  async function trigger(workflowName, triggerName, items = [{ json: {} }]) {
    const wf = byName.get(workflowName);
    if (!wf) throw new Error(`unknown workflow ${workflowName}`);
    return run(wf, triggerName, items);
  }

  const webhook = (workflowName, triggerName, body, headers = {}) => trigger(workflowName, triggerName, [{ json: { headers, params: {}, query: {}, body } }]);

  return { trigger, webhook, errors, stats, workflows };
}

/** Discrete-event clock: run callbacks in time order, moving "now" as we go. */
function createClock(startMs) {
  let now = startMs;
  const queue = [];
  let seq = 0;
  return {
    now: () => now,
    at(ms, fn) { queue.push({ ms, seq: seq++, fn }); },
    every(startAt, periodMs, untilMs, fn) { for (let t = startAt; t <= untilMs; t += periodMs) queue.push({ ms: t, seq: seq++, fn }); },
    async runUntil(untilMs) {
      for (;;) {
        queue.sort((a, b) => a.ms - b.ms || a.seq - b.seq);
        if (!queue.length || queue[0].ms > untilMs) break;
        const ev = queue.shift();
        now = ev.ms;
        await ev.fn();
      }
      now = untilMs;
    },
  };
}

module.exports = { WORKFLOW_DIR, loadWorkflows, createN8n, createClock };
