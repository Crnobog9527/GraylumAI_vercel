/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import assert from 'node:assert/strict';
import {ready,detach} from '../erasure-binding/cases.mjs';
import {rpc,fixture} from '../erasure-b2a/cases.mjs';

export async function runOwnedRuntimePrune(db,report) {
 const unrelated=await fixture(db);
 const unrelatedExecution=(await db.query('SELECT b2a_test.bind($1) v',[unrelated])).rows[0].v;
 const session=(await db.query('SELECT session_id FROM runtime_executions WHERE id=$1',[unrelatedExecution])).rows[0].session_id;
 // Synthetic, open-account canary bodies: a closed, already empty subject must not serialize these to find its own rows.
 await db.query(`INSERT INTO runtime_executions(actor_id,session_id,request_id,payload,history_revision,state)
  SELECT $1,$2,gen_random_uuid(),jsonb_build_object('privateCanary',repeat(md5(g::text),4096)),0,'prepared'
  FROM generate_series(1,64) g`,[unrelated.actor,session]);
 const otherSnapshot=async()=>(await db.query(`SELECT count(*)::int n,md5(string_agg(md5(payload::text),'' ORDER BY id)) body_hash
  FROM runtime_executions WHERE actor_id=$1`,[unrelated.actor])).rows[0];
 const other=await otherSnapshot();
 const f=await ready(db,{version:'v1'});
 const finance=async()=>(await db.query(`SELECT to_jsonb(b) run,
  (SELECT credits FROM profiles WHERE id=$2) credits,
  (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM credit_transactions c WHERE user_id=$2) ledger
  FROM bill2_runs b WHERE b.id=$1`,[f.run,f.actor])).rows[0];
 const before=await finance();
 await rpc(db,'account_erasure_prune_business',f.actor,100);
 assert.equal((await db.query('SELECT count(*)::int n FROM runtime_executions WHERE id=$1',[f.execution])).rows[0].n,1,
  'financial binding still prevents physical removal');
 assert.deepEqual(await finance(),before);
 await detach(db,f);
 const detached=await finance();
 await rpc(db,'account_erasure_prune_business',f.actor,100);
 assert.equal((await db.query('SELECT count(*)::int n FROM runtime_executions WHERE actor_id=$1',[f.actor])).rows[0].n,0);
 assert.deepEqual(await finance(),detached,'pruning never changes retained money or evidence');
 await rpc(db,'account_erasure_prune_business',f.actor,100);
 assert.deepEqual(await otherSnapshot(),other,'unrelated open account and every large canary body remain exact');
 const explain=async query=>(await db.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+query,[f.actor])).rows[0]['QUERY PLAN'][0];
 const legacy=await explain("SELECT ctid FROM runtime_executions x WHERE erasure_business_owner('runtime_executions',to_jsonb(x))=$1 LIMIT 100");
 const indexed=await explain('SELECT ctid FROM runtime_executions x WHERE actor_id=$1 LIMIT 100');
 assert.equal(legacy.Plan['Actual Rows'],0);assert.equal(indexed.Plan['Actual Rows'],0);
 report.checks.push(`owned runtime prune: money/binding/cross-account/idempotency preserved; empty-subject JSON scan ${legacy['Execution Time']}ms, indexed ${indexed['Execution Time']}ms (64 synthetic large canaries)`);
}
