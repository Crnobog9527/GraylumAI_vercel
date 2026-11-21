import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditSql, parseSnapshot, render, summarize, TARGET_PHASES } from '../prompt-cache-audit.mjs';

const snapshot = JSON.stringify([
  { model: 'anthropic/claude-sonnet-5.5', phase: 'skill', loadtest: true, calls: 1888, input_tokens: 14712132,
    cached_tokens: 0, cache_write_tokens: 0, cost_usd: '35.88', calls_without_cache: 1888 },
  { model: 'anthropic/claude-sonnet-5.5', phase: 'skill', loadtest: false, calls: 126, input_tokens: 3425748,
    cached_tokens: 1579592, cache_write_tokens: 1147424, cost_usd: '4.86', calls_without_cache: 0 },
  { model: 'anthropic/claude-sonnet-5.5', phase: 'ordinary', loadtest: 'f', calls: 82, input_tokens: 593001,
    cached_tokens: 0, cache_write_tokens: 0, cost_usd: '1.62', calls_without_cache: 82 },
  { model: 'openai/gpt-6-luna', phase: 'attached_organizer', loadtest: false, calls: 87, input_tokens: 344247,
    cached_tokens: 109810, cache_write_tokens: 234176, cost_usd: '0.05', calls_without_cache: 0 },
]);

test('the query excludes nothing itself but flags load-test receipts and only counts final receipts with usage', () => {
  const sql = auditSql(3);
  assert.match(sql, /gen-load-%/);
  assert.match(sql, /'final' = 'true'/);
  assert.match(sql, /interval '3 days'/);
  assert.match(auditSql('oops'), /interval '3 days'/);
  assert.match(auditSql(7), /interval '7 days'/);
});

test('load-test rows are excluded from every share and reported separately', () => {
  const summary = summarize(parseSnapshot(snapshot));
  assert.equal(summary.lines.length, 3);
  assert.equal(summary.excluded.calls, 1888);
  assert.ok(Math.abs(summary.excluded.costUsd - 35.88) < 1e-9);
  const skill = summary.lines.find((line) => line.phase === 'skill');
  assert.ok(Math.abs(skill.readShare - 1579592 / 3425748) < 1e-12);
  assert.ok(Math.abs(skill.writeShare - 1147424 / 3425748) < 1e-12);
  assert.ok(Math.abs(skill.fullPriceShare - (3425748 - 1579592 - 1147424) / 3425748) < 1e-12);
});

test('the verdict compares each target phase of Anthropic models with the 50% read target', () => {
  const summary = summarize(parseSnapshot(snapshot));
  assert.deepEqual(summary.verdicts.map((verdict) => [verdict.phase, verdict.pass]), [['skill', false], ['ordinary', false]]);
  assert.deepEqual(TARGET_PHASES, ['skill', 'ordinary']);
  const better = summarize(parseSnapshot(snapshot).map((row) =>
    row.phase === 'skill' && !row.loadtest ? { ...row, cachedTokens: 2600000, cacheWriteTokens: 300000 } : row));
  assert.equal(better.verdicts[0].pass, true);
  assert.equal(better.verdicts[1].pass, false);
  const text = render(better);
  assert.match(text, /skill（Anthropic，126 次）：缓存读占输入 75\.9%，目标 ≥ 50\.0%：达标/);
  assert.match(text, /已排除压测桩合成回执：1888 次/);
});

test('accepts the CLI output wrapped in log lines', () => {
  const rows = parseSnapshot('Using workdir /tmp\n' + snapshot + '\nA new version is available');
  assert.equal(rows.length, 4);
  assert.equal(rows[0].loadtest, true);
  assert.equal(rows[2].loadtest, false);
});
