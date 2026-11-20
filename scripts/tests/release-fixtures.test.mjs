/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
function run(source, cwd = root) {
  return spawnSync('pnpm', ['--dir', join(root, 'packages/api'), 'exec', 'tsx', '-e', source], {
    cwd, encoding: 'utf8', env: { ...process.env, RELEASE_PREFLIGHT_ISOLATED: '1', RELEASE_PREFLIGHT_AUTH_DIR: join(tmpdir(), 'preflight-auth-unused') },
  });
}
test('fixture refuses an external database before connecting', () => {
  const db = join(root, 'apps/web/tests/e2e/support/e2eDb.ts');
  const r = run(`import {getE2ESql} from ${JSON.stringify(db)}; process.env.DATABASE_URL='postgres://evil.test/sim';
    try { getE2ESql(); process.exit(1); } catch(e) { if (!String(e).includes('disposable loopback')) process.exit(2); }`);
  assert.equal(r.status, 0, r.stderr);
});
test('isolated fixture does not load a local environment file', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'preflight-env-'));
  try {
    writeFileSync(join(tmp, '.env.local'), 'PREFLIGHT_ENV_SENTINEL=loaded\n');
    const db = join(root, 'apps/web/tests/e2e/support/e2eDb.ts');
    const r = run(`import {loadE2EEnv} from ${JSON.stringify(db)}; delete process.env.PREFLIGHT_ENV_SENTINEL;
      process.chdir(${JSON.stringify(tmp)}); loadE2EEnv(); if(process.env.PREFLIGHT_ENV_SENTINEL) process.exit(1);`);
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
test('auth setup reads maintenance and refuses enabled or invalid state without writes', () => {
  const auth = join(root, 'apps/web/tests/e2e/support/auth.ts');
  const r = run(`import {ensureMaintenanceModeDisabled} from ${JSON.stringify(auth)};
    (async()=>{for(const value of [false,'false',undefined,true,'true',null]) {
      let statement=''; const sql=async (strings)=>{statement=strings.join(''); return value===undefined?[]:[{value}];};
      let threw=false; try {await ensureMaintenanceModeDisabled(sql);} catch {threw=true;}
      if(!/^select /i.test(statement.trim()) || threw !== ![false,'false',undefined].includes(value)) process.exit(1);
    }})().catch(()=>process.exit(2));`);
  assert.equal(r.status, 0, r.stderr);
});
test('isolated Playwright configuration refuses external or missing app targets before running tests', () => {
  for (const value of ['', 'https://example.com']) {
    const r = spawnSync('pnpm', ['--filter', 'web', 'exec', 'playwright', 'test', '--list'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, RELEASE_PREFLIGHT_ISOLATED: '1',
        PLAYWRIGHT_BASE_URL: value, RELEASE_PREFLIGHT_PROXY: 'http://127.0.0.1:12345' },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /requires its local app and blocking proxy/);
  }
});
test('isolated Playwright setup accepts owned loopback inputs and lists tests without reading env files', () => {
  const temp = mkdtempSync(join(tmpdir(), 'preflight-config-'));
  try {
    const r = spawnSync('pnpm', ['--filter', 'web', 'exec', 'playwright', 'test', '--list', 'tests/e2e/auth.spec.ts'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, RELEASE_PREFLIGHT_ISOLATED: '1',
        PLAYWRIGHT_BASE_URL: 'http://127.0.0.1:45678', RELEASE_PREFLIGHT_PROXY: 'http://127.0.0.1:45679',
        RELEASE_PREFLIGHT_RUN_DIR: temp, RELEASE_PREFLIGHT_AUTH_DIR: join(temp, 'auth') },
    });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /auth\.spec\.ts/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
