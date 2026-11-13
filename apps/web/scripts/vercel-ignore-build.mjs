/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// VERCEL-COST-2: Vercel's "Ignored Build Step" for this app (vercel.json ignoreCommand). Exit 0 skips the build (the deployment is
// marked CANCELED and the site keeps the last one); exit 1 builds. It skips only when it is sure: the commits since the branch's last
// successful deployment (VERCEL_GIT_PREVIOUS_SHA) were read from git without an error and touch nothing the website is built from.
// Anything it cannot tell for certain builds: no previous deployment, the same commit again (a redeploy after changing a variable),
// a commit missing from Vercel's shallow clone (depth 10), no .git at all (a CLI upload), or any git failure.
// It runs in the Root Directory (apps/web) with the system variables; it prints one line saying why, and nothing else.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;

/** Repository files outside the app that the install, the upload or the build reads (.vercelignore decides what Vercel takes). */
const ROOT_FILES = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'turbo.json', '.node-version', '.npmrc',
  '.vercelignore']);
/** Test files and fixtures: never part of the built site. */
const TEST_FILE = /(^|\/)(__tests__|__fixtures__)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.integration\.[cm]?[jt]sx?$/;
/** apps/web files that only the tests, the linter or editors read (the app's other files all count, new ones included). */
const WEB_TOOLING = new Set(['README.md', '.gitignore', 'eslint.config.mjs', 'eslint-suppressions.json', 'vitest.config.ts',
  'next.config.test.ts', 'playwright.config.ts', 'playwright.core-path.config.ts', 'playwright.sim.config.ts']);
/** packages/db files the app reads (its schema types); migrations, functions, seeds and database tests are not built into the site. */
const DB_FILES = new Set(['package.json', 'schema.ts']);

/** Whether a changed path (from the repository root) can change the deployed website. */
export function affectsSite(path) {
  if (ROOT_FILES.has(path)) return true;
  const inside = (prefix) => path.startsWith(prefix) ? path.slice(prefix.length) : null;
  const web = inside('apps/web/');
  if (web !== null) return !web.startsWith('tests/') && !TEST_FILE.test(web) && !WEB_TOOLING.has(web);
  // The app imports @repo/api's source and extends @repo/tsconfig (checked against the web program's files, `tsc --listFilesOnly`:
  // outside apps/web it reads only packages/api/src and packages/db/schema.ts; @repo/api depends on no other workspace package).
  const api = inside('packages/api/') ?? inside('packages/tsconfig/');
  if (api !== null) return !TEST_FILE.test(api);
  const db = inside('packages/db/');
  if (db !== null) return DB_FILES.has(db);
  return false;
}

/**
 * The decision, from what was read. `changed` is null when git could not list the changes.
 * @returns {{ build: boolean, reason: string }}
 */
export function decide({ previous, current, changed }) {
  if (!previous) return { build: true, reason: 'no previous deployment on this branch' };
  if (!SHA.test(previous) || !SHA.test(current ?? '')) return { build: true, reason: 'commit ids not readable' };
  if (previous === current) return { build: true, reason: 'same commit as the last deployment (a redeploy)' };
  if (changed === null) return { build: true, reason: 'changes could not be listed' };
  const hit = changed.find(affectsSite);
  if (hit) return { build: true, reason: `website file changed: ${hit}` };
  return { build: false, reason: `${changed.length} changed file(s), none of them part of the website` };
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** Reads git and decides; any error builds. Returns the exit code (0 skip, 1 build). */
export function run(env = process.env, log = console.log) {
  let result;
  try {
    const previous = (env.VERCEL_GIT_PREVIOUS_SHA ?? '').trim();
    const root = git(['rev-parse', '--show-toplevel']).trim();
    const current = git(['-C', root, 'rev-parse', 'HEAD']).trim();
    let changed = null;
    if (previous && SHA.test(previous) && previous !== current) {
      try {
        changed = git(['-C', root, 'diff', '--name-only', '--no-renames', '-z', `${previous}..${current}`]).split('\0').filter(Boolean);
      } catch { changed = null; }
    }
    result = decide({ previous, current, changed });
  } catch {
    result = { build: true, reason: 'git is not available here' };
  }
  log(`vercel-ignore-build: ${result.build ? 'build' : 'skip'} (${result.reason})`);
  return result.build ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(run());
