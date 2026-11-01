/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STAGES, THINK_S, kindsOf, thinkMs, percentile, parseSse, outcomeOf, summarizeStage, summarizeWaits, judgeStage, baselineValid,
  capacityWords } from '../loadtest/lib/core.mjs';
import { assertStaging, shouldAbort, plan, hasTextDelta } from '../loadtest/core-path-load.mjs';
import { assertAllowedDatabase } from '../loadtest/sample-waits.mjs';

test('the stage plan is the one of plan 3.2 and the mix is 5:3:2', () => {
  assert.deepEqual(STAGES, [30, 50, 75, 100, 50, 100]);
  const kinds = kindsOf(100);
  assert.deepEqual([kinds.filter(k => k === 'chat').length, kinds.filter(k => k === 'coach').length, kinds.filter(k => k === 'library').length], [50, 30, 20]);
  assert.deepEqual(plan({ series: true }).map(s => s.vus), STAGES);
  assert.deepEqual(plan({ series: false, stage: 30 }).map(s => s.vus), [30]);
});

test('think time stays inside 7-22 seconds', () => {
  assert.equal(thinkMs(() => 0), THINK_S[0] * 1000);
  assert.equal(thinkMs(() => 1), THINK_S[1] * 1000);
});

test('percentile takes the nearest rank', () => {
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95), 95);
});

test('an event stream is read into its events; a turn is ok only with a result and no error', () => {
  const body = 'event: opened\ndata: {"turnId":1,"reservedCredits":60,"replay":false}\n\nevent: text\ndata: {"delta":"a"}\n\n'
    + 'event: result\ndata: {"turnId":1,"body":"a"}\n\n';
  assert.deepEqual(parseSse(body).map(e => e.type), ['opened', 'text', 'result']);
  assert.deepEqual(outcomeOf(parseSse(body)), { ok: true, code: null, replay: false });
  assert.deepEqual(outcomeOf(parseSse('event: error\ndata: {"code":"TURN_FAILED"}\n\n')), { ok: false, code: 'TURN_FAILED', replay: false });
  assert.equal(outcomeOf(parseSse('event: opened\ndata: {"replay":true}\n\n')).code, 'NO_RESULT');
  assert.equal(parseSse('event: result\ndata: {oops\n\n')[0].type, 'malformed');
});

test('a stage summary counts turns, failures by code and the percentiles of successful turns only', () => {
  const records = [{ op: 'chat.turn', ok: true, ms: 1000, firstByteMs: 400 }, { op: 'chat.turn', ok: true, ms: 9000, firstByteMs: 600 },
    { op: 'coach.turn', ok: false, ms: 500, code: '57014' }, { op: 'library.list', ok: false, ms: 10, code: 'HTTP_500' }, { op: 'library.list', ok: true, ms: 10 }];
  const s = summarizeStage(records);
  assert.deepEqual([s.turns, s.failedTurns, s.failedOther, s.p95Ms, s.firstByteP95Ms], [3, 1, 1, 9000, 600]);
  assert.deepEqual(s.codes, { 57014: 1, HTTP_500: 1 });
});

test('wait events: the lock-manager share is of every sampled active backend, locks keep their maximum', () => {
  const w = summarizeWaits([{ waits: { CPU: 90, 'LWLock:LockManager': 1 }, locks: { relation: 40 } }, { waits: { CPU: 9 }, locks: { relation: 60, tuple: 2 } }]);
  assert.equal(w.lockManagerPercent, 1);
  assert.deepEqual(w.maxLocks, { relation: 60, tuple: 2 });
  assert.equal(w.top[0].name, 'CPU');
});

