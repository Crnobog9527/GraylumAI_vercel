/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { affectsSite, decide } from './vercel-ignore-build.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const SCRIPT = fileURLToPath(new URL('./vercel-ignore-build.mjs', import.meta.url));

describe('VERCEL-COST-2: which changed files can change the website', () => {
  it('counts the app, the API package it imports, the shared tsconfig and the install files', () => {
    for (const path of ['apps/web/src/app/page.tsx', 'apps/web/public/logo.svg', 'apps/web/package.json', 'apps/web/next.config.ts',
      'apps/web/vercel.json', 'apps/web/tsconfig.json', 'apps/web/postcss.config.mjs', 'apps/web/src/proxy.ts',
      'apps/web/scripts/build-library-sandbox.mjs', 'apps/web/assets/library-ocr/eng.traineddata', 'apps/web/content/legal/terms.html',
      'apps/web/sentry.server.config.ts', 'apps/web/some-new-config.ts', 'packages/api/src/root.ts', 'packages/api/package.json',
      'packages/tsconfig/base.json', 'packages/db/schema.ts', 'pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml', 'turbo.json', '.node-version',
      '.vercelignore', 'packages/api/src/scripts/e2eSim/seed.ts', 'packages/api/vitest.config.ts'])
      expect(affectsSite(path), path).toBe(true);
  });
  it('leaves out docs, tests, CI, migrations, database functions and the tools only tests or editors read', () => {
    for (const path of ['docs/launch/MASTER_PLAN.md', 'AGENTS.md', '.github/workflows/ci.yml', 'scripts/e2e-sim/run.mjs',
      'apps/web/tests/e2e/sim/10-steps.spec.ts', 'apps/web/src/lib/x.test.ts', 'apps/web/src/components/y.browser.test.tsx',
      'apps/web/src/lib/__tests__/z.ts', 'apps/web/README.md', 'apps/web/vitest.config.ts', 'apps/web/playwright.sim.config.ts',
      'apps/web/eslint.config.mjs', 'apps/web/next.config.test.ts', 'packages/api/src/services/a.test.ts',
      'packages/api/src/services/turn/chat.integration.ts', 'packages/db/migrations/0530_x.sql', 'packages/db/functions/x/y.sql',
      'packages/db/tests/v3/a.mjs'])
      expect(affectsSite(path), path).toBe(false);
  });
});

describe('VERCEL-COST-2: skip only when sure', () => {
  it('skips when the changes since the last deployment touch nothing of the website', () => {
    expect(decide({ previous: A, current: B, changed: ['docs/a.md', 'apps/web/src/x.test.ts'] }).build).toBe(false);
  });
  it('builds for a website change, an empty or unreadable previous commit, the same commit again, or changes that could not be listed', () => {
    expect(decide({ previous: A, current: B, changed: ['docs/a.md', 'apps/web/src/app/page.tsx'] }).build).toBe(true);
    expect(decide({ previous: '', current: B, changed: [] }).build).toBe(true);
    expect(decide({ previous: 'HEAD^', current: B, changed: [] }).build).toBe(true);
    expect(decide({ previous: B, current: B, changed: [] }).build).toBe(true);
    expect(decide({ previous: A, current: B, changed: null }).build).toBe(true);
  });
});

// The script as Vercel runs it: node, in the app folder of a real repository, with the system variables only.
describe('VERCEL-COST-2: the script against a real repository', () => {
  const repo = mkdtempSync(join(tmpdir(), 'vercel-ignore-'));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  const sh = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const put = (path: string, text: string) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
  const commit = (path: string, text: string) => { put(path, text); sh('add', '-A'); sh('commit', '-qm', path); return sh('rev-parse', 'HEAD'); };
  const exit = (previous?: string, cwd = join(repo, 'apps/web')) => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'production', PATH: process.env.PATH ?? '' };
    if (previous !== undefined) env.VERCEL_GIT_PREVIOUS_SHA = previous;
    return spawnSync(process.execPath, [SCRIPT], { cwd, env, encoding: 'utf8' }).status;
  };

  sh('init', '-q'); sh('config', 'user.email', 't@example.invalid'); sh('config', 'user.name', 't'); sh('config', 'commit.gpgsign', 'false');
  const first = commit('apps/web/src/app/page.tsx', 'one');

  it('exits 0 (skip) after a docs-only commit, measured from the last deployment, not HEAD^', () => {
    const deployed = first;
    commit('apps/web/src/app/page.tsx', 'two'); // a website change, then docs on top: HEAD^..HEAD alone would miss it
    commit('docs/note.md', 'x');
    expect(exit(deployed)).toBe(1);
    const afterBuild = sh('rev-parse', 'HEAD');
    commit('docs/other.md', 'y');
    commit('apps/web/src/lib/a.test.ts', 'z');
    expect(exit(afterBuild)).toBe(0);
  });
  it('exits 1 (build) with no previous deployment, the same commit, an unknown commit, or no repository', () => {
    const head = sh('rev-parse', 'HEAD');
    expect(exit(undefined)).toBe(1);
    expect(exit('')).toBe(1);
    expect(exit(head)).toBe(1);
    expect(exit('c'.repeat(40))).toBe(1);
    const bare = mkdtempSync(join(tmpdir(), 'vercel-ignore-nogit-'));
    try { expect(exit(first, bare)).toBe(1); } finally { rmSync(bare, { recursive: true, force: true }); }
  });
  it('is the app\'s ignoreCommand, run from the app folder', () => {
    const config = JSON.parse(readFileSync(fileURLToPath(new URL('../vercel.json', import.meta.url)), 'utf8'));
    expect(config.ignoreCommand).toBe('node scripts/vercel-ignore-build.mjs');
  });
});
