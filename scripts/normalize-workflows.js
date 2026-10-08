#!/usr/bin/env node
'use strict';

// Canonical form for exported n8n workflows, so n8n/workflows/*.json diffs stay
// readable and never carry credentials or instance-specific state.
//   node scripts/normalize-workflows.js <export-dir> <out-dir>
// Keeps: id, name, nodes, connections, a few settings. Drops timestamps,
// version ids, tags, static data and pinned data. Every Postgres credential is
// rewritten to the shared "Lifeline DB" reference; other credentials are removed.

const fs = require('node:fs');
const path = require('node:path');

const DB_CREDENTIAL = Object.freeze({ id: 'lifelinePostgres1', name: 'Lifeline DB' });
const KEEP_SETTINGS = ['executionOrder', 'callerPolicy', 'errorWorkflow', 'saveDataErrorExecution', 'saveDataSuccessExecution', 'timezone'];

function normalizeNode(node) {
  const out = { ...node };
  if (node.credentials) {
    const kept = {};
    for (const type of Object.keys(node.credentials)) {
      if (type === 'postgres') kept.postgres = { ...DB_CREDENTIAL };
      else process.emitWarning(`dropping ${type} credential from node "${node.name}"; use $env instead`);
    }
    if (Object.keys(kept).length) out.credentials = kept;
    else delete out.credentials;
  }
  return out;
}

function normalizeWorkflow(wf) {
  const settings = Object.fromEntries(KEEP_SETTINGS.filter((k) => wf.settings?.[k] !== undefined).map((k) => [k, wf.settings[k]]));
  return {
    id: wf.id,
    name: wf.name,
    nodes: (wf.nodes ?? []).map(normalizeNode),
    connections: wf.connections ?? {},
    settings,
    active: false, // scripts/import-workflows.sh activates them
    pinData: {},
  };
}

function main([inDir, outDir] = process.argv.slice(2)) {
  if (!inDir || !outDir) {
    console.error('usage: normalize-workflows.js <export-dir> <out-dir>');
    process.exit(2);
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const file of fs.readdirSync(inDir).filter((f) => f.endsWith('.json'))) {
    const wf = normalizeWorkflow(JSON.parse(fs.readFileSync(path.join(inDir, file), 'utf8')));
    if (!/^\d\d-[a-z0-9-]+$/.test(wf.name)) {
      console.warn(`skipping "${wf.name}": Lifeline workflows are named NN-name`);
      continue;
    }
    fs.writeFileSync(path.join(outDir, `${wf.name}.json`), `${JSON.stringify(wf, null, 2)}\n`);
    console.log(`wrote ${wf.name}.json`);
  }
}

if (require.main === module) main();

module.exports = { normalizeWorkflow, DB_CREDENTIAL };
