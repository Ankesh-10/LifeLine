'use strict';

// Minimal JSON HTTP helpers on node:http and global fetch. No dependencies.

const http = require('node:http');

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param {number} port
 * @param {Object<string, Function>} routes  'GET /path' -> async (url, body) => data
 */
function startJsonServer(port, routes, { name = 'server' } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const handler = routes[`${req.method} ${url.pathname}`];
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!handler) return send(404, { error: `no route ${req.method} ${url.pathname}` });
    try {
      const body = req.method === 'GET' ? null : await readJson(req);
      send(200, await handler(url, body));
    } catch (err) {
      send(err.status ?? 500, { error: err.message });
    }
  });
  return new Promise((resolve) => server.listen(port, () => {
    console.log(`[${name}] listening on :${server.address().port} (SIMULATED)`);
    resolve(server);
  }));
}

/** POST JSON with a timeout and a couple of retries; throws after the last failure. */
async function postJson(url, body, { retries = 2, timeoutMs = 5000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`POST ${url} -> HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

/** Parses --key value / --flag arguments. */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key.slice(2)] = true;
    else args[key.slice(2)] = argv[++i];
  }
  return args;
}

module.exports = { startJsonServer, postJson, readJson, parseArgs };
