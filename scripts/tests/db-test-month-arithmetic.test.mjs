/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { addUtcMonths, latestMonthEnd } from '../../packages/db/tests/utc-months.mjs';

const iso = (date, months) => addUtcMonths(new Date(`${date}T12:34:56.000Z`), months).toISOString().slice(0, 10);

test('months clamp to the end of the target month, as Postgres and Stripe do', () => {
  assert.equal(iso('2026-10-31', 1), '2026-11-30');
  assert.equal(iso('2026-10-31', -1), '2026-09-30');
  assert.equal(iso('2026-01-31', 1), '2026-02-28');
  assert.equal(iso('2028-01-31', 1), '2028-02-29');
  assert.equal(iso('2026-12-15', 1), '2027-01-15');
  assert.equal(iso('2026-03-31', 12), '2027-03-31');
});

test('the time of day and the input survive', () => {
  const from = new Date('2026-10-31T12:34:56.789Z');
  assert.equal(addUtcMonths(from, 1).toISOString(), '2026-11-30T12:34:56.789Z');
  assert.equal(from.toISOString(), '2026-10-31T12:34:56.789Z');
});

test('a term end is one a month before it can reach', () => {
  for (const at of ['2026-10-31T02:00:00.000Z', '2026-10-30T02:00:00.000Z', '2026-12-31T23:00:00.000Z', '2027-03-30T05:00:00.000Z']) {
    const end = latestMonthEnd(new Date(at));
    assert.equal(addUtcMonths(addUtcMonths(end, -1), 1).toISOString(), end.toISOString());
    assert.ok(end <= new Date(at));
  }
  assert.equal(latestMonthEnd(new Date('2026-10-31T02:00:00.000Z')).toISOString(), '2026-10-30T23:59:59.000Z');
  assert.equal(latestMonthEnd(new Date('2026-10-30T02:00:00.000Z')).toISOString(), '2026-10-30T02:00:00.000Z');
});

// These suites broke every pull request on 2026-10-31: setUTCMonth turned Oct 31 + 1 month into Dec 1.
test('database tests do not do month arithmetic with setUTCMonth', () => {
  const out = execFileSync('git', ['grep', '-n', 'setUTCMonth(', '--', 'packages/db/tests'], { encoding: 'utf8' }).trim();
  const hits = out.split('\n').filter((line) => !line.startsWith('packages/db/tests/utc-months.mjs:'));
  assert.deepEqual(hits, []);
});
