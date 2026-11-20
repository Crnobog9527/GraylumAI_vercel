/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blocksLaterConfiguration, releaseSuitePlan, suiteState } from '../e2e-sim/release-results.mjs';
test('failed, skipped, unrun and passed suites remain distinct', () => {
  assert.equal(suiteState(1, undefined), 'failed');
  assert.equal(suiteState(0, undefined), 'not-run');
  assert.equal(suiteState(0, { expected: 1 }), 'failed');
  assert.equal(suiteState(1, { expected: 0, unexpected: 1, skipped: 0 }), 'failed');
  assert.equal(suiteState(0, { expected: 0, unexpected: 0, skipped: 2 }), 'skipped');
  assert.equal(suiteState(0, { expected: 0, unexpected: 0, skipped: 0 }), 'not-run');
  assert.equal(suiteState(0, { expected: 2, unexpected: 0, skipped: 0 }), 'passed');
});
test('settings suite runs last and destructive failures prevent it from running on contaminated state', () => {
  for (const operationsOnly of [false, true]) {
    const suites = releaseSuitePlan({ operationsOnly, destructive: true });
    assert.deepEqual(suites.slice(-2), ['admin-destructive', 'admin-config']);
    if (!operationsOnly) assert.ok(suites.includes('home-routing'));
  }
  assert.equal(blocksLaterConfiguration('admin-destructive', 'failed'), true);
  assert.equal(blocksLaterConfiguration('admin-destructive', 'skipped'), true);
  assert.equal(blocksLaterConfiguration('admin-destructive', 'passed'), false);
  assert.equal(blocksLaterConfiguration('security', 'failed'), false);
});
test('conflicting targeted modes are refused before starting a stack', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['scripts/e2e-sim/run.mjs', '--release-preflight', '--only-ui', '--production-operations'],
    { cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /incompatible release options/);
  const cases = spawnSync(process.execPath, ['scripts/e2e-sim/run.mjs', '--release-preflight', '--production-suite=security', '--production-case=purchase-intent'],
    { cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.notEqual(cases.status, 0); assert.match(cases.stderr, /incompatible release options/);
  const unknown = spawnSync(process.execPath, ['scripts/e2e-sim/run.mjs', '--release-preflight', '--production-case=other'],
    { cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.notEqual(unknown.status, 0); assert.match(unknown.stderr, /unknown diagnostic case/);
});
