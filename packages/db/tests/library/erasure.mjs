/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export async function verifyErasure(admin, service, word = false) {
  const actor = randomUUID(), request = randomUUID(), token = randomUUID();
  await admin.query('INSERT INTO profiles(id,credits) VALUES($1,73)', [actor]);
  const doc = (await service.query("SELECT library_upload_begin($1,$2,$3,$4,'reference',5) v",
    [actor, randomUUID(), word ? 'private.docx' : 'private.txt', word ? 'docx' : 'txt'])).rows[0].v.documentId;
  if (word) await service.query('SELECT library_word_text_begin($1,$2,5)', [actor,doc]);
  await service.query(word ? 'SELECT library_word_publish($1,$2,5,5,$3)' : 'SELECT library_publish($1,$2,5,$3)', [actor, doc, JSON.stringify([{ title: '', body: 'hello' }])]);
  // Establish actual closed-account state without bypassing any guards/FKs.
  await admin.query("UPDATE profiles SET status='deleted',is_deleted='true' WHERE id=$1", [actor]);
  await admin.query(`INSERT INTO account_erasure_requests(profile_id,request_id,executor_token,confirmed_at)
    VALUES($1,$2,$3,clock_timestamp()-interval '1 minute')`, [actor, request, token]);
  const tables = (await admin.query(`SELECT DISTINCT table_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name LIKE 'library_%' AND column_name IN ('actor_id','profile_id')`)).rows;
  assert.equal(tables.length, 4);
  for (const { table_name: table } of tables) {
    assert.equal((await admin.query('SELECT erasure_business_owner($1,$2) v',
      [table, JSON.stringify({ actor_id: actor })])).rows[0].v, actor);
  }
  const count = async () => Number((await admin.query('SELECT account_erasure_business_remaining($1) v', [actor])).rows[0].v);
  assert.ok(await count() >= 4);
  await admin.query('SELECT account_erasure_prune_business($1)', [actor]);
  assert.equal((await admin.query('SELECT count(*)::int n FROM library_upload_reservations WHERE actor_id=$1', [actor])).rows[0].n, 1);
  await assert.rejects(service.query('SELECT library_erasure_proof($1,$2,$3,true)', [actor, request, token]), /ERASURE_LIBRARY_PENDING/);
  await service.query('SELECT library_delete($1,$2,true)', [actor, doc]);
  // Ticket proof alone cannot erase its references or start Auth while a library token is live.
  await service.query('SELECT account_erasure_local_cleanup($1,true)', [actor]);
  assert.equal((await service.query('SELECT account_erasure_auth_begin($1,$2) v', [actor, request])).rows[0].v.ready, false);
  assert.equal((await service.query('SELECT library_cleanup_observe($1,$2,true) v', [actor, doc])).rows[0].v, false);
  await assert.rejects(service.query('SELECT library_upload_begin($1,$2,\'a.txt\',\'txt\',\'reference\',1)',
    [actor, randomUUID()]), /LIBRARY_ACCOUNT_CLOSED/);
  // Both original and text guards must drain, including a late-arriving text token.
  await admin.query(`UPDATE library_upload_reservations SET original_guard_until=now()-interval '1 minute',
    text_path=actor_id::text||'/'||document_id::text||'/text',text_guard_until=now()+interval '1 minute',text_hold=10000000
    WHERE document_id=$1`, [doc]);
  assert.equal((await service.query('SELECT library_cleanup_observe($1,$2,true) v', [actor, doc])).rows[0].v, false);
  await admin.query("UPDATE library_upload_reservations SET text_guard_until=now()-interval '1 minute' WHERE document_id=$1", [doc]);
  await service.query('SELECT library_cleanup_observe($1,$2,true)', [actor, doc]);
  await service.query('SELECT library_cleanup_observe($1,$2,false)', [actor, doc]);
  await service.query('SELECT library_cleanup_observe($1,$2,true)', [actor, doc]);
  await new Promise(r => setTimeout(r, 1050));
  assert.equal((await service.query('SELECT library_cleanup_observe($1,$2,true) v', [actor, doc])).rows[0].v, true);
  assert.equal(await count(), 1, 'empty metadata is insufficient without library bucket proof');
  await service.query('SELECT account_erasure_local_cleanup($1,true)', [actor]);
  assert.equal((await service.query('SELECT account_erasure_auth_begin($1,$2) v', [actor, request])).rows[0].v.ready, false);
  await assert.rejects(service.query('SELECT library_erasure_proof($1,$2,$3,true)',
    [actor, request, randomUUID()]), /ERASURE_EXECUTOR_NOT_CLAIMED/);
  await service.query('SELECT library_erasure_proof($1,$2,$3,true)', [actor, request, token]);
  assert.equal(await count(), 0);
  await service.query('SELECT account_erasure_local_cleanup($1,false)', [actor]);
  assert.equal((await service.query('SELECT account_erasure_auth_begin($1,$2) v', [actor, request])).rows[0].v.ready, false,
    'library bucket proof alone cannot replace ticket proof');
  const clean = (await service.query('SELECT account_erasure_local_cleanup($1,true) v', [actor])).rows[0].v;
  assert.deepEqual(clean, { remaining: 0, manualReview: 0, errors: [] });
  const auth = (await service.query('SELECT account_erasure_auth_begin($1,$2) v', [actor, request])).rows[0].v;
  assert.equal(auth.ready, true); assert.equal(auth.claimed, true);
  assert.equal((await service.query('SELECT account_erasure_auth_result($1,$2,true) v', [actor, request])).rows[0].v.stage, 'completed');
  assert.equal((await admin.query('SELECT credits FROM profiles WHERE id=$1', [actor])).rows[0].credits, 73);
  console.log('PASS: owner mapping, public prune/remaining, both token guards, independent bucket proofs, Auth completion, financial retention');
}
