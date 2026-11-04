/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Layer 1 of the three-layer validation (Owner 2026-11-03): a disposable local backend for the simulated-model browser tests.
// Digest-pinned PostgreSQL (schema built from repository files only), PostgREST, GoTrue and a local Redis REST bridge, behind one
// loopback gateway that answers /rest/v1 and /auth/v1 like a Supabase project. Per-run random JWT secret; nothing is published
// beyond 127.0.0.1 and nothing outside this machine is contacted. Same building blocks as packages/db/tests/v3/run-workbench.mjs.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

import { buildFromFiles, installPgCronStub } from '../../packages/db/tests/baseline/build-from-files.mjs';
import { GOTRUE_IMAGE, POSTGREST_IMAGE, POSTGRES_IMAGE } from '../../packages/db/tests/v3/images.mjs';
import { createLocalRateLimit } from '../../packages/db/tests/v3/local-rate-limit.mjs';
import { signPreviewJwt } from '../../packages/db/tests/v3/preview-lifecycle.mjs';

import { createRedisShim } from './redis-shim.mjs';

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function startStack({ root, log = console.log }) {
  const tag = `graylum-sim-${randomUUID().slice(0, 8)}`;
  const names = { db: `${tag}-db`, rest: `${tag}-rest`, auth: `${tag}-auth` };
  const secret = randomUUID() + randomUUID();
  const rateLimit = createLocalRateLimit({ tag });
  let gateway, redisShim;
  const psql = (input, args = []) => execFileSync('docker', ['exec', '-i', names.db, 'psql', '-X', '-q', '-U', 'postgres', '-d', 'sim',
    '-v', 'ON_ERROR_STOP=1', ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const stop = async () => {
    for (const server of [gateway, redisShim]) if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const name of Object.values(names)) { try { docker('rm', '-f', '-v', name); } catch { /* never started */ } }
    try { docker('network', 'rm', tag); } catch { /* never created */ }
    try { rateLimit.cleanup(); } catch (error) { log(String(error.message)); }
  };
  try {
    docker('network', 'create', tag);
    docker('run', '-d', '--name', names.db, '--network', tag, '-p', '127.0.0.1::5432', '-e', 'POSTGRES_DB=sim',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE);
    for (let i = 0; ; i++) {
      try { docker('exec', names.db, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'); break; }
      catch { if (i > 150) throw new Error('local database not ready'); await sleep(200); }
    }
    installPgCronStub(root, names.db, (argv, input) => execFileSync('docker', ['exec', ...argv], { input, encoding: 'utf8' }));
    const outcome = run => {
      try { run(); return { ok: true }; }
      catch (error) { return { ok: false, error: String(error.stderr ?? error.message).split('\n').slice(0, 12) }; }
    };
    const started = Date.now();
    const build = buildFromFiles(root, {
      applyFile: path => outcome(() => psql(readFileSync(resolve(root, path), 'utf8'))),
      applyServerOnly: text => outcome(() => psql('', ['-c', text])),
    });
    if (build.failed) throw new Error(`schema from files failed at ${build.failed.step}: ${build.failed.error.join(' | ')}`);
    log(`schema built from repository files: ${build.passed}/${build.steps} steps in ${Math.round((Date.now() - started) / 1000)} s`);
    psql('CREATE ROLE sim_auth LOGIN SUPERUSER; ALTER ROLE sim_auth SET search_path=auth,public;'
      + " INSERT INTO system_settings VALUES ('maintenance_mode','false') ON CONFLICT (key) DO NOTHING;");
    // The JWT secret goes in by variable name only, never on a command line.
    const secretEnv = { env: { ...process.env, PGRST_JWT_SECRET: secret, GOTRUE_JWT_SECRET: secret }, stdio: ['ignore', 'pipe', 'pipe'] };
    execFileSync('docker', ['run', '-d', '--name', names.rest, '--network', tag, '-p', '127.0.0.1::3000',
      '-e', `PGRST_DB_URI=postgres://authenticator@${names.db}:5432/sim`, '-e', 'PGRST_DB_SCHEMAS=public',
      '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', 'PGRST_JWT_SECRET', POSTGREST_IMAGE], secretEnv);
    // GoTrue: email sign-in only, no sign-up, no mail; users are created through its admin API by the seed.
    execFileSync('docker', ['run', '-d', '--name', names.auth, '--network', tag, '-p', '127.0.0.1::9999',
      '-e', 'GOTRUE_API_HOST=0.0.0.0', '-e', 'PORT=9999', '-e', 'GOTRUE_DB_DRIVER=postgres',
      '-e', `DATABASE_URL=postgres://sim_auth@${names.db}:5432/sim?sslmode=disable`, '-e', 'GOTRUE_SITE_URL=http://127.0.0.1',
      '-e', 'API_EXTERNAL_URL=http://127.0.0.1', '-e', 'GOTRUE_JWT_SECRET', '-e', 'GOTRUE_JWT_AUD=authenticated',
      '-e', 'GOTRUE_JWT_EXP=3600', '-e', 'GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated', '-e', 'GOTRUE_JWT_ADMIN_ROLES=service_role',
      '-e', 'GOTRUE_EXTERNAL_EMAIL_ENABLED=true', '-e', 'GOTRUE_MAILER_AUTOCONFIRM=true', '-e', 'GOTRUE_DISABLE_SIGNUP=true', GOTRUE_IMAGE],
    secretEnv);
    const port = (name, inner) => docker('port', name, inner).split(':').at(-1);
    const restUrl = `http://127.0.0.1:${port(names.rest, '3000')}`, authUrl = `http://127.0.0.1:${port(names.auth, '9999')}`;
    const bridge = await rateLimit.start();
    // Lua flag and transaction fixes between the app and the bridge: scripts/e2e-sim/redis-shim.mjs.
    redisShim = createRedisShim(bridge.UPSTASH_REDIS_REST_URL);
    await new Promise((resolve, reject) => { redisShim.once('error', reject); redisShim.listen(0, '127.0.0.1', resolve); });
    const redis = { UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${redisShim.address().port}`, UPSTASH_REDIS_REST_TOKEN: bridge.UPSTASH_REDIS_REST_TOKEN };
    gateway = createServer(async (req, res) => {
      const prefix = req.url?.startsWith('/rest/v1/') ? '/rest/v1' : req.url?.startsWith('/auth/v1/') ? '/auth/v1' : null;
      if (!prefix) { res.writeHead(404).end(); return; }
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const headers = { ...req.headers };
      for (const name of ['host', 'connection', 'content-length']) delete headers[name];
      try {
        const response = await fetch((prefix === '/rest/v1' ? restUrl : authUrl) + req.url.slice(prefix.length), {
          method: req.method, headers, redirect: 'manual', body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
        const out = Object.fromEntries(response.headers);
        delete out['content-encoding']; delete out['content-length'];
        res.writeHead(response.status, out);
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(502).end(); }
    });
    await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve); });
    const apiUrl = `http://127.0.0.1:${gateway.address().port}`;
    for (let i = 0; ; i++) {
      const ok = await Promise.all([fetch(`${restUrl}/`).then(r => r.status < 500, () => false), fetch(`${authUrl}/health`).then(r => r.ok, () => false)]);
      if (ok.every(Boolean)) break;
      if (i > 150) throw new Error('PostgREST or GoTrue not ready');
      await sleep(200);
    }
    log(`local backend ready on ${apiUrl}`);
    return {
      apiUrl, secret, redis, stop, psql, redisStats: () => redisShim.stats,
      dbUrl: `postgres://postgres@127.0.0.1:${port(names.db, '5432')}/sim`,
      jwt: role => signPreviewJwt(secret, role),
      redact: text => rateLimit.redact(String(text)).replaceAll(secret, '[SIM_SECRET]').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[SIM_TOKEN]'),
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
