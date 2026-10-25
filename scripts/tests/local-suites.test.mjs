/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// MAINT-P1 guards: every database suite is either run by run-local-suites.mjs or excluded with a reason, the
// exclusion list and the volatility allow-list may only shrink, and the CI integration job uses the one entry point.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { discoverSuites, loadExcluded } from '../../packages/db/tests/run-local-suites.mjs';
import { judgeVolatility, loadAllow } from '../../packages/db/tests/baseline/volatility-check.mjs';

const root = resolve(import.meta.dirname, '../..');
// Ratchets: lowering these is the point of the work; raising them needs a reviewed reason.
const MAX_EXCLUDED_SUITES = 88;
const MAX_VOLATILITY_ALLOWED = 0;
const REQUIRED_IN_CI = ['pay-dispute', 'pay-waffo', 'pay-waffo-delivery', 'monthly-refund', 'package-refund',
  'erasure-run', 'erasure-completion', 'publish-monitor', 'report-revision', 'stripe-upgrade-overlap', 'paywall-profile-archive'];

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
