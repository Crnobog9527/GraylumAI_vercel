import assert from 'node:assert/strict';
import test from 'node:test';
import { isAnalyticsKey, run } from '../ratelimit-analytics-cleanup.mjs';

test('matches only ratelimit analytics buckets, never live counters', () => {
  assert.equal(isAnalyticsKey('graylum:ratelimit:ai::events:1791810000000'), true);
  assert.equal(isAnalyticsKey('graylum:middleware::events:1791810000000'), true);
  assert.equal(isAnalyticsKey('graylum:ratelimit:ai:user-1:28100000'), false);
  assert.equal(isAnalyticsKey('graylum:ratelimit:auth:account-erasure:abc'), false);
  assert.equal(isAnalyticsKey('other:app::events:1'), false);
});

function fakeRedis(keys) {
  const calls = [];
  const store = new Map(keys.map((key) => [key, -1]));
  const call = async (_url, _token, args) => {
    calls.push(args[0]);
    if (args[0] === 'SCAN') return args[1] === '0' ? ['7', [...store.keys()].slice(0, 2)] : ['0', [...store.keys()].slice(2)];
    if (args[0] === 'TTL') return store.get(args[1]);
    if (args[0] === 'UNLINK') { const n = args.slice(1).filter((k) => store.delete(k)).length; return n; }
    throw new Error('unexpected');
  };
  return { call, calls, store };
}

test('dry run counts without deleting; --delete unlinks only analytics keys', async () => {
  const keys = ['graylum:ratelimit:ai::events:1', 'graylum:ratelimit:ai:user:2', 'graylum:middleware::events:3'];
  const dry = fakeRedis(keys);
  assert.deepEqual(await run({ url: 'u', token: 't', remove: false, call: dry.call }),
    { found: 2, noExpiry: 2, removed: 0, dryRun: true });
  assert.equal(dry.calls.includes('UNLINK'), false);

  const real = fakeRedis(keys);
  assert.deepEqual(await run({ url: 'u', token: 't', remove: true, call: real.call }),
    { found: 2, noExpiry: 2, removed: 2, dryRun: false });
  assert.deepEqual([...real.store.keys()], ['graylum:ratelimit:ai:user:2']);
});
