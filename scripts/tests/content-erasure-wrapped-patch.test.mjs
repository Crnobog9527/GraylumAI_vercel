/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { supersededScopePatch, withoutScopePatch } from '../../packages/db/tests/content-erasure/wrapped-patch.mjs';

const root = new URL('../../', import.meta.url);
const migration = name => ({ name, sql: readFileSync(new URL('packages/db/migrations/' + name, root), 'utf8') });
const p0201 = migration('0201_content_erasure.sql');
const wrapped = migration('0286_bill2_image_input.sql');
const other = migration('0276_content_derived_source.sql');
const MARKER = '-- D7 scope tombstones';
const defs = table => async name => table[name] ?? '';

test('isolates exactly the bill2_scope_allowed block of 0201 and keeps every other statement', () => {
  const rest = withoutScopePatch(p0201.sql);
  assert.ok(rest !== null);
  assert.doesNotMatch(rest, /public\.bill2_scope_allowed\(uuid,jsonb\)'::regprocedure/);
  assert.match(rest, /D7 research tombstones/);
  assert.match(rest, /D7 project read/);
  assert.equal(withoutScopePatch(other.sql), null);
});

test('leaves the block out only when a later migration wrapped the function and the renamed one carries the marker', async () => {
  const wrapper = 'CREATE OR REPLACE FUNCTION public.bill2_scope_allowed(a uuid, s jsonb) ... bill2_scope_allowed_before_library(a,s)';
  const skipped = await supersededScopePatch(p0201.sql, [other, wrapped],
    defs({ bill2_scope_allowed: wrapper, bill2_scope_allowed_before_library: 'body ' + MARKER }));
  assert.equal(skipped.skip, true);
  assert.match(skipped.reason, /0286_bill2_image_input\.sql renamed it to bill2_scope_allowed_before_library/);
  assert.equal(skipped.rest, withoutScopePatch(p0201.sql));
});

test('never skips without the proof: no wrapping migration, old name still patchable, marker missing, or no such function', async () => {
  const wrapper = 'wrapper';
  const proven = { bill2_scope_allowed: wrapper, bill2_scope_allowed_before_library: MARKER };
  assert.deepEqual(await supersededScopePatch(p0201.sql, [other], defs(proven)), { skip: false });
  assert.deepEqual(await supersededScopePatch(p0201.sql, [wrapped],
    defs({ ...proven, bill2_scope_allowed: ' SELECT (bill2_scope_allowed_before_topic(a,s))' })), { skip: false });
  assert.deepEqual(await supersededScopePatch(p0201.sql, [wrapped], defs({ ...proven, bill2_scope_allowed: MARKER })), { skip: false });
  assert.deepEqual(await supersededScopePatch(p0201.sql, [wrapped], defs({ ...proven, bill2_scope_allowed_before_library: 'no guard' })),
    { skip: false });
  assert.deepEqual(await supersededScopePatch(p0201.sql, [wrapped], defs({})), { skip: false });
  assert.deepEqual(await supersededScopePatch(other.sql, [wrapped], defs(proven)), { skip: false });
});
