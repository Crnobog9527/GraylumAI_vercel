/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { md5Patch, supersededPatch, withoutMd5Patch } from '../../packages/db/tests/content-erasure/md5-chain.mjs';

const root = new URL('../../', import.meta.url);
const migration = name => ({ name, sql: readFileSync(new URL('packages/db/migrations/' + name, root), 'utf8') });
const p0215 = migration('0215_runtime_platform_failure_refund.sql');
const p0233 = migration('0233_runtime_positioning_refusal_refund.sql');
const marker = migration('0231_content_erasure_instant_session.sql');
const FN = 'runtime_execution(uuid,uuid,text,jsonb)';
const at = md5 => async signature => { assert.equal(signature, FN); return md5; };

test('reads the md5 patches 0215 and 0233 declare, and nothing from text-marker migrations', () => {
  assert.deepEqual(md5Patch(p0215.sql), { signature: FN, source: '0aff2bcc606bee432509e1eebfcfca43', target: '3312aaac174e973ac33c29ff2c75dd20' });
  assert.deepEqual(md5Patch(p0233.sql), { signature: FN, source: '3312aaac174e973ac33c29ff2c75dd20', target: '7525ae8d4e450dd8f03db7fa77e89453' });
  assert.equal(md5Patch(marker.sql), null);
});

test('skips 0215 only when 0233 continues its chain and the database is at the chain tail', async () => {
  const files = [p0215, marker, p0233];
  const result = await supersededPatch(files, 0, at('7525ae8d4e450dd8f03db7fa77e89453'));
  assert.equal(result.skip, true);
  assert.match(result.reason, /0215_runtime_platform_failure_refund\.sql: md5 patch of runtime_execution.* 7525ae8d.*0215.* -> 0233/);
  // Only the md5 block is left out; the rest of the migration is what gets replayed.
  assert.equal(result.rest, withoutMd5Patch(p0215.sql));
  assert.doesNotMatch(result.rest, /source_md5|pg_get_functiondef|EXECUTE definition/);
});

test('never skips the chain tail, a lone md5 patch, or a text-marker migration', async () => {
  const tailMd5 = at('7525ae8d4e450dd8f03db7fa77e89453');
  assert.deepEqual(await supersededPatch([p0215, p0233], 1, tailMd5), { skip: false });
  assert.deepEqual(await supersededPatch([p0215], 0, at('3312aaac174e973ac33c29ff2c75dd20')), { skip: false });
  assert.deepEqual(await supersededPatch([marker, p0233], 0, tailMd5), { skip: false });
});

test('does not skip when the chain is broken (a later source is not the earlier target)', async () => {
  const broken = { name: '0299_broken.sql', sql: p0233.sql.replaceAll('3312aaac174e973ac33c29ff2c75dd20', 'ffffffffffffffffffffffffffffffff') };
  assert.deepEqual(await supersededPatch([p0215, broken], 0, at('7525ae8d4e450dd8f03db7fa77e89453')), { skip: false });
});

test('does not skip when the database is not at the chain tail', async () => {
  assert.deepEqual(await supersededPatch([p0215, p0233], 0, at('3312aaac174e973ac33c29ff2c75dd20')), { skip: false });
  assert.deepEqual(await supersededPatch([p0215, p0233], 0, at('0000000000000000000000000000000a')), { skip: false });
});

test('leaves out only the md5 block, keeping every other statement of the migration', () => {
  const rest = withoutMd5Patch(p0233.sql);
  assert.doesNotMatch(rest, /source_md5/);
  assert.match(rest, /CREATE INDEX IF NOT EXISTS runtime_executions_positioning_refusals/);
  assert.match(rest, /CREATE OR REPLACE FUNCTION public\.runtime_positioning_gate/);
  assert.match(rest, /GRANT EXECUTE ON FUNCTION public\.runtime_positioning_gate\(uuid\) TO service_role/);
  assert.match(rest, /^BEGIN;/m);
  assert.match(rest, /COMMIT;\s*$/);
});

test('does not skip when the md5 block cannot be isolated exactly', async () => {
  const doubled = { name: '0215_doubled.sql', sql: p0215.sql.replace('COMMIT;', 'DO $migration$ BEGIN NULL; END $migration$;\nCOMMIT;') };
  assert.equal(withoutMd5Patch(doubled.sql), null);
  assert.deepEqual(await supersededPatch([doubled, p0233], 0, at('7525ae8d4e450dd8f03db7fa77e89453')), { skip: false });
});
