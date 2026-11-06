/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Layer 1 of the three-layer validation (Owner 2026-11-03): the core-path journeys in a real browser against a local app, a
// disposable local database and a deterministic simulated model. No paid call, no secret, no network beyond 127.0.0.1.
//   node scripts/e2e-sim/run.mjs [playwright args...]     e.g. --grep "free chat"
// Needs Docker. Leaves nothing behind (containers, network and the run directory are removed; SIM_KEEP=1 keeps the directory).
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { createSim } from './sim.mjs';
import { createMemoryWatch, devServerNodeOptions, withoutMeasurements } from './dev-server-memory.mjs';
import { createStallWatch } from './dev-server-stalls.mjs';
import { startStack } from './stack.mjs';

const root = resolve(import.meta.dirname, '../..');
// Next would read these into the server; a local run must not pick up any real configuration.
const ENV_FILES = ['.env', '.env.local', 'apps/web/.env', 'apps/web/.env.local', 'apps/web/.env.development', 'apps/web/.env.development.local'];
for (const file of ENV_FILES)
  if (existsSync(resolve(root, file))) throw new Error(`refusing to run with ${file} present: the simulated app must not load real settings`);

const freePort = () => new Promise((ok, fail) => {
  const server = createServer();
  server.once('error', fail);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => ok(port)); });
});
const exit = child => new Promise(ok => child.once('exit', code => ok(code ?? 1)));
// Only what the processes need: PATH and HOME, never the caller's own environment (which may hold real settings).
const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NEXT_TELEMETRY_DISABLED: '1',
  ...(process.env.PNPM_HOME ? { PNPM_HOME: process.env.PNPM_HOME } : {}), ...(process.env.CI ? { CI: process.env.CI } : {}) };

