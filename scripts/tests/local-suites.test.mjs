/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// MAINT-P1 guards: every database suite is either run by run-local-suites.mjs or excluded with a reason, the
// exclusion list and the volatility allow-list may only shrink, and the CI integration job uses the one entry point.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { NOT_A_SUITE, discoverSuites, loadExcluded } from '../../packages/db/tests/run-local-suites.mjs';
import { loadDurations, suitesForShard } from '../../packages/db/tests/shard-assign.mjs';
import { judgeVolatility, loadAllow } from '../../packages/db/tests/baseline/volatility-check.mjs';

const root = resolve(import.meta.dirname, '../..');
// Ratchets: lowering these is the point of the work; raising them needs a reviewed reason.
const MAX_EXCLUDED_SUITES = 52;
const MAX_VOLATILITY_ALLOWED = 0;
// erasure-run and bill-unit left with the old runs and BILL2 path (V2-12); their turn-path counterparts are turn-erasure and turn-core.
const REQUIRED_IN_CI = ['pay-dispute', 'pay-waffo', 'pay-waffo-delivery', 'monthly-refund', 'package-refund',
  'erasure-completion', 'credit-sources', 'publish-monitor', 'report-revision',
  'stripe-upgrade-overlap', 'paywall-profile-archive'];

test('excluded suites exist, carry a reason and a date, and never exceed the ratchet', () => {
  const { suites } = loadExcluded();
  const found = new Set(discoverSuites());
  for (const [suite, reason] of Object.entries(suites)) {
    assert.ok(found.has(suite), `${suite} is excluded but no such suite exists (remove the entry)`);
    assert.match(reason, /\b2026-\d\d-\d\d\b/, `${suite}: the reason needs a date`);
    assert.ok(reason.length > 40, `${suite}: write a real reason`);
  }
  assert.ok(Object.keys(suites).length <= MAX_EXCLUDED_SUITES,
    `local-suites-excluded.json grew past ${MAX_EXCLUDED_SUITES}: fix the suite instead of excluding it`);
});

test('the first batch of suites is not excluded', () => {
  const { suites } = loadExcluded();
  for (const dir of REQUIRED_IN_CI) {
    assert.ok(discoverSuites().some(suite => suite.startsWith(`${dir}/`)), `${dir} has no suite`);
    assert.ok(!Object.keys(suites).some(suite => suite.startsWith(`${dir}/`)), `${dir} must run in CI`);
  }
});

test('every discovered suite accepts the flag the runner passes (--ci) or is excluded', () => {
  const { suites } = loadExcluded();
  for (const suite of discoverSuites().filter(item => !(item in suites))) {
    const text = readFileSync(resolve(root, 'packages/db/tests', suite), 'utf8');
    const own = /--ci/.test(text) || /localDb\(/.test(text) || /from '\.\.\/runtime-view-perf\/local-db\.mjs'/.test(text);
    // publish-monitor *-local files get --ci through localDb(); the others carry their own guard.
    assert.ok(own, `${suite} neither mentions --ci nor uses localDb(): add the guard or exclude it with a reason`);
  }
});

test('the volatility allow-list only shrinks and every entry has a reason', () => {
  const allow = loadAllow(root);
  assert.ok(Object.keys(allow.functions).length <= MAX_VOLATILITY_ALLOWED);
  for (const [name, why] of Object.entries(allow.functions)) assert.ok(why.length > 20, `${name}: write a reason`);
});

test('judgeVolatility flags unlisted writers and stale allow-list entries', () => {
  const rows = ['public.f(a uuid) [STABLE] for update', 'public.g() [IMMUTABLE] insert into'];
  const verdict = judgeVolatility(rows, { functions: { 'public.g()': 'x', 'public.gone()': 'y' } });
  assert.equal(verdict.length, 2);
  assert.match(verdict[0], /public\.f\(a uuid\)/);
  assert.match(verdict[1], /public\.gone\(\)/);
});

test('ci.yml runs the unified entry and no individual run-local suite step', () => {
  const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /run-local-suites\.mjs --ci/);
  assert.ok(!/run: node packages\/db\/tests\/(?!run-local-suites)[\w-]+\/run-local\.mjs --ci/.test(ci),
    'single run-local steps belong in run-local-suites.mjs');
  assert.ok(existsSync(resolve(root, 'packages/db/tests/local-suites-excluded.json')));
});

