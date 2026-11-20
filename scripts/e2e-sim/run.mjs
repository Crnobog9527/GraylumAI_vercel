/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Layer 1 of the three-layer validation (Owner 2026-11-03): the core-path journeys in a real browser against a local app, a
// disposable local database and a deterministic simulated model. No paid call, no secret, no network beyond 127.0.0.1.
//   node scripts/e2e-sim/run.mjs [playwright args...]     e.g. --grep "free chat"
// Needs Docker. Leaves nothing behind (containers, network and the run directory are removed; SIM_KEEP=1 keeps the directory).
import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { createSim } from './sim.mjs';
import { createReleaseProxy } from './release-proxy.mjs';
import { createStripeReadonly } from './stripe-readonly.mjs';
import { stopProcessGroup } from './process-control.mjs';
import { blocksLaterConfiguration, releaseSuitePlan, suiteState } from './release-results.mjs';
import { createMemoryWatch, devServerNodeOptions, withoutMeasurements } from './dev-server-memory.mjs';
import { createStallWatch } from './dev-server-stalls.mjs';
import { startStack } from './stack.mjs';

const root = resolve(import.meta.dirname, '../..');
const release = process.argv[2] === '--release-preflight';
const releaseDestructive = release && process.argv.includes('--with-admin-destructive');
const silentOnly = release && process.argv.includes('--only-silent');
const operationsOnly = release && process.argv.includes('--production-operations');
const productionAll = release && process.argv.includes('--production-all');
const suiteOption = release ? process.argv.find(arg => arg.startsWith('--production-suite=')) : undefined;
const caseOption = release ? process.argv.find(arg => arg.startsWith('--production-case=')) : undefined;
const diagnosticCase = caseOption?.slice('--production-case='.length);
const casePlans = {
  'purchase-intent': { suite: 'user-extended', grep: 'should route subscription purchase actions', invert: false },
  'admin-remainder': { suite: 'admin-config', grep: 'should persist and restore global settings and membership export settings', invert: true },
  'admin-module': { suite: 'admin-config', grep: 'should create, edit, toggle, and soft-disable a function module', invert: false },
  'admin-entitlements': { suite: 'admin-config', grep: 'isolated membership entitlement save and restore', invert: false },
};
if (caseOption && !Object.hasOwn(casePlans, diagnosticCase)) throw new Error('unknown diagnostic case');
const selectedCase = diagnosticCase ? casePlans[diagnosticCase] : undefined;
const diagnosticSuite = selectedCase?.suite ?? suiteOption?.slice('--production-suite='.length);
const suiteNames = ['home-routing', 'auth', 'admin', 'admin-config', 'admin-ops', 'security', 'user-extended', 'user-supplemental'];
if (suiteOption && !suiteNames.includes(diagnosticSuite)) throw new Error('unknown diagnostic suite');
const productionUi = release && (process.argv.includes('--production-ui') || operationsOnly || productionAll || !!suiteOption || !!caseOption);
const uiOnly = release && (process.argv.includes('--only-ui') || productionUi);
const releaseOptions = ['--with-admin-destructive', '--only-silent', '--only-ui', '--production-ui', '--production-operations', '--production-all'];
if (release && process.argv.slice(3).some(arg => !releaseOptions.includes(arg) && arg !== suiteOption && arg !== caseOption))
  throw new Error('unknown release option');
const selectedModes = ['--only-silent', '--only-ui', '--production-ui', '--production-operations', '--production-all']
  .filter(flag => process.argv.includes(flag)).length + (suiteOption ? 1 : 0) + (caseOption ? 1 : 0);
