/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The loopback shim between the local app and the local Redis REST bridge (SRH) of the simulated-model browser tests. Two fixes so
// the app's Redis code behaves as against hosted Upstash:
// - @upstash/ratelimit 2.x starts its Lua scripts with "#!lua flags=allow-key-locking", a flag only Upstash's hosted Redis knows;
//   open-source Redis refuses the script. The shim drops that first line (the script body and the results are unchanged).
// - SRH runs MULTI ... EXEC on a shared Redis connection: two transactions in flight at once fail with "ERR MULTI calls can not be
//   nested", and a transaction next to another command can come back as a 500 (measured 2026-11-04: 30 concurrent requests per
//   round, 560 of 600 transactions refused). The turn's in-flight limiter (packages/api/src/services/turn/limiter.ts) is such a
//   transaction and fails closed, so a page's parallel requests made a turn end TURN_PROVIDER_LIMIT_UNAVAILABLE before it called
//   the model (sim journeys 02-failures on #1737 and #1744). Hosted Upstash runs each transaction atomically; the shim gives the
//   same guarantee by forwarding a transaction only when nothing else is in flight, and nothing else while it runs.
import { createServer } from 'node:http';

const strip = value => (typeof value === 'string' && value.startsWith('#!lua') ? value.slice(value.indexOf('\n') + 1) : value);
const rewrite = command => (Array.isArray(command) ? command.map(part => (Array.isArray(part) ? rewrite(part) : strip(part))) : command);

/** One transaction at a time and alone; other requests run together. A waiting transaction holds back requests that come after it. */
export function transactionGate() {
  let running = 0, exclusive = false, queuedTransactions = 0;
  const waiters = [];
  const wake = () => { for (const resolve of waiters.splice(0)) resolve(); };
  const blocked = transaction => exclusive || (transaction ? running > 0 : queuedTransactions > 0);
  return {
    async enter(transaction) {
      if (transaction) queuedTransactions++;
      while (blocked(transaction)) await new Promise(resolve => waiters.push(resolve));
      if (transaction) { queuedTransactions--; exclusive = true; }
      running++;
    },
    leave(transaction) {
      running--;
      if (transaction) exclusive = false;
      wake();
    },
  };
}

/**
 * The shim; `stats` counts what the app's Redis calls met, so a run that failed on a Redis refusal says which kind: an error from the
 * bridge (status 4xx/5xx or 502 when unreachable) or a slow answer (over 400 ms: the app's limiters give up at 500 ms and fail closed).
 * Only the path, status and milliseconds are kept: no command, key or token.
 */
export function createRedisShim(bridgeUrl, { request = fetch } = {}) {
  const gate = transactionGate();
  const stats = { calls: 0, errors: 0, slow: 0, maxMs: 0, anomalies: [] };
  const note = (path, status, started) => {
    const ms = Date.now() - started;
    stats.calls++; stats.maxMs = Math.max(stats.maxMs, ms);
    if (status >= 400) stats.errors++;
    if (ms > 400) stats.slow++;
    if ((status >= 400 || ms > 400) && stats.anomalies.length < 50) stats.anomalies.push(`${new Date().toISOString().slice(11, 23)} ${path} ${status} ${ms}ms`);
  };
  const server = createServer(async (req, res) => {
    const started = Date.now();
    let pathname = '?';
    try { pathname = new URL(req.url, 'http://shim.invalid').pathname; } catch { /* an odd request target: forwarded, counted as '?' */ }
    const path = pathname.split('/').slice(0, 2).join('/') || '/';
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    let body = Buffer.concat(chunks).toString('utf8');
    try { body = JSON.stringify(rewrite(JSON.parse(body))); } catch { /* not JSON: forwarded as is */ }
    const transaction = pathname.startsWith('/multi-exec');
    await gate.enter(transaction);
    try {
      // A bridge call that hangs would now hold every request behind the gate: it ends as a 502 instead (the app fails closed, the
      // test reports it) rather than freezing the stack.
      const response = await request(bridgeUrl + req.url, { method: req.method, signal: AbortSignal.timeout(15_000),
        headers: { authorization: req.headers.authorization ?? '', 'content-type': 'application/json' }, body: req.method === 'GET' ? undefined : body });
      const payload = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
      res.end(payload);
      note(path, response.status, started);
    } catch { res.writeHead(502).end(); note(path, 502, started); }
    finally { gate.leave(transaction); }
  });
  return Object.assign(server, { stats });
}
