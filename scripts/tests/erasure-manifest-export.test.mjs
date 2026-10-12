/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { PREFIX, credentials, orderForReplay, parseArgs, parseEntry, readManifest, restClient, summarize, exportProblem } from '../erasure-manifest-export.mjs';

const a = '00000000-0000-4000-8000-00000000000a';
const b = '00000000-0000-4000-8000-00000000000b';
const t = n => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
const entry = (kind, target, profile, confirmedAt) => ({ kind, targetId: target, profileId: profile, confirmedAt });
const store = values => new Map(values.map(v => [`${PREFIX}${v.kind}:${v.targetId}`, JSON.stringify(v)]));

function fakeRedis(map, pageSize = 2) {
  const commands = [];
  const send = async command => {
    commands.push(command[0]);
    if (command[0] === 'SCAN') {
      const keys = [...map.keys()].sort(); const start = Number(command[1]);
      const next = start + pageSize >= keys.length ? '0' : String(start + pageSize);
      return [next, keys.slice(start, start + pageSize)];
    }
    if (command[0] === 'MGET') return command.slice(1).map(key => map.get(key) ?? null);
    throw new Error('unexpected');
  };
  return { send, commands };
}

test('reads every page with SCAN/MGET only and orders accounts first, then by confirmation time', async () => {
  const map = store([
    entry('answer', t(1), a, '2026-10-05T00:00:00Z'), entry('library_document', t(2), b, '2026-10-02T00:00:00Z'),
    entry('account', a, a, '2026-10-06T00:00:00Z'), entry('content', t(3), b, '2026-10-01T00:00:00Z'),
  ]);
  const redis = fakeRedis(map);
  const result = await readManifest(redis.send);
  assert.deepEqual([...new Set(redis.commands)].sort(), ['MGET', 'SCAN']);
  assert.deepEqual(result.entries.map(e => [e.kind, e.supersededByAccount]),
    [['account', false], ['content', false], ['library_document', false], ['answer', true]]);
  const summary = summarize(result);
  assert.equal(summary.exported, 4); assert.equal(summary.byKind.account, 1); assert.equal(summary.supersededByAccount, 1);
  assert.equal(summary.earliest, '2026-10-01T00:00:00Z');
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(`${t(1)}|${a}`), 'counts only, no ids in the summary');
  const since = await readManifest(fakeRedis(map).send, { since: '2026-10-04T00:00:00Z' });
  assert.deepEqual(since.entries.map(e => e.kind), ['account', 'answer']);
});

test('rejects entries with extra fields, wrong key, bad kind or bad ids', () => {
  const ok = entry('session', t(4), a, '2026-10-01T00:00:00Z');
  const key = `${PREFIX}session:${t(4)}`;
  assert.deepEqual(parseEntry(key, JSON.stringify(ok)), ok);
  assert.equal(parseEntry(key, JSON.stringify({ ...ok, title: 'PRIVATE' })), null);
  assert.equal(parseEntry(`${PREFIX}answer:${t(4)}`, JSON.stringify(ok)), null);
  assert.equal(parseEntry(key, JSON.stringify({ ...ok, kind: 'chat' })), null);
  assert.equal(parseEntry(key, JSON.stringify({ ...ok, profileId: 'x' })), null);
  assert.equal(parseEntry(key, '{not json'), null);
  assert.deepEqual(orderForReplay([]), []);
});

test('read-only client refuses writes; credentials must be complete https and are not echoed', async () => {
  let sent = null;
  const send = restClient({ url: 'https://redis.example.test', token: 'synthetic' },
    async (_url, init) => { sent = JSON.parse(init.body); return { ok: true, json: async () => ({ result: [] }) }; });
  await assert.rejects(send(['DEL', 'x']), /Read-only/);
  assert.deepEqual(await send(['MGET', 'k']), []);
  assert.deepEqual(sent, ['MGET', 'k']);
  assert.throws(() => credentials({ UPSTASH_REDIS_REST_URL: 'https://redis.example.test' }), /incomplete/);
  assert.throws(() => credentials({ KV_REST_API_URL: 'http://redis.example.test', KV_REST_API_TOKEN: 's' }), /https/);
  assert.throws(() => parseArgs(['--since', 'not-a-date']), /Unknown/);
  assert.deepEqual(parseArgs([]), { write: null, since: null });
});

test('missing credentials fail closed with a non-zero exit and no network access', () => {
  const result = spawnSync(process.execPath, ['scripts/erasure-manifest-export.mjs'], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /credentials are missing/);
});

test('an export with any invalid or vanished key is refused', () => {
  assert.equal(exportProblem({ invalid: 0, vanished: 0 }), null);
  assert.match(exportProblem({ invalid: 1, vanished: 0 }), /Invalid/);
  assert.match(exportProblem({ invalid: 0, vanished: 1 }), /incomplete/);
});
