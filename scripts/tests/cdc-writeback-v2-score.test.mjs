/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { objectiveChecks, aggregate, runStatistics } from '../cdc-writeback-v2/score.mjs';
const state = (value, suggestion) => ({ information: { 'step-1': { schema: [{ id: 'goal' }], values: { goal: { value } },
  meta: { goal: { suggestion: suggestion ? { value: suggestion } : undefined } } } },
  snapshot: { steps: { 'step-1': { fieldMeta: { goal: { suggestion: suggestion ? { value: suggestion } : undefined } } } } } });
const field = { stepId: 'step-1', fieldId: 'goal', target: 'value', required: [], forbidden: [] };

test('atoms are field-specific and normalization does not treat suggestions as formal values', () => {
  const gold = { gold: [{ ...field, required: [{ id: 'a', meaning: '示例限定', anyOf: ['Ａ B'] }] }], forbiddenEverywhere: [] };
  assert.equal(objectiveChecks(gold, state(''), state('a b'))[0].pass, true);
  assert.equal(objectiveChecks(gold, state(''), state('', 'a b'))[0].pass, false);
});
test('withdrawal and global contamination include pending suggestions', () => {
  const gold = { gold: [{ ...field, target: 'suggestion', absent: true }], forbiddenEverywhere: ['调试占位'] };
  assert.deepEqual(objectiveChecks(gold, state('', '旧建议'), state('', '调试占位')).map(c => c.pass), [false, false]);
  assert.deepEqual(objectiveChecks(gold, state('', '旧建议'), state('')).map(c => c.pass), [true, true]);
});
test('requests cannot silently become user facts or suggestions', () => {
  const gold = { gold: [], forbiddenEverywhere: [], expectNoUserFactChange: true };
  assert.deepEqual(objectiveChecks(gold, state(''), state('', '新增猜测')).map(c => c.pass), [true, false]);
});
test('whole-sample and point statistics stay separate', () => {
  assert.deepEqual(aggregate([{ correct: false, protectedDirectChanged: false, formatError: false,
    checks: [{ pass: true }, { pass: false }] }]), { count: 1, correct: 0, accuracy: 0,
    protectedDirectChanged: 0, formatErrors: 0, points: 2, pointsPassed: 1 });
});
const rows = (run, count, correct) => Array.from({ length: count }, (_, i) => ({
  run, correct: i < correct, checks: [], formatError: false, protectedDirectChanged: false,
}));
test('terminal partial batch never produces a three-run mean or variance', () => {
  const stats = runStatistics([...rows(1, 100, 80), ...rows(2, 42, 40)]);
  assert.deepEqual(stats.runs.map(r => [r.count, r.correct, r.complete]), [[100, 80, true], [42, 40, false], [0, null, false]]);
  for (const key of ['meanCorrect', 'minCorrect', 'maxCorrect', 'sampleSdCorrect']) assert.equal(stats[key], null);
});
test('three complete runs report sample standard deviation and equal-run mean', () => {
  const stats = runStatistics([...rows(1, 100, 80), ...rows(2, 100, 82), ...rows(3, 100, 84)]);
  assert.equal(stats.meanCorrect, 82);
  assert.equal(stats.sampleSdCorrect, 2);
  assert.equal(stats.minCorrect, 80);
  assert.equal(stats.maxCorrect, 84);
});
