/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// These suites call account_erasure_local_cleanup directly, without the executor. In production the
// executor's library step (library_erasure_proof(…, verified=true), 0203) records the library storage
// proof first; local cleanup only counts storage as verified once it exists. Record it under the same
// condition library_erasure_proof enforces: nothing of the subject is left in the library.
import assert from 'node:assert/strict';

export async function recordLibraryProof(db,f){
 assert.equal((await db.query('SELECT library_erasure_remaining($1)::int n',[f.actor])).rows[0].n,0,'library already empty');
 const updated=await db.query(`UPDATE account_erasure_requests SET library_storage_verified_at=clock_timestamp()
  WHERE profile_id=$1 AND library_storage_verified_at IS NULL`,[f.actor]);
 assert.ok(updated.rowCount<=1);
}
