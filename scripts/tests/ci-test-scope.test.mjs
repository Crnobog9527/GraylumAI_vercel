/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { changedFiles, decide, isDraft, isSkippablePath } from '../ci-test-scope.mjs';

const pr = files => decide({ eventName: 'pull_request', baseRef: 'staging', files });

test('a pure front-end or documentation pull request skips the database jobs', () => {
  assert.equal(pr(['apps/web/src/components/landing/Hero.tsx', 'apps/web/src/components/landing/Hero.test.tsx']).full, false);
  assert.equal(pr(['apps/web/src/app/(zh-hans)/pricing/page.tsx', 'apps/web/src/app/globals.css']).full, false);
  assert.equal(pr(['docs/ENGINEERING.md', 'docs/launch/design/x.html', 'README.md']).full, false);
  assert.equal(pr(['docs/a.md', 'apps/web/src/components/a.module.css']).full, false);
});

test('anything outside the allow-list runs the full suite, even mixed with allowed files', () => {
  const ui = 'apps/web/src/components/Hero.tsx';
  for (const blocking of [
    'packages/api/src/routers/billing.ts', 'packages/db/migrations/0001_x.sql', 'supabase/config.toml',
    'apps/web/src/app/api/turn/route.ts', 'apps/web/src/app/api/turn/helper.tsx', 'apps/web/src/app/api/x/page.test.tsx',
    'apps/web/src/proxy.ts', 'apps/web/src/middleware.ts', 'apps/web/src/app/(zh-hans)/pricing/route.ts',
    'apps/web/src/lib/credits.ts', 'apps/web/src/hooks/useThing.ts', 'apps/web/src/app/sitemap.ts',
    '.github/workflows/ci.yml', 'scripts/ci-test-scope.mjs', 'scripts/notes.md', 'packages/skills/SKILL.md',
    'package.json', 'pnpm-lock.yaml', 'apps/web/package.json', 'apps/web/next.config.ts', 'apps/web/public/logo.png',
  ]) {
    assert.equal(pr([ui, blocking]).full, true, blocking);
    assert.equal(pr([blocking]).full, true, blocking);
  }
});

test('an empty, missing or unreadable file list runs the full suite', () => {
  assert.equal(pr([]).full, true);
  assert.equal(pr(null).full, true);
  assert.equal(pr(undefined).full, true);
  assert.equal(pr('docs/a.md').full, true);
});

test('only a pull request into staging may skip', () => {
  const files = ['docs/a.md'];
  assert.equal(decide({ eventName: 'pull_request', baseRef: 'main', files }).full, true);
  assert.equal(decide({ eventName: 'pull_request', baseRef: '', files }).full, true);
  assert.equal(decide({ eventName: 'pull_request', files }).full, true);
  assert.equal(decide({ eventName: 'push', baseRef: 'staging', files }).full, true);
  assert.equal(decide({ eventName: 'schedule', baseRef: '', files }).full, true);
  assert.equal(decide({ baseRef: 'staging', files }).full, true);
});

test('odd paths never count as allowed', () => {
  for (const path of ['docs/../packages/x.ts', '../docs/a.md', '/docs/a.md', 'docs//a.md', 'docs/./a.md', 'docs\\a.md', 'docs/a\nb.md', '', 'docs']) {
    assert.equal(isSkippablePath(path), false, JSON.stringify(path));
  }
  assert.equal(isSkippablePath(undefined), false);
  assert.equal(isSkippablePath('notes/a.MD'), false);
  assert.equal(isSkippablePath('docs/x.sql'), true, 'docs/** is allowed whatever the extension');
});

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8' });

test('changedFiles reads the pull request from its merge commit and gives up on anything else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-scope-'));
  try {
    const run = (...args) => git(dir, ...args);
    const read = () => changedFiles((...args) => git(dir, ...args));
    run('init', '-q', '-b', 'staging');
    writeFileSync(join(dir, 'a.txt'), 'a');
    run('add', 'a.txt'); run('commit', '-q', '-m', 'base');
    run('checkout', '-q', '-b', 'feature');
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'x y.md'), 'x');
    writeFileSync(join(dir, 'a.txt'), 'changed');
    run('add', '.'); run('commit', '-q', '-m', 'feature');
    run('checkout', '-q', 'staging');
    writeFileSync(join(dir, 'later.txt'), 'later');
    run('add', 'later.txt'); run('commit', '-q', '-m', 'base moved on');
    assert.equal(read(), null, 'a plain commit is not a merge ref');
    run('merge', '-q', '--no-ff', '-m', 'merge', 'feature');
    assert.deepEqual(read()?.sort(), ['a.txt', 'docs/x y.md'], 'only the pull request side, spaces intact, not what the base gained');
    assert.equal(changedFiles(() => { throw new Error('no git'); }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a draft pull request skips the database jobs whatever it changes; a ready one is judged by its files', () => {
  const draft = (files, baseRef = 'staging') => decide({ eventName: 'pull_request', baseRef, files, draft: true });
  assert.equal(draft(['packages/api/src/routers/billing.ts']).full, false);
  assert.equal(draft(null).full, false);
  assert.equal(draft([], 'main').full, false);
  const ready = (files, draftFlag) => decide({ eventName: 'pull_request', baseRef: 'staging', files, draft: draftFlag });
  for (const flag of [false, undefined, null, 'true', 1]) {
    assert.equal(ready(['packages/api/src/routers/billing.ts'], flag).full, true, `draft=${String(flag)} is not a draft`);
    assert.equal(ready(['docs/a.md'], flag).full, false);
  }
  for (const eventName of ['push', 'schedule', undefined]) {
    assert.equal(decide({ eventName, baseRef: 'staging', files: ['docs/a.md'], draft: true }).full, true, 'a draft flag means nothing outside pull requests');
  }
});

test('isDraft reads the pull request payload and treats anything unreadable as ready', () => {
  const payload = draft => () => JSON.stringify({ pull_request: { draft } });
  assert.equal(isDraft('x', payload(true)), true);
  assert.equal(isDraft('x', payload(false)), false);
  assert.equal(isDraft('x', () => JSON.stringify({ pull_request: {} })), false);
  assert.equal(isDraft('x', () => JSON.stringify({})), false);
  assert.equal(isDraft('x', () => 'not json'), false);
  assert.equal(isDraft('x', () => { throw new Error('no file'); }), false);
  assert.equal(isDraft('x', payload('true')), false, 'only the boolean true counts');
});