const runDir = mkdtempSync(resolve(tmpdir(), 'graylum-sim-'));
let stack, sim, app, code = 1;
const shutdown = async () => {
  if (app && app.exitCode === null) {
    try { process.kill(-app.pid, 'SIGTERM'); } catch { app.kill('SIGTERM'); }
    await Promise.race([exit(app), new Promise(r => setTimeout(r, 10_000))]);
  }
  if (sim) await new Promise(r => { sim.closeAllConnections(); sim.close(r); });
  if (stack) await stack.stop();
  if (!process.env.SIM_KEEP) rmSync(runDir, { recursive: true, force: true });
};
process.once('SIGINT', () => { void shutdown().then(() => process.exit(130)); });
try {
  stack = await startStack({ root });
  sim = createSim();
  await new Promise(r => sim.listen(0, '127.0.0.1', r));
  const simOrigin = `http://127.0.0.1:${sim.address().port}`;
  const seedFile = resolve(runDir, 'seed.json');
  const connection = resolve(runDir, 'connection.json');
  writeFileSync(connection, JSON.stringify({ dbUrl: stack.dbUrl, apiUrl: stack.apiUrl, serviceJwt: stack.jwt('service_role') }), { mode: 0o600 });
  const seeded = spawn('pnpm', ['--filter', '@repo/api', 'exec', 'tsx', 'src/scripts/e2eSim/seed.ts', connection, seedFile],
    { cwd: root, stdio: 'inherit', env: baseEnv });
  if (await exit(seeded) !== 0) throw new Error('seed failed');

  const cronSecret = randomUUID() + randomUUID();
  const appPort = Number(process.env.SIM_APP_PORT ?? await freePort());
  const appUrl = `http://127.0.0.1:${appPort}`;
  // NODE_OPTIONS splits on spaces, and the checkout path may have some: load the preload from the run directory.
  const preload = resolve(runDir, 'preload.cjs');
  copyFileSync(resolve(root, 'scripts/e2e-sim/preload.cjs'), preload);
  if (/\s/.test(preload)) throw new Error('the temporary directory path contains spaces');
  const appEnv = { ...baseEnv, ...stack.redis, NODE_ENV: 'development', NODE_OPTIONS: devServerNodeOptions(preload),
    SIM_ORIGIN: simOrigin, NEXT_PUBLIC_SUPABASE_URL: stack.apiUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: stack.jwt('anon'),
    // Session start and view procedures admit a loopback deployment through this switch (as the workbench runs do) instead of the
    // staging window; the turn path (/api/turn) does not read it.
    V3_RUNTIME_LOCAL_ENDPOINT: stack.apiUrl,
    // The turn route refuses to run against any database but the declared one (TURN_DATABASE_MISMATCH).
    TURN_DATABASE_HOST: new URL(stack.apiUrl).host,
    // Per-run secret so the tests can run the recovery job (/api/cron/runtime-recovery) the way the scheduler does.
    CRON_SECRET: cronSecret,
    SUPABASE_SERVICE_ROLE_KEY: stack.jwt('service_role'), NEXT_PUBLIC_APP_URL: appUrl, NEXT_PUBLIC_SITE_URL: appUrl, NEXT_PUBLIC_AUTH_APP_URL: appUrl };
  // The development server, as the workbench integration runs use: no build step, the same loopback isolation.
  app = spawn('pnpm', ['--filter', 'web', 'exec', 'next', 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(appPort)],
    { cwd: root, env: appEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const appLog = [];
  // The server's lines about the turn endpoints for the whole run (the tail above is only the last minutes): whether a page's turn
  // request reached the server is the first question when a journey opened no turn.
  const turnLog = [];
  // The web proxy refuses a request (503) when its rate-limit backend does not answer within its fixed 1 s deadline: count those and
  // their kind, so a run that failed on a 503 says so even when the log tail no longer shows it.
  const denials = {};
  // How often the dev server restarted itself for memory, and the heap limit it started with (printed for every run, passed or not).
  const memory = createMemoryWatch();
  const stalls = createStallWatch(() => sim.resets);
  for (const out of [app.stdout, app.stderr]) out.on('data', chunk => {
    const raw = stack.redact(chunk);
    memory.feed(raw, out === app.stdout ? 'out' : 'err');
    stalls.feed(raw, out === app.stdout ? 'out' : 'err');
    const text = withoutMeasurements(raw);
    for (const line of text.split('\n')) {
      if (!line.includes('web_rate_limit_backend_unavailable_denying_request')) continue;
      const kind = /"failureKind":"(\w+)"/.exec(line)?.[1] ?? 'unknown';
      denials[kind] = (denials[kind] ?? 0) + 1;
    }
    for (const line of text.split('\n')) if (/\/api\/turn|"turn_|turn_[a-z_]+"/.test(line)) turnLog.push(line.slice(0, 300));
    if (turnLog.length > 600) turnLog.splice(0, turnLog.length - 600);
    appLog.push(text);
    if (appLog.length > 400) appLog.shift();
  });
  const deadline = Date.now() + 240_000;
  for (;;) {
    if (app.exitCode !== null) throw new Error('local app exited:\n' + appLog.join(''));
    try { if ((await fetch(`${appUrl}/login`, { signal: AbortSignal.timeout(60_000) })).ok) break; } catch { /* still compiling */ }
    if (Date.now() > deadline) throw new Error('local app not ready:\n' + appLog.slice(-60).join(''));
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`local app ready on ${appUrl}`);

  const tests = spawn('pnpm', ['--filter', 'web', 'exec', 'playwright', 'test', '-c', 'playwright.sim.config.ts', ...process.argv.slice(2)], {
    cwd: root, stdio: 'inherit',
    env: { ...baseEnv, SIM_BASE_URL: appUrl, SIM_ORIGIN: simOrigin, SIM_SEED_FILE: seedFile, SIM_CRON_SECRET: cronSecret,
      SIM_DB_URL: stack.dbUrl, SIM_API_URL: stack.apiUrl,
      // A slower browser, as on a small CI runner, to look for timing faults locally (e.g. SIM_CPU_THROTTLE=6).
      ...(process.env.SIM_CPU_THROTTLE ? { SIM_CPU_THROTTLE: process.env.SIM_CPU_THROTTLE } : {}) },
  });
  code = await exit(tests);
  console.log(`rate-limit refusals by the web proxy (503): ${JSON.stringify(denials)}`);
  console.log(`dev server memory: ${JSON.stringify(memory.summary())}`);
  // Stalls of the server's own event loop (what the app's 500 ms rate-limit deadline is measured against), per test, and the routes that
  // compiled after the warm-up test: see dev-server-stalls.mjs.
  console.log(`dev server stalls: ${JSON.stringify(stalls.summary())}`);
  // What the app's Redis calls met at the shim (scripts/e2e-sim/redis-shim.mjs): errors and slow answers, with their times.
  console.log(`redis bridge: ${JSON.stringify(stack.redisStats())}`);
  if (code !== 0) console.log('--- local app log (last lines) ---\n' + appLog.slice(-80).join('')
    + '\n--- turn endpoint lines (whole run, last 600) ---\n' + turnLog.join('\n'));
} catch (error) {
  console.error(stack ? stack.redact(error.message) : error.message);
} finally {
  await shutdown();
}
process.exit(code);
