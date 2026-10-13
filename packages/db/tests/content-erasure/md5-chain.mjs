/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Tail replay support for content-erasure/run-local.mjs.
//
// Two patch styles exist. Text-marker patches (0201, 0218, 0231, ...) skip when their patched text is present, so
// they converge on the final catalog even after later migrations change the same function. md5-anchored patches
// (0215, 0233) return only on their own target md5 and refuse anything but their exact source md5, so once a later
// md5 patch has changed the same function, the earlier one can never run again on the final catalog.
//
// Replaying such a superseded patch is skipped only when the migration files prove the chain and the database is at
// its end: (1) X is an md5 patch with target T; (2) a later md5 patch Y of the same function declares source T, and so
// on to the chain tail; (3) the function's current md5 equals the tail's target. Otherwise X is replayed (and fails).
// X's own repeatability is still checked at its historical position by build-from-files.
//
// Convention for future migrations: an md5 patch of a function another md5 patch already changed must declare that
// patch's target as its source (as 0233 does for 0215), so this chain stays provable.

const PATCH = /pg_get_functiondef\('public\.([^']+)'::regprocedure\);source_md5:=md5\(definition\);\s*IF source_md5='([0-9a-f]{32})' THEN RETURN;END IF;\s*IF source_md5<>'([0-9a-f]{32})' THEN RAISE/;

/** The md5 patch a migration declares, or null for any other migration. */
export function md5Patch(sql) {
  const match = PATCH.exec(sql);
  return match ? { signature: match[1], target: match[2], source: match[3] } : null;
}

/**
 * Whether migration `files[index]` is a superseded md5 patch the database has already moved past.
 * files: [{ name, sql }] in replay order; currentMd5(signature) returns the function's md5 in the database now.
 * Returns { skip: true, reason } only when all three conditions hold, else { skip: false }.
 */
export async function supersededPatch(files, index, currentMd5) {
  const patch = md5Patch(files[index].sql);
  if (!patch) return { skip: false };
  const chain = [files[index].name];
  let tail = patch;
  for (const later of files.slice(index + 1)) {
    const next = md5Patch(later.sql);
    if (!next || next.signature !== patch.signature) continue;
    if (next.source !== tail.target) return { skip: false };
    chain.push(later.name);
    tail = next;
  }
  if (chain.length === 1) return { skip: false };
  const current = await currentMd5(patch.signature);
  if (current !== tail.target) return { skip: false };
  return { skip: true, reason: `${files[index].name}: ${patch.signature} already at chain tail ${tail.target} (${chain.join(' -> ')})` };
}
