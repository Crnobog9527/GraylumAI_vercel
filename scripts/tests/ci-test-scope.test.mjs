/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { changedFiles, decide, isDocsPath, isSkippablePath } from '../ci-test-scope.mjs';

const pr = files => decide({ eventName: 'pull_request', baseRef: 'staging', files });

test('a pure front-end or documentation pull request skips the database jobs', () => {
  assert.equal(pr(['apps/web/src/components/landing/Hero.tsx', 'apps/web/src/components/landing/Hero.test.tsx']).full, false);
  assert.equal(pr(['apps/web/src/app/(zh-hans)/pricing/page.tsx', 'apps/web/src/app/globals.css']).full, false);
  assert.equal(pr(['docs/ENGINEERING.md', 'docs/launch/design/x.html', 'README.md']).full, false);
  assert.equal(pr(['docs/a.md', 'apps/web/src/components/a.module.css']).full, false);
});

test('docs_only is true only when every changed file is plainly a document', () => {
  assert.equal(pr(['docs/ENGINEERING.md', 'docs/launch/design/x.html', 'README.md']).docsOnly, true);
  assert.equal(pr(['docs/runbook.md', 'docs/img/shot.png', 'docs/data/table.csv', 'docs/notes.txt', 'AGENTS.md']).docsOnly, true);
  // Documentation next to front-end changes is not documentation only, and neither is the front-end alone.
  assert.equal(pr(['apps/web/src/components/landing/Hero.tsx']).docsOnly, false);
  assert.equal(pr(['docs/a.md', 'apps/web/src/components/a.module.css']).docsOnly, false);
});

test('a pull request that changes a code or data file is never judged documentation only, alone or next to documents', () => {
  const code = [
    'apps/web/src/app/api/turn/route.ts', 'apps/web/src/components/a.tsx', 'apps/web/tests/e2e/sim/support.ts', 'packages/api/src/x.ts',
    'packages/db/migrations/0001_x.sql', 'scripts/a.mjs', 'scripts/ci-test-scope.mjs', '.github/workflows/ci.yml', '.github/scripts/x.rb',
    'package.json', 'pnpm-lock.yaml', 'turbo.json', 'apps/web/package.json',
    // Under docs/, but code or data that tooling can run or read.
    'docs/validation/run.mjs', 'docs/schema.sql', 'docs/api.graphql', 'docs/launch/data.json', 'docs/log.jsonl', 'docs/.gitignore',
    // Markdown that is not a document of this repository's own docs: content and fixtures.
    'apps/web/README.md', 'apps/web/content/post.md', 'packages/api/README.md', 'scripts/README.md', '.github/pull_request_template.md',
  ];
  for (const path of code) {
    assert.equal(isDocsPath(path), false, path);
    assert.equal(pr([path]).docsOnly, false, path);
    assert.equal(pr(['docs/a.md', path]).docsOnly, false, `docs/a.md with ${path}`);
  }
  // Unknown, missing or empty input, a push, or a base other than staging: never documentation only either.
  for (const input of [{ eventName: 'push', baseRef: 'staging', files: ['docs/a.md'] }, { eventName: 'pull_request', baseRef: 'main', files: ['docs/a.md'] },
    { eventName: 'pull_request', baseRef: 'staging', files: [] }, { eventName: 'pull_request', baseRef: 'staging', files: null }]) {
    assert.equal(decide(input).docsOnly, false, JSON.stringify(input));
  }
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

test('a draft flag changes nothing: every pull request is judged by its files (Owner 2026-11-03)', () => {
  for (const draft of [true, false, undefined]) {
    const judge = files => decide({ eventName: 'pull_request', baseRef: 'staging', files, draft });
    assert.equal(judge(['packages/api/src/routers/billing.ts']).full, true, `draft=${String(draft)} runs the database jobs`);
    assert.equal(judge(null).full, true);
    assert.equal(judge(['docs/a.md']).full, false, 'the allow-list still applies');
    assert.equal(decide({ eventName: 'pull_request', baseRef: 'main', files: ['docs/a.md'], draft }).full, true);
  }
});
