/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// MAINT-P1 (audit A1): one entry point for the database suites that start their own disposable
// PostgreSQL container (packages/db/tests/<dir>/*run-local*.mjs). Every suite found is run, one after
// another, unless it is listed in local-suites-excluded.json (reason + date; the list may only shrink,
// see scripts/tests/local-suites.test.mjs). A new suite is therefore in CI the day it is added.
// Usage: node packages/db/tests/run-local-suites.mjs --ci | --local-only [--list] [--only <dir[,dir]>]
// Each suite is started with the same flag (--ci / --local-only) and must accept it.
import { spawnSync } from 'node:child_process';
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

export const loadExcluded = (dir = testsDir) =>
  JSON.parse(readFileSync(resolve(dir, 'local-suites-excluded.json'), 'utf8'));

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const mode = args[0];
  const ci = mode === '--ci';
  if (!(ci ? process.env.CI : mode === '--local-only' && !process.env.CI)) {
    throw new Error('Usage: run-local-suites.mjs --ci (CI only) | --local-only (not in CI) [--list] [--only <dir[,dir]>]');
  }
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
  const excluded = loadExcluded().suites;
  const suites = discoverSuites().filter(suite => !(suite in excluded)
    && (!only || only.includes(suite.split('/')[0]) || only.includes(suite)));
  if (args.includes('--list')) {
    console.log(suites.join('\n'));
  } else {
    const results = [];
    for (const suite of suites) {
      console.log(`::group::${suite}`);
      const started = Date.now();
      const run = spawnSync(process.execPath, [resolve(testsDir, suite), mode], {
        cwd: root, stdio: 'inherit', timeout: 20 * 60 * 1000,
      });
      const seconds = Math.round((Date.now() - started) / 1000);
      const passed = run.status === 0 && !run.error;
      results.push({ suite, seconds, passed });
      console.log(`::endgroup::\n${passed ? 'PASS' : 'FAIL'} ${suite} (${seconds}s)${run.error ? ` ${run.error.message}` : ''}`);
    }
    console.log(`\n${'suite'.padEnd(50)} result  seconds`);
    for (const { suite, seconds, passed } of results) console.log(`${suite.padEnd(50)} ${passed ? 'PASS  ' : 'FAIL  '}  ${seconds}`);
    console.log(`total ${results.reduce((sum, item) => sum + item.seconds, 0)}s over ${results.length} suites`);
    if (results.some(item => !item.passed)) process.exitCode = 1;
  }
}