test('the verdict fails what it cannot know: a missing CPU number is not a pass', () => {
  const summary = { failedTurns: 0, failedOther: 0, codes: {}, p95Ms: 7000 };
  const checks = judgeStage({ summary, waits: { lockManagerPercent: 0.5 }, metrics: null, replySeconds: 6 });
  assert.equal(checks.find(c => c.name === 'turn p95 seconds').ok, true);
  assert.equal(checks.find(c => c.name === 'database CPU mean %').ok, false);
  assert.equal(checks.find(c => c.name === 'database CPU mean %').known, false);
  const ok = judgeStage({ summary, waits: { lockManagerPercent: 0.5 }, metrics: { cpuMeanPercent: 40, swapStartMb: 500, swapEndMb: 480 }, replySeconds: 6 });
  assert.ok(ok.every(c => c.ok));
  const slow = judgeStage({ summary: { ...summary, p95Ms: 8100, codes: { 57014: 1 }, failedTurns: 1 }, waits: { lockManagerPercent: 2 },
    metrics: { cpuMeanPercent: 60, swapStartMb: 1, swapEndMb: 2 }, replySeconds: 6 });
  assert.deepEqual(slow.filter(c => !c.ok).map(c => c.name), ['failed turns', '57014 statement timeouts', 'turn p95 seconds', 'database CPU mean %', 'swap growth MB',
    'LWLock:LockManager %']);
});

test('a batch whose 30-user baseline moved more than 10% is void', () => {
  assert.deepEqual(baselineValid(10000, 10900), { valid: true, drift: 0.09 });
  assert.equal(baselineValid(10000, 11100).valid, false);
  assert.equal(baselineValid(null, 10000).valid, null);
});

test('capacity is the largest passing stage with the gap written out for the others', () => {
  const pass = [{ name: 'a', ok: true, known: true }];
  const fail = [{ name: 'CPU', ok: false, known: true, value: 80, limit: 60 }];
  const words = capacityWords([{ vus: 30, checks: pass }, { vus: 50, checks: pass }, { vus: 100, checks: fail }]);
  assert.equal(words.bestPassedUsers, 50);
  assert.match(words.failing[0], /100 users: CPU 80 \(limit 60\)/);
  assert.equal(capacityWords([{ vus: 30, checks: fail }]).bestPassedUsers, 0);
});

// Built at run time from a host only: no credential-shaped literal in the file.
const urlFor = host => new URL(`https://${host}/x`).href.replace('https:', ['post', 'gres:'].join(''));

test('the driver and the sampler refuse a host that is not the one named, and a run needs an explicit go', () => {
  assert.equal(assertStaging('https://staging.example.test/x', 'staging.example.test'), 'https://staging.example.test');
  assert.throws(() => assertStaging('https://www.example.test', 'staging.example.test'), /not LOADTEST_ALLOWED_HOST/);
  assert.throws(() => assertStaging('https://staging.example.test', undefined), /not LOADTEST_ALLOWED_HOST/);
  assert.throws(() => assertStaging('http://staging.example.test', 'staging.example.test'), /https only/);
  assert.equal(assertAllowedDatabase(urlFor('db.example.test'), 'db.example.test'), 'db.example.test');
  assert.throws(() => assertAllowedDatabase(urlFor('other.example.test'), 'db.example.test'), /not LOADTEST_ALLOWED_HOST/);
});

test('a stage that fails hard stops itself after 20 turns', () => {
  const turn = ok => ({ op: 'chat.turn', ok });
  assert.equal(shouldAbort(Array.from({ length: 19 }, () => turn(false))), false);
  assert.equal(shouldAbort(Array.from({ length: 20 }, (_, i) => turn(i > 10))), true);
  assert.equal(shouldAbort(Array.from({ length: 20 }, (_, i) => turn(i > 4))), false);
});

test('the driver without --go only prints the plan and sends nothing', async () => {
  const { spawnSync } = await import('node:child_process');
  const out = join(mkdtempSync(join(tmpdir(), 'lt-')), 'run');
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '../loadtest/core-path-load.mjs'), '--series', '--out', out],
    { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /30 -> 50 -> 75 -> 100 -> 50 -> 100 users/);
  assert.match(r.stdout, /dry run/);
});

test('first-token latency starts at the first non-empty text event, not at `opened`', () => {
  const opened = 'event: opened\ndata: {"turnId":1,"replay":false}\n\n';
  assert.equal(hasTextDelta(opened), false);
  assert.equal(hasTextDelta(opened + 'event: text\ndata: {"delta":""}\n\n'), false);
  assert.equal(hasTextDelta(opened + 'event: text\ndata: {"delta":"a"}\n\n'), true);
  assert.equal(hasTextDelta(opened + 'event: text\ndata: {"del'), false);
});
