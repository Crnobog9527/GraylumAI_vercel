/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

function fixture(ref = 'gvcpmcunmfrbxuwimxfa') {
  const temp = mkdtempSync(join(tmpdir(), 'release-readonly-')), bin = join(temp, 'bin'), work = join(temp, 'sb');
  mkdirSync(bin); mkdirSync(join(work, 'supabase/.temp'), { recursive: true });
  writeFileSync(join(work, 'supabase/.temp/project-ref'), ref);
  writeFileSync(join(work, 'supabase/.temp/pooler-url'),
    'postgresql://postgres.gvcpmcunmfrbxuwimxfa@aws-0-us.pooler.supabase.com:6543/postgres');
  const make = (name, body) => { const file = join(bin, name); writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); };
  make('git', `case "$1" in status) exit 0;; *) printf '%s\\n' '${'a'.repeat(40)}';; esac`);
  make('vercel', `printf '%s\\n' "$*" >> '${temp}/calls'
case "$*" in
  *v9/projects*) printf '%s\\n' '{"id":"prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC","name":"graylumai-staging"}';;
  *) printf '%s\\n' '{"projectId":"prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC","readyState":"READY","meta":{"githubCommitRef":"staging","githubCommitSha":"${'a'.repeat(40)}"}}';;
esac`);
  make('supabase', `printf '%s\\n' "$*" >> '${temp}/calls'\nprintf '%s\\n' '{"rows":[{"value":"false"}]}'`);
  const run = () => spawnSync(process.execPath, [resolve('scripts/release-staging-readonly.mjs'), '--staging-workdir', work], {
    cwd: resolve('.'), encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: temp },
  });
  return { temp, bin, run, close: () => rmSync(temp, { recursive: true, force: true }) };
}
test('matching staging identity and read-only maintenance are reported, with binding still unverified', () => {
  const f = fixture(); try {
    const r = f.run(); assert.notEqual(r.status, 0);
    for (const item of ['staging-target: passed', 'deployment-project: passed', 'deployment-identity: passed',
      'deployment-version: passed', 'staging-maintenance: passed', 'runtime-binding: not-run']) assert.match(r.stdout, new RegExp(item));
  } finally { f.close(); }
});
test('wrong database link stops before any external command', () => {
  const f = fixture('wrong'); try {
    const r = f.run(); assert.notEqual(r.status, 0); assert.match(r.stdout, /staging-target: failed/);
    assert.equal(existsSync(join(f.temp, 'calls')), false);
  } finally { f.close(); }
});
test('maintenance enabled is reported as failure, never a pass', () => {
  const f = fixture(); try {
    writeFileSync(join(f.bin, 'supabase'), '#!/bin/sh\nprintf \'%s\\n\' \'{"rows":[{"value":"true"}]}\'\n');
    const r = f.run(); assert.notEqual(r.status, 0); assert.match(r.stdout, /staging-maintenance: failed/);
  } finally { f.close(); }
});
test('failed platform read is not retried or leaked, and maintenance remains an independent read', () => {
  const f = fixture(); try {
    writeFileSync(join(f.bin, 'vercel'), '#!/bin/sh\nprintf "private-token-placeholder\\n" >&2\nexit 1\n');
    const r = f.run(); assert.notEqual(r.status, 0);
    assert.match(r.stdout, /deployment-project: failed/); assert.match(r.stdout, /deployment-identity: not-run/);
    assert.match(r.stdout, /staging-maintenance: passed/); assert.doesNotMatch(r.stdout + r.stderr, /private-token-placeholder/);
  } finally { f.close(); }
});
test('wrong deployment version is explicitly reported as failure', () => {
  const f = fixture(); try {
    writeFileSync(join(f.bin, 'git'), '#!/bin/sh\nprintf "%s\\n" wrong-version\n');
    const r = f.run(); assert.notEqual(r.status, 0); assert.match(r.stdout, /deployment-version: failed/);
  } finally { f.close(); }
});

test('a dirty tracked checkout cannot be reported as matching deployment', () => {
  const f = fixture(); try {
    writeFileSync(join(f.bin, 'git'), `#!/bin/sh\ncase "$1" in status) printf ' M file\\n';; *) printf '%s\\n' '${'a'.repeat(40)}';; esac\n`);
    const r = f.run(); assert.match(r.stdout, /deployment-version: failed/);
  } finally { f.close(); }
});
test('unsafe pooler binding stops before any external command', () => {
  const f = fixture(); try {
    writeFileSync(join(f.temp, 'sb/supabase/.temp/pooler-url'), 'postgresql://postgres.other:secret@evil.test/postgres');
    const r = f.run(); assert.match(r.stdout, /staging-target: failed/); assert.equal(existsSync(join(f.temp, 'calls')), false);
  } finally { f.close(); }
});
test('target validation alone makes no external calls', () => {
  const f = fixture(); try {
    const work = join(f.temp, 'sb');
    const r = spawnSync(process.execPath, [resolve('scripts/release-staging-readonly.mjs'), '--staging-workdir', work, '--validate-only'], {
      cwd: resolve('.'), encoding: 'utf8', env: { PATH: `${f.bin}:${process.env.PATH}`, HOME: f.temp },
    });
    assert.equal(r.status, 0); assert.match(r.stdout, /staging-target: passed/);
    assert.equal(existsSync(join(f.temp, 'calls')), false);
  } finally { f.close(); }
});
test('untracked source prevents a deployment version match', () => {
  const f = fixture(); try {
    writeFileSync(join(f.bin, 'git'), `#!/bin/sh\ncase "$1" in status) printf '?? new-source.ts\\n';; *) printf '%s\\n' '${'a'.repeat(40)}';; esac\n`);
    const r = f.run(); assert.match(r.stdout, /deployment-version: failed/);
  } finally { f.close(); }
});