if (selectedModes > 1 || (selectedModes && releaseDestructive)) throw new Error('incompatible release options');
if (silentOnly || uiOnly) console.log('Targeted diagnostic only; not a complete release preflight.');
// Next would read these into the server; a local run must not pick up any real configuration.
const ENV_FILES = ['.', 'apps/web'].flatMap(dir => ['.env', '.env.local', '.env.development', '.env.development.local',
  '.env.production', '.env.production.local', '.env.test', '.env.test.local'].map(file => `${dir}/${file}`));
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
let stack, sim, stripe, app, proxy, activeTests, interrupted = false, code = 1;
const checkAbort = () => { if (interrupted) throw new Error('simulation interrupted'); };
const shutdown = async () => {
  await stopProcessGroup(activeTests);
  await stopProcessGroup(app);
  if (proxy) { proxy.destroySockets(); await new Promise(r => proxy.close(r)); }
  if (sim) await new Promise(r => { sim.closeAllConnections(); sim.close(r); });
  if (stripe) await new Promise(r => { stripe.closeAllConnections(); stripe.close(r); });
  if (stack) await stack.stop();
  if (!process.env.SIM_KEEP) rmSync(runDir, { recursive: true, force: true });
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = true;
  if (activeTests) void stopProcessGroup(activeTests);
});
try {
  stack = await startStack({ root, isAborted: () => interrupted, releaseStorage: release });
  checkAbort();
  sim = createSim();
  await new Promise(r => sim.listen(0, '127.0.0.1', r));
  checkAbort();
  const simOrigin = `http://127.0.0.1:${sim.address().port}`;
  if (release) {
    stripe = createStripeReadonly();
    await new Promise((ok, fail) => { stripe.once('error', fail); stripe.listen(0, '127.0.0.1', ok); });
  }
  const stripeOrigin = stripe ? `http://127.0.0.1:${stripe.address().port}` : undefined;
  const seedFile = resolve(runDir, 'seed.json');
  const connection = resolve(runDir, 'connection.json');
  writeFileSync(connection, JSON.stringify({ dbUrl: stack.dbUrl, apiUrl: stack.apiUrl, serviceJwt: stack.jwt('service_role') }), { mode: 0o600 });
  const seeded = spawn('pnpm', ['--filter', '@repo/api', 'exec', 'tsx', 'src/scripts/e2eSim/seed.ts', connection, seedFile],
    { cwd: root, stdio: 'inherit', env: baseEnv, detached: true });
  activeTests = seeded;
  const seedCode = await exit(seeded);
  await stopProcessGroup(seeded);
  activeTests = undefined;
  checkAbort();
  if (seedCode !== 0) throw new Error('seed failed');
  if (release) stack.psql("INSERT INTO credit_packages(name,price,credits_amount,bonus_credits,active) VALUES ('Synthetic rehearsal pack',990,990,0,'true')");

  const seedData = JSON.parse(readFileSync(seedFile, 'utf8'));
  const redactOutput = chunk => {
    let output = stack.redact(String(chunk));
    for (const user of Object.values(seedData.users)) {
      output = output.replaceAll(user.email, '[local-test-account]').replaceAll(user.password, '[local-test-password]');
    }
    return output.replace(/sim-(?:alice|bob|carol|warm)-[a-f0-9]{8}/g, '[local-test-account]');
  };
  const forward = child => {
    for (const [input, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      let pending = '';
      input.on('data', chunk => {
        pending += chunk;
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) output.write(redactOutput(line) + '\n');
      });
      input.on('end', () => { if (pending) output.write(redactOutput(pending)); });
    }
  };
  const cronSecret = randomUUID() + randomUUID();
  const appPort = Number(release ? await freePort() : (process.env.SIM_APP_PORT ?? await freePort()));
  const appUrl = `http://127.0.0.1:${appPort}`;
  // NODE_OPTIONS splits on spaces, and the checkout path may have some: load the preload from the run directory.
  const preload = resolve(runDir, 'preload.cjs');
  copyFileSync(resolve(root, 'scripts/e2e-sim/preload.cjs'), preload);
  if (release) appendFileSync(preload, '\n' + readFileSync(resolve(root, 'scripts/e2e-sim/release-network.cjs'), 'utf8'));
  if (release) appendFileSync(preload, '\n' + readFileSync(resolve(root, 'scripts/e2e-sim/stripe-readonly-preload.cjs'), 'utf8'));
  if (release) appendFileSync(preload, '\n' + readFileSync(resolve(root, 'scripts/e2e-sim/redis-diagnostics.cjs'), 'utf8'));
  if (/\s/.test(preload)) throw new Error('the temporary directory path contains spaces');
  const appEnv = { ...baseEnv, ...stack.redis, NODE_ENV: productionUi ? 'production' : 'development', NODE_OPTIONS: devServerNodeOptions(preload),
    SIM_ORIGIN: simOrigin, ...(release ? { SIM_STRIPE_ORIGIN: stripeOrigin, SIM_REDIS_ORIGIN: stack.redis.UPSTASH_REDIS_REST_URL,
      STRIPE_SECRET_KEY: 'sk_test_synthetic_local_only' } : {}),
    SIM_KEEP_COMPILED: '1', NEXT_PUBLIC_SUPABASE_URL: stack.apiUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: stack.jwt('anon'),
    // Session start and view procedures admit a loopback deployment through this switch (as the workbench runs do) instead of the
    // staging window; the turn path (/api/turn) does not read it.
    V3_RUNTIME_LOCAL_ENDPOINT: stack.apiUrl,
    // The turn route refuses to run against any database but the declared one (TURN_DATABASE_MISMATCH).
    TURN_DATABASE_HOST: new URL(stack.apiUrl).host,
    // Per-run secret so the tests can run the recovery job (/api/cron/runtime-recovery) the way the scheduler does.
    CRON_SECRET: cronSecret,
    SUPABASE_SERVICE_ROLE_KEY: stack.jwt('service_role'), NEXT_PUBLIC_APP_URL: appUrl, NEXT_PUBLIC_SITE_URL: appUrl, NEXT_PUBLIC_AUTH_APP_URL: appUrl };
  // The development server, as the workbench integration runs use: no build step, the same loopback isolation.
  checkAbort();
  if (productionUi) {
    const build = spawn('pnpm', ['--filter', 'web', 'build'],
      { cwd: root, env: appEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    forward(build); activeTests = build;
    const buildCode = await exit(build); await stopProcessGroup(build); activeTests = undefined;
    checkAbort();
    if (buildCode !== 0) throw new Error('isolated production build failed');
  }
  const command = productionUi ? ['start'] : ['dev', '--webpack'];
  app = spawn('pnpm', ['--filter', 'web', 'exec', 'next', ...command, '--hostname', '127.0.0.1', '--port', String(appPort)],
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
    const raw = redactOutput(chunk);
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
    checkAbort();
    if (app.exitCode !== null) throw new Error('local app exited:\n' + appLog.join(''));
    try { if ((await fetch(`${appUrl}/login`, { signal: AbortSignal.timeout(60_000) })).ok) break; } catch { /* still compiling */ }
    if (Date.now() > deadline) throw new Error('local app not ready:\n' + appLog.slice(-60).join(''));
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`local app ready on ${appUrl}`);

  let proxyUrl;
  if (release) {
    proxy = createReleaseProxy([appUrl, stack.apiUrl]);
    await new Promise((ok, fail) => { proxy.once('error', fail); proxy.listen(0, '127.0.0.1', ok); });
    checkAbort();
    proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
    rmSync(resolve(runDir, 'sim-report.json'), { force: true });
  }
  const simTests = silentOnly ? ['02-failures.spec.ts', '--grep', 'provider silent until the deadline']
    : release ? ['00-warmup.spec.ts', '01-free-chat.spec.ts', '02-failures.spec.ts'] : process.argv.slice(2);
  if (!uiOnly) {
  checkAbort();
  const tests = spawn('pnpm', ['--filter', 'web', 'exec', 'playwright', 'test', '-c', 'playwright.sim.config.ts', ...simTests], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    env: { ...baseEnv, ...(release ? { NODE_OPTIONS: `--require=${preload}`, SIM_STRIPE_ORIGIN: stripeOrigin,
      RELEASE_PREFLIGHT_PROXY: proxyUrl, RELEASE_PREFLIGHT_RUN_DIR: runDir } : {}),
      SIM_BASE_URL: appUrl, SIM_ORIGIN: simOrigin,
      SIM_SEED_FILE: seedFile, SIM_CRON_SECRET: cronSecret, SIM_DB_URL: stack.dbUrl, SIM_API_URL: stack.apiUrl,
      ...(process.env.SIM_CPU_THROTTLE ? { SIM_CPU_THROTTLE: process.env.SIM_CPU_THROTTLE } : {}) },
  });
  forward(tests);
  activeTests = tests;
  code = await exit(tests);
  await stopProcessGroup(tests);
  activeTests = undefined;
  checkAbort();
  } else code = 0;
  if (release) {
    if (!uiOnly) {
    let simStats;
    try { simStats = JSON.parse(readFileSync(resolve(runDir, 'sim-report.json'), 'utf8')).stats; }
    catch { /* no report */ }
    const simState = suiteState(code, simStats);
    if (simState !== 'passed') code = 1;
    console.log(`release suite ${silentOnly ? 'silent-only' : 'chat'}: ${simState} (skipped: ${simStats?.skipped ?? 'unknown'})`);
    if (silentOnly) { if (code !== 0) throw new Error('silent-only validation failed'); }
    }
    if (!silentOnly) {
    const user = seedData.users.alice, admin = seedData.users.warm;
    if (!/^[0-9a-f-]{36}$/.test(admin.id)) throw new Error('invalid disposable admin');
    stack.psql(`update profiles set role='admin' where id='${admin.id}'::uuid`);
    // This suite changes global settings and can fail before its UI restoration; run it last in the disposable database.
    const suites = releaseSuitePlan({ diagnosticSuite, operationsOnly, uiOnly: uiOnly && !productionAll, destructive: releaseDestructive });
    for (const suite of suites) {
      checkAbort();
      if (suite === 'user-extended') console.log('purchase-intent display uses synthetic checkout readiness; no payment is submitted');
      const report = resolve(runDir, `report-${suite}.json`);
      rmSync(report, { force: true });
      const child = spawn('pnpm', ['--filter', 'web', 'exec', 'playwright', 'test', `tests/e2e/${suite}.spec.ts`, '--project=chromium',
        ...(selectedCase ? [selectedCase.invert ? '--grep-invert' : '--grep', selectedCase.grep] : [])], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
        env: { ...baseEnv, NODE_OPTIONS: `--require=${preload}`, SIM_ORIGIN: simOrigin, SIM_STRIPE_ORIGIN: stripeOrigin,
          RELEASE_PREFLIGHT_ISOLATED: '1', RELEASE_PREFLIGHT_PROXY: proxyUrl, RELEASE_PREFLIGHT_RUN_DIR: runDir, RELEASE_PREFLIGHT_SUITE: suite,
          RELEASE_PREFLIGHT_AUTH_DIR: resolve(runDir, 'auth'),
          PLAYWRIGHT_BASE_URL: appUrl,
          DATABASE_URL: stack.dbUrl, NEXT_PUBLIC_SUPABASE_URL: stack.apiUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: stack.jwt('anon'),
          E2E_TEST_EMAIL: user.email, E2E_TEST_PASSWORD: user.password, E2E_ADMIN_EMAIL: admin.email, E2E_ADMIN_PASSWORD: admin.password,
          ...(diagnosticCase === 'admin-entitlements' ? { RELEASE_PREFLIGHT_ENTITLEMENT_PROBE: '1' } : {}),
          ...(releaseDestructive ? { ENABLE_PARITY_DESTRUCTIVE_E2E: 'true' } : {}) },
      });
      forward(child);
      activeTests = child;
      const result = await exit(child);
      await stopProcessGroup(child);
      activeTests = undefined;
      checkAbort();
      let stats;
      try { stats = JSON.parse(readFileSync(report, 'utf8')).stats; } catch { /* missing report is failure */ }
      const state = suiteState(result, stats);
      const qualification = suite === 'user-extended' ? ' [checkout display uses simulated reads, not payment integration]' : '';
      const label = diagnosticCase ? `diagnostic case ${diagnosticCase}` : `release suite ${suite}`;
      console.log(`${label}: ${state} (skipped: ${stats?.skipped ?? 'unknown'})${qualification}`);
      if (state !== 'passed') code = 1;
      if (blocksLaterConfiguration(suite, state)) {
        console.log('release suite admin-config: not-run (preceding destructive suite may have changed local state)');
        break;
      }
    }
    }
  }
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
  code = 1;
  console.error(stack ? stack.redact(error.message) : error.message);
} finally {
  await shutdown();
}
process.exit(code);
