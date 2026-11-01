/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { coreSecondsPerTurn, kStable, waitsFlat, capacityTable, magnitude, SIZES } from '../loadtest/lib/extrapolate.mjs';

test('k is core-seconds per completed turn', () => {
  assert.equal(coreSecondsPerTurn({ cpuSeconds: 30, turns: 120 }), 0.25);
  assert.equal(coreSecondsPerTurn({ cpuSeconds: 30, turns: 0 }), null);
});

test('k is stable when every level is within 15% of the mean, and unknown with one level', () => {
  assert.deepEqual(kStable([{ k: 0.25 }, { k: 0.26 }, { k: 0.24 }]).stable, true);
  const moving = kStable([{ k: 0.2 }, { k: 0.25 }, { k: 0.4 }]);
  assert.equal(moving.stable, false);
  assert.equal(kStable([{ k: 0.2 }]).stable, null);
});

test('lock waits are flat when each level is under 2% and the share does not climb with users', () => {
  assert.equal(waitsFlat([{ waitPercent: 0.2 }, { waitPercent: 0.4 }, { waitPercent: 0.5 }]).flat, true);
  assert.equal(waitsFlat([{ waitPercent: 0.2 }, { waitPercent: 2.5 }]).flat, false);
  assert.equal(waitsFlat([{ waitPercent: 0.1 }]).flat, null);
});

test('capacity follows plan 3.3.1: 0.25 core-seconds a turn gives about 290 turns a minute on 2 cores at 60%', () => {
  const rows = capacityTable(0.25);
  assert.equal(rows.length, SIZES.length);
  assert.equal(rows[0].turnsPerMinute, 288);
  assert.equal(rows[0].loadRhythmUsers, 310);
  assert.equal(rows[0].humanRhythmUsers, 960);
  assert.equal(rows[3].turnsPerMinute, 576);
});

test('quoted capacity is an order of magnitude on a half-decade scale', () => {
  assert.deepEqual([magnitude(288), magnitude(960), magnitude(3500), magnitude(0)], [300, 1000, 3000, 0]);
});

test('the report states whether k holds, with the failures and the uncertainties written out', async () => {
  const { report } = await import('../loadtest/extrapolate.mjs');
  const level = (users, k, lock = 0.1, failed = 0) => ({ users, rhythm: 'load', k, turns: users * 4, turnsPerUserMinute: 0.9, statementMsPerTurn: 8, walBytesPerTurn: 12000,
    rowsWrittenPerTurn: 20, failed, cpus: '2', memory: '1g', sharedBuffers: '256MB', pool: 16, waits: { lockManagerPercent: lock, tuplePercent: 0 } });
  const good = report([level(5000, 0.0105), level(500, 0.01), level(2000, 0.0102)]);
  assert.match(good, /spread \d+\.\d% of the mean \(limit 15%\) -> holds/);
  assert.match(good, /flat and under 2%/);
  assert.match(good, /Shared-core burst credit/);
  assert.match(report([level(500, 0.01), level(5000, 0.02)]), /DOES NOT HOLD/);
  assert.match(report([level(500, 0.01), level(5000, 0.01, 3)]), /NOT FLAT/);
  assert.match(report([level(500, 0.01, 0.1, 2), level(5000, 0.01)]), /turns failed/);
  assert.match(report([level(500, 0.01)]), /at least two levels/);
});

test('a level with no completed turn is reported, not fatal, and is left out of the arithmetic', async () => {
  const { report } = await import('../loadtest/extrapolate.mjs');
  const level = (users, k, turns, failed) => ({ users, rhythm: 'load', k, turns, turnsPerUserMinute: 0.9, statementMsPerTurn: 8, walBytesPerTurn: 1,
    rowsWrittenPerTurn: 1, failed, cpus: '2', memory: '1g', sharedBuffers: '1GB', pool: 16, waits: { lockManagerPercent: 0, tuplePercent: 0 } });
  const text = report([level(500, 0.01, 100, 0), level(2000, 0.01, 400, 0), level(5000, null, 0, 900)]);
  assert.match(text, /5000 users: 900 failed, no completed turn/);
  assert.match(text, /\| 5000 \| 0 \| 0\.9 \| n\/a \|/);
  assert.match(text, /holds/);
  const few = report([level(500, 0.01, 100, 0), level(5000, null, 0, 900)]);
  assert.match(few, /5000 users: 900 failed/);
});

test('a level without wait samples makes the lock-wait question undecidable', () => {
  assert.equal(waitsFlat([{ waitPercent: 0.1 }, { waitPercent: null }, { waitPercent: 0.2 }]).flat, null);
});
