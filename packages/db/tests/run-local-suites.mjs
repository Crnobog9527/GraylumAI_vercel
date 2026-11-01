/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// MAINT-P1 (audit A1): one entry point for the database suites that start their own disposable
// PostgreSQL container (packages/db/tests/<dir>/*run-local*.mjs). Every suite found is run, one after
// another, unless it is listed in local-suites-excluded.json (reason + date; the list may only shrink,
// see scripts/tests/local-suites.test.mjs). A new suite is therefore in CI the day it is added.
// Usage: node packages/db/tests/run-local-suites.mjs --ci | --local-only [--list] [--only <dir[,dir]>] [--jobs N] [--shard K/N]
// Each suite is started with the same flag (--ci / --local-only) and must accept it. --shard K/N keeps every
// N-th suite starting at the K-th, so CI can spread the suites over N parallel jobs (each runs its own share).
// Database build snapshot (Owner 2026-11-01): when two or more of the chosen suites start their database through localDb()
// (runtime-view-perf/local-db.mjs), the repository files are replayed into one database once, the container is stopped cleanly and
// committed as a local image, and each of those suites starts its own fresh container from that image. A suite that needs the real
// build chain (credit-sources seeds data in the middle of it) or does its own build still replays the files itself.
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const testsDir = import.meta.dirname;
const root = resolve(testsDir, '../../..');
const SUITE_FILE = /(^|-)local(-[^.]*)?\.mjs$/;

// "<dir>/<file>" for every suite file one level below packages/db/tests.
export function discoverSuites(dir = testsDir) {
  return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .flatMap(entry => readdirSync(resolve(dir, entry.name)).filter(file => SUITE_FILE.test(file))
      .map(file => `${entry.name}/${file}`))
    .sort();
}

// True when the suite file starts its database through localDb().
export const usesLocalDb = (suite, dir = testsDir) => /\blocalDb\(/.test(readFileSync(resolve(dir, suite), 'utf8'));

export const loadExcluded = (dir = testsDir) =>
  JSON.parse(readFileSync(resolve(dir, 'local-suites-excluded.json'), 'utf8'));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const mode = args[0];
  const ci = mode === '--ci';
  if (!(ci ? process.env.CI : mode === '--local-only' && !process.env.CI)) {
    throw new Error('Usage: run-local-suites.mjs --ci (CI only) | --local-only (not in CI) [--list] [--only <dir[,dir]>]');
  }
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
  const excluded = loadExcluded().suites;
  const [shard, shards] = args.includes('--shard') ? args[args.indexOf('--shard') + 1].split('/').map(Number) : [1, 1];
  if (!(shards >= 1 && shard >= 1 && shard <= shards)) throw new Error('--shard must be K/N with 1 <= K <= N');
  const suites = discoverSuites().filter(suite => !(suite in excluded)
    && (!only || only.includes(suite.split('/')[0]) || only.includes(suite)))
    .filter((_, index) => index % shards === shard - 1);
  if (args.includes('--list')) {
    console.log(suites.join('\n'));
  } else {
    // Each suite owns a disposable container with a random name and an ephemeral port, so a few can run at
    // once; output is buffered per suite and printed when it ends. --jobs N (default 4, the CI runner's CPU count) bounds the load.
    const jobs = Number(args.includes('--jobs') ? args[args.indexOf('--jobs') + 1] : 4);
    const results = [];
    const sharing = suites.filter(suite => usesLocalDb(suite));
    let snapshot = null;
    if (sharing.length >= 2) {
      const started = Date.now();
      try {
        const { buildSnapshot } = await import('./runtime-view-perf/local-db.mjs');
        snapshot = await buildSnapshot();
        console.log(`database snapshot built once in ${Math.round((Date.now() - started) / 1000)}s for ${sharing.length} suites`);
      } catch (error) {
        console.log(`::warning::database snapshot failed, each suite builds its own: ${String(error.message).slice(0, 500)}`);
      }
    }
    const suiteEnv = snapshot ? { ...process.env, GRAYLUM_DB_SNAPSHOT_IMAGE: snapshot.image, GRAYLUM_DB_SNAPSHOT_BUILD: JSON.stringify(snapshot.build) } : process.env;
    const removeSnapshot = () => { snapshot?.remove(); snapshot = null; };
    process.on('SIGINT', () => { removeSnapshot(); process.exit(130); });
    process.on('SIGTERM', () => { removeSnapshot(); process.exit(143); });
    const queue = [...suites];
    const worker = async () => {
      for (let suite = queue.shift(); suite; suite = queue.shift()) {
        const started = Date.now();
        const run = await new Promise(done => {
          const child = spawn(process.execPath, [resolve(testsDir, suite), mode], { cwd: root, env: suiteEnv, timeout: 20 * 60 * 1000 });
          let out = '';
          child.stdout.on('data', chunk => { out += chunk; });
          child.stderr.on('data', chunk => { out += chunk; });
          child.on('error', error => done({ status: 1, error, out }));
          child.on('close', status => done({ status, out }));
        });
        const seconds = Math.round((Date.now() - started) / 1000);
        const passed = run.status === 0 && !run.error;
        results.push({ suite, seconds, passed });
        console.log(`::group::${suite}\n${run.out.slice(-60000)}\n::endgroup::\n${passed ? 'PASS' : 'FAIL'} ${suite} (${seconds}s)${run.error ? ` ${run.error.message}` : ''}`);
      }
    };
    const wall = Date.now();
    try {
      await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, suites.length)) }, worker));
    } finally {
      removeSnapshot();
    }
    console.log(`wall clock ${Math.round((Date.now() - wall) / 1000)}s with ${jobs} at a time`);
    console.log(`\n${'suite'.padEnd(50)} result  seconds`);
    for (const { suite, seconds, passed } of results.sort((x, y) => x.suite.localeCompare(y.suite))) console.log(`${suite.padEnd(50)} ${passed ? 'PASS  ' : 'FAIL  '}  ${seconds}`);
    console.log(`total ${results.reduce((sum, item) => sum + item.seconds, 0)}s over ${results.length} suites`);
    if (results.some(item => !item.passed)) process.exitCode = 1;
  }
}
