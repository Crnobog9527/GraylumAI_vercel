/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Tail replay support for content-erasure/run-local.mjs.
//
// Two patch styles exist. Text-marker patches (0201, 0218, 0231, ...) skip when their patched text is present, so
// they converge on the final catalog even after later migrations change the same function. md5-anchored patches
// (0215, 0233) return only on their own target md5 and refuse anything but their exact source md5, so once a later
// md5 patch has changed the same function, the earlier one can never run again on the final catalog.
//
// Only the superseded md5 block of such a patch is left out of the replay, and only when the migration files prove the
// chain and the database is at its end: (1) X is an md5 patch with target T; (2) a later md5 patch Y of the same
// function declares source T, and so on to the md5 tail; (3) the database is at the chain's end. The end is the md5
// tail itself (current md5 equals the tail's target), unless later migrations changed the same function again with
// text-marker patches (0248 after 0239): then those marker patches extend the chain, and the end is proven by every
// one of their markers being present in the current definition. With such marker patches, the md5 tail is itself
// superseded and is left out the same way. Every other statement of X is still replayed. Otherwise X is replayed whole
// (and fails). X's own repeatability is still checked at its historical position by build-from-files, and the replay
// must still land on the complete final catalog.
//
// Convention for future migrations that change a function already in an md5 chain (0215 -> 0233 -> 0239 for
// runtime_execution): either add an md5 patch that declares the previous md5 target as its source (as 0233 does for
// 0215), while no marker patch has followed the chain yet; or add a text-marker patch in the form
//   definition:=pg_get_functiondef('public.<signature>'::regprocedure);
//   IF position('<unique marker>' IN definition)=0 THEN ... END IF;
// whose patched text contains the marker (as 0248 does). Once a marker patch has followed, only marker patches may
// follow it: a later md5 patch could not name its source and the chain would no longer be provable.

const PATCH = /pg_get_functiondef\('public\.([^']+)'::regprocedure\);source_md5:=md5\(definition\);\s*IF source_md5='([0-9a-f]{32})' THEN RETURN;END IF;\s*IF source_md5<>'([0-9a-f]{32})' THEN RAISE/;

// A text-marker patch: reads the function, then patches only while its marker is absent ('...' or $tag$...$tag$ quoted).
const MARKER = /pg_get_functiondef\('public\.([^']+)'::regprocedure\);\s*IF position\((?:'([^']+)'|\$(\w*)\$([\s\S]+?)\$\3\$) IN definition\)=0 THEN/g;

const BLOCK = /DO \$migration\$[\s\S]*?END \$migration\$;\n?/g;

/** The migration without its md5-patch DO block, or null when exactly one such block cannot be isolated. */
export function withoutMd5Patch(sql) {
  const blocks = (sql.match(BLOCK) ?? []).filter(block => md5Patch(block));
  if (blocks.length !== 1 || md5Patch(sql.replace(blocks[0], ''))) return null;
  return sql.replace(blocks[0], '');
}

/** The markers of the text-marker patches a migration applies to `signature`, in file order. */
export function markerPatches(sql, signature) {
  return [...sql.matchAll(MARKER)].filter(match => match[1] === signature).map(match => match[2] ?? match[4]);
}

/** The md5 patch a migration declares, or null for any other migration. */
export function md5Patch(sql) {
  const match = PATCH.exec(sql);
  return match ? { signature: match[1], target: match[2], source: match[3] } : null;
}

/**
 * Whether migration `files[index]` is a superseded md5 patch the database has already moved past.
 * files: [{ name, sql }] in replay order; currentMd5(signature) returns the function's md5 in the database now;
 * hasMarker(signature, marker) whether the function's current definition contains the marker text.
 * Returns { skip: true, rest, reason } only when all three conditions hold (rest: the migration without that block,
 * to replay instead), else { skip: false }.
 */
export async function supersededPatch(files, index, currentMd5, hasMarker) {
  const patch = md5Patch(files[index].sql);
  const rest = withoutMd5Patch(files[index].sql);
  if (!patch || rest === null) return { skip: false };
  const chain = [files[index].name];
  let tail = patch;
  const markers = [];
  for (const later of files.slice(index + 1)) {
    const next = md5Patch(later.sql);
    if (next && next.signature === patch.signature) {
      if (markers.length || next.source !== tail.target) return { skip: false };
      chain.push(later.name);
      tail = next;
    }
    const found = markerPatches(later.sql, patch.signature);
    if (found.length) {
      markers.push(...found);
      chain.push(`${later.name} (marker)`);
    }
  }
  if (chain.length === 1) return { skip: false };
  if (markers.length) {
    for (const marker of markers) if (!(await hasMarker(patch.signature, marker))) return { skip: false };
  } else if (await currentMd5(patch.signature) !== tail.target) return { skip: false };
  const end = markers.length ? `markers present: ${markers.join(', ')}` : `md5 ${tail.target}`;
  return { skip: true, rest, reason: `${files[index].name}: md5 patch of ${patch.signature} left out (already at chain end, `
    + `${end}; ${chain.join(' -> ')}); its other statements replayed` };
}
