/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// REPORT-VERSION-MARKS (0455): the server role has no SELECT on the tables the marks come from, so fusionReview.versionMarks
// reads through fusion_version_marks_read: the caller's own drafts answer with their versions and reviews, anything else is refused.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';
import {seed} from './cases.mjs';

async function asService(db,fn) {
  await db.query('SET ROLE service_role');
  try { return await fn(); } finally { await db.query('RESET ROLE'); }
}

export async function runFusionVersionMarks({db}) {
  const mine = await seed(db), other = await seed(db);
  // The reason for the function: the server role reads none of these tables directly.
  for (const table of ['opc_drafts','artifact_versions','fusion_reviews']) {
    assert.equal((await db.query("SELECT has_table_privilege('service_role',$1,'select') v",[table])).rows[0].v,false,table+' is closed to the server role');
  }
  const own = await asService(db,() => rpc(db,'fusion_version_marks_read',mine.actor,[mine.draft],[]));
  assert.ok(own.versions.some(version => version.id === mine.versionId),'the version of the caller\'s draft is returned');
  assert.deepEqual(own.reviews,[],'no review yet');
  // An extra version id of the caller's own project is returned once, not twice.
  const extra = await asService(db,() => rpc(db,'fusion_version_marks_read',mine.actor,[mine.draft],[mine.versionId]));
  assert.equal(extra.versions.filter(version => version.id === mine.versionId).length,1);
  // Another user's draft, an unknown one, or a list mixing them with the caller's own is refused, never answered empty.
  for (const drafts of [[other.draft],[randomUUID()],[mine.draft,other.draft]]) {
    await assert.rejects(asService(db,() => rpc(db,'fusion_version_marks_read',mine.actor,drafts,[])),/FUSION_VERSION_MARKS_DENIED/);
  }
  await assert.rejects(asService(db,() => rpc(db,'fusion_version_marks_read',mine.actor,[],[])),/FUSION_VERSION_MARKS_DENIED/);
  // Only the caller's own reviews come back, even for an extra version id of someone else's project.
  const foreign = await asService(db,() => rpc(db,'fusion_version_marks_read',mine.actor,[mine.draft],[other.versionId]));
  assert.deepEqual(foreign.reviews,[]);
}
