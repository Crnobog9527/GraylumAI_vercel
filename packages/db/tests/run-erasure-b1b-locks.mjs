/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// C12: two real PostgreSQL sessions. An explicit stdout barrier proves the parent lock is held
// before a fresh service-role session scrubs. No timing-only sleep and no remote database inputs.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildFromFiles, installPgCronStub } from './baseline/build-from-files.mjs';
import { POSTGRES_IMAGE } from './v3/images.mjs';

if (process.argv.slice(2).join(' ') !== '--local-only' || process.env.CI) {
  throw new Error('Usage: node packages/db/tests/run-erasure-b1b-locks.mjs --local-only');
}
const root = resolve(import.meta.dirname, '../../..');
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
const options = { cwd: root, env, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 };
const ok = (result, label) => {
  if (result.error || result.status !== 0) throw new Error(`${label}: ${result.stderr || result.error || result.status}`);
  return result.stdout.trim();
};
const endpoint = ok(spawnSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], options), 'Docker context');
if (!endpoint.startsWith('unix:///') || endpoint.includes('\n')) throw new Error('Only a local Unix Docker socket is allowed');
const docker = (args, input) => spawnSync('docker', ['--host', endpoint, ...args], { ...options, input });
const name = `graylum-b1b-locks-${randomUUID().slice(0, 8)}`;
const psqlArgs = ['exec', '-i', name, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'dbb', '-v', 'ON_ERROR_STOP=1'];
const sql = text => docker([...psqlArgs, '-f', '/dev/stdin'], text);
let holder;
let holderClosed;
async function hold(query) {
  holder = spawn('docker', ['--host', endpoint, ...psqlArgs], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  holder.stderr.on('data', chunk => { stderr += chunk; });
  holderClosed = new Promise(done => holder.once('close', code => done({ code, stderr })));
  const ready = new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('Parent lock barrier timed out')), 15000);
    let output = '';
    holder.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/B1B_LOCK_HELD:(\d+)/);
      if (match) { clearTimeout(timer); done(Number(match[1])); }
    });
    holder.once('error', error => { clearTimeout(timer); fail(error); });
    holder.once('close', () => { clearTimeout(timer); fail(new Error(`Lock holder exited before release: ${stderr}`)); });
  });
  holder.stdin.write(`BEGIN; SET LOCAL lock_timeout='3s'; ${query}; SELECT 'B1B_LOCK_HELD:' || pg_backend_pid();\n`);
  return ready;
}
async function release() {
  if (!holder) return;
  holder.stdin.end('ROLLBACK;\n\\q\n');
  const result = await holderClosed;
  holder = undefined;
  assert.equal(result.code, 0, result.stderr);
}
function scrub(holderPid) {
  return JSON.parse(ok(sql(`BEGIN;
    SET LOCAL statement_timeout='3s';
    DO $$ BEGIN
      IF pg_backend_pid() = ${holderPid} THEN RAISE EXCEPTION 'C12 requires a second session'; END IF;
      PERFORM set_config('b1b.closed',(SELECT id::text FROM profiles WHERE nickname='b1b-closed'),true);
    END $$;
    SET LOCAL ROLE service_role;
    SELECT account_erasure_scrub_runtime(current_setting('b1b.closed')::uuid);
    ROLLBACK;`), 'Concurrent scrub'));
}
const normal = {
  runtime_sessions: [1, 1], runtime_executions: [2, 2], runtime_history_dependencies: [1, 2],
  runtime_session_batches: [2, 2], runtime_session_history: [2, 2], runtime_tool_calls: [2, 2],
  runtime_scope_material: [1, 1], conversations: [2, 2], messages: [2, 2],
  conversation_context_snapshots: [2, 2], ordinary_chat_requests: [2, 1],
};
function counts(result, expected) {
  assert.equal(Object.keys(result).length, 22);
  for (const [table, [done, skipped]] of Object.entries(expected)) {
    assert.equal(result[table], done, `${table} processed`);
    assert.equal(result[`${table}_skipped`], skipped, `${table} skipped`);
  }
}
try {
  ok(docker(['image', 'inspect', POSTGRES_IMAGE]), 'Pinned local image');
  ok(docker(['run', '-d', '--pull=never', '--name', name, '-e', 'POSTGRES_DB=dbb',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE]), 'Local container');
  let ready = false;
  for (let attempt = 0; attempt < 300 && !ready; attempt += 1) {
    ready = docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'dbb']).status === 0;
    if (!ready) await new Promise(done => setTimeout(done, 200));
  }
  if (!ready) throw new Error('Local Postgres readiness timeout');
  installPgCronStub(root, name, (args, input) => ok(docker(['exec', ...args], input), 'pg_cron stand-in'));
  const outcome = result => ({ ok: result.status === 0 && !result.error, error: result.stderr });
  const built = buildFromFiles(root, {
    applyFile: path => outcome(sql(readFileSync(resolve(root, path), 'utf8'))),
    applyServerOnly: text => outcome(docker([...psqlArgs, '-c', text])),
  });
  assert.equal(built.failed, null, JSON.stringify(built.failed));
  ok(sql(readFileSync(resolve(root, 'packages/db/tests/erasure-b1b-cases.sql'), 'utf8')), 'Committed fixtures and C1-C10');
  ok(sql(readFileSync(resolve(root, 'packages/db/tests/erasure-b1b-parent.sql'), 'utf8')), 'Parent guard and real finalizers');
  const cases = [
    { label: 'Runtime session', lock: "SELECT 1 FROM runtime_sessions WHERE scope->>'privateScope'='c_session' FOR UPDATE" },
    { label: 'Legacy conversation', lock: "SELECT 1 FROM conversations WHERE title='b1b-c_conv' FOR UPDATE" },
  ];
  for (const test of cases) {
    const pid = await hold(test.lock);
    assert.deepEqual(scrub(pid), { retry: true, reason: 'transactions_pending' });
    assert.equal(ok(sql("SELECT count(*) FROM runtime_sessions WHERE erased_at IS NOT NULL"), 'No partial erasure'), '0');
    await release();
    counts(scrub(pid), normal);
    console.log(`PASS C12 ${test.label}: older transaction blocks scrub without partial counters; all counts verified after release`);
  }
} finally {
  try { await release(); } finally { ok(docker(['rm', '-f', '-v', name]), 'Local cleanup'); }
}
console.log('PASS local container cleanup');