// Owner 2026-11-01: the excluded suites run nightly (.github/workflows/nightly-db-suites.yml); entries that are not tests are skipped there.
test('"not a suite:" entries are real files that run no test, and the nightly list is every other excluded suite', () => {
  const { suites } = loadExcluded();
  const notSuites = Object.keys(suites).filter(suite => NOT_A_SUITE.test(suites[suite]));
  assert.ok(notSuites.length > 0);
  for (const suite of notSuites) assert.ok(existsSync(resolve(root, 'packages/db/tests', suite)), `${suite} does not exist (remove the entry)`);
  const nightly = Object.keys(suites).filter(suite => !NOT_A_SUITE.test(suites[suite]));
  assert.equal(nightly.length + notSuites.length, Object.keys(suites).length);
  assert.ok(nightly.every(suite => !/(^|\/)local-db\.mjs$|local-rate-limit(-cases|-case-report|-images|-test-setup)?\.mjs$/.test(suite)));
});

test('shards are disjoint, together cover every suite, and are balanced by measured duration', () => {
  const durations = loadDurations();
  const found = new Set(discoverSuites());
  for (const suite of Object.keys(durations.seconds)) assert.ok(found.has(suite), `${suite} is in suite-durations.json but no such suite exists`);
  const { suites: excluded } = loadExcluded();
  const lists = [discoverSuites().filter(suite => !(suite in excluded)), discoverSuites().filter(suite => suite in excluded), ['a/x-local.mjs', 'b/y-local.mjs', 'c/z-local.mjs']];
  for (const list of lists) {
    for (const shards of [1, 2, 3, 4, 7]) {
      const parts = Array.from({ length: shards }, (_, index) => suitesForShard(list, index + 1, shards, durations));
      assert.deepEqual(parts.flat().sort(), [...list].sort(), `${shards} shards must hold every suite exactly once`);
      assert.equal(parts.flat().length, new Set(parts.flat()).size, 'shards must be disjoint');
      assert.deepEqual(parts.map((_, index) => suitesForShard(list, index + 1, shards, durations)), parts, 'the split must be deterministic');
    }
  }
  // The slowest of four shards may not exceed the longest single suite plus an even share of the rest (greedy bound).
  const weight = suite => durations.seconds[suite] ?? durations.defaultSeconds;
  const ci = lists[0];
  const total = ci.reduce((sum, suite) => sum + weight(suite), 0);
  const slowest = Math.max(...[1, 2, 3, 4].map(k => suitesForShard(ci, k, 4, durations).reduce((sum, suite) => sum + weight(suite), 0)));
  assert.ok(slowest <= total / 4 + Math.max(...ci.map(weight)), `slowest shard ${slowest}s is not balanced (total ${total}s)`);
});

test('the Waffo delivery and PAY-FAILOVER checks stay split into parallel suites without losing any step (Owner 2026-11-03)', () => {
  const found = new Set(discoverSuites());
  for (const suite of ['pay-waffo-delivery/run-local.mjs', 'pay-waffo-delivery/structure-local.mjs', 'pay-failover/run-local.mjs']) {
    assert.ok(found.has(suite) && !(suite in loadExcluded().suites), `${suite} must be a discovered suite that runs in CI`);
  }
  const read = path => readFileSync(resolve(root, path), 'utf8');
  const delivery = read('packages/db/tests/pay-waffo-delivery/run-local.mjs');
  // The apply-twice and fingerprint check is handed to the structure half, never dropped: it is switched on only by --structure-only.
  assert.match(delivery, /fingerprint: structureOnly && !process\.argv\.includes\('--quick'\) \? fingerprint : undefined/);
  assert.match(read('packages/db/tests/pay-waffo-delivery/structure-local.mjs'), /process\.argv\.push\('--structure-only'\)/);
  // The 0221-onward repeat check over Waffo data stays in the behaviour half, unchanged.
  assert.match(delivery, /repeat over Waffo data preserves structure/);
  assert.ok(!read('packages/db/tests/pay-waffo/run-local.mjs').includes('pay-failover/run-local.mjs"') && !/spawnSync\(process\.execPath/.test(read('packages/db/tests/pay-waffo/run-local.mjs')),
    'pay-waffo no longer runs PAY-FAILOVER as a child: it is its own suite');
});
