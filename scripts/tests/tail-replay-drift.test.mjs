import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACCEPTED_LEFTOVER_ACL, replayDrift } from '../../packages/db/tests/content-erasure/tail-replay.mjs';

// The tail replay of the nightly migration suites compares the replayed catalog with the final one. A refused (not replayed) migration may explain
// an older body, constraint, trigger or index of what it names; it must never explain a function's EXECUTE rights (review of #1793).
const refusedText = 'CREATE OR REPLACE FUNCTION public.atomic_pre_deduct(...) ...; REVOKE ALL ON FUNCTION public.atomic_pre_deduct(uuid,integer,text,uuid) FROM PUBLIC;\n'
  + 'GRANT EXECUTE ON FUNCTION public.atomic_pre_deduct(uuid,integer,text,uuid) TO service_role;';
const owner = 'postgres=X/postgres';

test('an extra PUBLIC EXECUTE on a function of the final catalog still fails, even when a refused migration names and grants it', () => {
  const key = 'fnacl:atomic_pre_deduct(uuid,integer,text,uuid)';
  const { explained, remaining } = replayDrift({ after: { [key]: `=X/postgres,${owner}` }, finalCatalog: { [key]: owner }, refusedText });
  assert.deepEqual(explained, []);
  assert.deepEqual(remaining, [key]);
});

test('rights removed from a function of the final catalog fail as well', () => {
  const key = 'fnacl:atomic_pre_deduct(uuid,integer,text,uuid)';
  assert.deepEqual(replayDrift({ after: { [key]: owner }, finalCatalog: { [key]: `${owner},service_role=X/postgres` }, refusedText }).remaining, [key]);
});

test('the one accepted leftover (an overload the replay brings back, absent from the final catalog, exact rights) is explained, nothing else about it is', () => {
  const [key, rights] = Object.entries(ACCEPTED_LEFTOVER_ACL)[0];
  assert.deepEqual(replayDrift({ after: { [key]: rights }, finalCatalog: {}, refusedText: '' }), { explained: [key], remaining: [] });
  // other rights on it fail, and so does the same key when the final catalog has it
  assert.deepEqual(replayDrift({ after: { [key]: `=X/postgres,${rights}` }, finalCatalog: {}, refusedText: '' }).remaining, [key]);
  assert.deepEqual(replayDrift({ after: { [key]: rights }, finalCatalog: { [key]: owner }, refusedText: '' }).remaining, [key]);
});

test('an older body of a function a refused migration names is explained; a difference nothing refused names is not', () => {
  const named = 'fn:atomic_pre_deduct(uuid,integer,text,uuid)', other = 'fn:credit_available(uuid)';
  const { explained, remaining } = replayDrift({ after: { [named]: 'old', [other]: 'old' }, finalCatalog: { [named]: 'new', [other]: 'new' }, refusedText });
  assert.deepEqual(explained, [named]);
  assert.deepEqual(remaining, [other]);
});
