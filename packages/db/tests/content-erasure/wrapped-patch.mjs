/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Tail replay support for content-erasure/run-local.mjs (companion of md5-chain.mjs).
//
// 0201 patches bill2_scope_allowed in place: it looks for the anchor text of the function body and refuses anything
// else (CONTENT_ERASURE_SOURCE_MISMATCH: scope). A later migration may instead rename that function and put a thin
// wrapper under the old name (0286 -> bill2_scope_allowed_before_library). The D7 scope tombstones then live in the
// renamed function (a rename keeps the body) and the wrapper no longer contains 0201's anchor, so replaying 0201
// would fail before any case runs.
//
// Only that one patch block is left out of the replay, and only when the files and the database prove the situation:
// (1) a later migration renames bill2_scope_allowed; (2) the function under the old name no longer has 0201's anchor or
// marker; (3) the renamed function carries the D7 marker. Anything else replays 0201 whole (and fails loudly).
// Every other statement of 0201 is still replayed, and the replay must still land on the complete final catalog.

const MARKER = '-- D7 scope tombstones';
const ANCHOR = ' SELECT (bill2_scope_allowed_before_topic';
const BLOCK = / source:=pg_get_functiondef\('public\.bill2_scope_allowed\(uuid,jsonb\)'::regprocedure\);\n IF position\('-- D7 scope tombstones' IN source\)=0 THEN\n[\s\S]*?\n END IF;\n/g;
const RENAME = /ALTER FUNCTION public\.bill2_scope_allowed\(uuid,jsonb\) RENAME TO (\w+);/;

/** The migration without its bill2_scope_allowed patch block, or null when that block cannot be isolated exactly once. */
export function withoutScopePatch(sql) {
  const blocks = sql.match(BLOCK) ?? [];
  return blocks.length === 1 ? sql.replace(BLOCK, '') : null;
}

/**
 * tail: [{ name, sql }] migrations after 0201 in replay order; definitionOf(functionName) returns the current
 * pg_get_functiondef of public.<name>(uuid,jsonb), or '' when it does not exist.
 * Returns { skip: true, rest, reason } only when all three conditions hold, else { skip: false }.
 */
export async function supersededScopePatch(sql, tail, definitionOf) {
  const rest = withoutScopePatch(sql);
  if (rest === null) return { skip: false };
  const wrapper = tail.map(file => ({ file, rename: RENAME.exec(file.sql) })).find(item => item.rename);
  if (!wrapper) return { skip: false };
  const current = await definitionOf('bill2_scope_allowed');
  if (!current || current.includes(MARKER) || current.includes(ANCHOR)) return { skip: false };
  const renamed = wrapper.rename[1];
  if (!(await definitionOf(renamed)).includes(MARKER)) return { skip: false };
  return { skip: true, rest, reason: `0201_content_erasure.sql: bill2_scope_allowed patch left out (${wrapper.file.name} renamed it to `
    + `${renamed}, which carries "${MARKER}"); its other statements replayed` };
}
