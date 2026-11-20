/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'preflight-test-'));
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'));
  copyFileSync(resolve('scripts/run-release-preflight.sh'), join(root, 'scripts/run-release-preflight.sh'));
  const stub = `#!/bin/sh\nprintf '%s\\n' "\${SENSITIVE_VARIABLE-unset}" >> "${root}/inherited"\nexit "\${STUB_EXIT:-0}"\n`;
  for (const name of ['pnpm', 'node']) {
    const file = join(root, 'bin', name);
    const suites = name === 'node' ? "printf 'release suite %s: passed (skipped: 0)\\n' chat home-routing auth admin admin-config admin-ops security user-supplemental\nprintf 'release suite user-extended: passed (skipped: 0) [checkout display uses simulated reads, not payment integration]\\n'\n" : '';
    writeFileSync(file, stub.replace('exit ', suites + 'exit ')); chmodSync(file, 0o755);
  }
  const run = (args, extraEnv = {}) => {
    const result = spawnSync('bash', [join(root, 'scripts/run-release-preflight.sh'), ...args], {
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, SENSITIVE_VARIABLE: 'do-not-inherit', ...extraEnv }, encoding: 'utf8' });
    const latest = readFileSync(join(root, '.release-output/preflight/latest-run.txt'), 'utf8').trim();
    return { ...result, summary: readFileSync(join(latest, '00-release-preflight-summary.md'), 'utf8') };
  };
  return { root, run, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('successful simulated commands use clean environment and report optional destructive suite as skipped', () => {
  const f = fixture(); try {
    const result = f.run(['--local-only']);
    assert.equal(result.status, 0); assert.match(result.summary, /isolated-rehearsal: passed/);
    assert.match(result.summary, /admin-destructive: skipped/);
    assert.match(result.summary, /long-text confirmation: retired by Owner decision/);
    assert.doesNotMatch(result.summary, /pending product decision/);
    assert.doesNotMatch(readFileSync(join(f.root, 'inherited'), 'utf8'), /do-not-inherit/);
  } finally { f.close(); }
});
test('skip and omitted required rehearsal are not a pass', () => {
  const f = fixture(); try {
    const result = f.run(['--skip-local-build']);
    assert.notEqual(result.status, 0); assert.match(result.summary, /build: skipped/);
    assert.match(result.summary, /isolated-rehearsal: not-run/);
  } finally { f.close(); }
});
test('external target fails before any command', () => {
  const f = fixture(); try {
    const result = f.run(['--with-preview', '--preview-url', 'https://example.com']);
    assert.notEqual(result.status, 0); assert.match(result.summary, /configuration: failed/);
    assert.match(result.summary, /typecheck: not-run/);
  } finally { f.close(); }
});
test('environment files fail before any command', () => {
  const f = fixture(); try {
    writeFileSync(join(f.root, '.env.local'), 'SECRET=unused');
    const result = f.run(['--local-only']);
    assert.notEqual(result.status, 0); assert.match(result.summary, /environment file present/);
  } finally { f.close(); }
});
test('failed command is reported and sets a failing exit code', () => {
  const f = fixture(); try {
    writeFileSync(join(f.root, 'bin/pnpm'), '#!/bin/sh\nexit 4\n');
    const result = f.run(['--local-only']);
    assert.notEqual(result.status, 0); assert.match(result.summary, /typecheck: failed/);
    assert.match(result.summary, /build: failed/); assert.match(result.summary, /isolated-rehearsal: passed/);
  } finally { f.close(); }
});
test('network guard refuses a remote TCP target before connection', () => {
  const guard = resolve('scripts/e2e-sim/release-network.cjs');
  const result = spawnSync(process.execPath, ['--require', guard, '-e',
    "require('node:net').connect({host:'203.0.113.1',port:443})"], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /RELEASE_PREFLIGHT_NETWORK_BLOCKED/);
});

test('missing suite evidence fails even if the runner exits successfully', () => {
  const f = fixture(); try {
    writeFileSync(join(f.root, 'bin/node'), '#!/bin/sh\nexit 0\n');
    const result = f.run(['--local-only']);
    assert.notEqual(result.status, 0); assert.match(result.summary, /isolated-rehearsal: failed/);
    assert.match(result.summary, /release suite chat: not-run/);
  } finally { f.close(); }
});

test('legacy external target variables are rejected rather than ignored', () => {
  const f = fixture(); try {
    for (const key of ['PREVIEW_URL', 'PLAYWRIGHT_BASE_URL', 'VERCEL_BYPASS_COOKIE', 'DATABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'TURN_DATABASE_HOST']) {
      const result = f.run(['--with-preview'], { [key]: 'untrusted' });
      assert.notEqual(result.status, 0); assert.match(result.summary, /configuration: failed/);
    }
  } finally { f.close(); }
});

test('preview mode cannot succeed without remote target verification', () => {
  const f = fixture(); try {
    const result = f.run(['--with-preview']);
    assert.notEqual(result.status, 0); assert.match(result.summary, /remote-preview: not-run/);
  } finally { f.close(); }
});

test('local and remote modes cannot be combined in either order', () => {
  const f = fixture(); try {
    for (const args of [['--with-preview', '--local-only'], ['--local-only', '--with-preview']]) {
      const result = f.run(args); assert.notEqual(result.status, 0);
      assert.match(result.summary, /cannot be combined/);
    }
  } finally { f.close(); }
});

test('remote mode checks staging link and refuses a missing binding even when commands exit zero', () => {
  const f = fixture(); try {
    const work = join(f.root, 'sb'); mkdirSync(join(work, 'supabase/.temp'), { recursive: true });
    writeFileSync(join(work, 'supabase/.temp/project-ref'), 'gvcpmcunmfrbxuwimxfa');
    const result = f.run(['--with-preview', '--preview-url', 'https://auth-staging.graylum.com', '--staging-workdir', work]);
    assert.notEqual(result.status, 0); assert.match(result.summary, /remote-preview: failed/);
  } finally { f.close(); }
});
test('wrong staging link stops before running local or remote checks', () => {
  const f = fixture(); try {
    const work = join(f.root, 'sb'); mkdirSync(join(work, 'supabase/.temp'), { recursive: true });
    writeFileSync(join(work, 'supabase/.temp/project-ref'), 'wrong');
    const result = f.run(['--with-preview', '--preview-url', 'https://auth-staging.graylum.com', '--staging-workdir', work]);
    assert.notEqual(result.status, 0); assert.match(result.summary, /not linked to the approved test project/);
    assert.match(result.summary, /typecheck: not-run/);
  } finally { f.close(); }
});
