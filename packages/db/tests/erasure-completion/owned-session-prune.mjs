/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import assert from 'node:assert/strict';
import {ready} from '../erasure-binding/cases.mjs';
import {rpc,fixture} from '../erasure-b2a/cases.mjs';

const tables=['runtime_session_batches','runtime_session_history'];
const ownerScope=t=>`SELECT ctid::text c FROM ${t} x WHERE erasure_business_owner('${t}',to_jsonb(x))=$1 ORDER BY 1`;
const sessionScope=t=>`SELECT ctid::text c FROM ${t} x
 WHERE x.session_id IN (SELECT s.id FROM runtime_sessions s WHERE s.actor_id=$1) ORDER BY 1`;

// 0349: the pruned rows of both session tables are exactly the rows erasure_business_owner assigns.
export async function runOwnedSessionPrune(db,report) {
 const src=(await db.query(`SELECT pg_get_functiondef('account_erasure_prune_business(uuid,integer)'::regprocedure) d`)).rows[0].d;
 assert.ok(src.includes("WHEN t IN ('runtime_session_batches','runtime_session_history')"),'0349 patch installed');
 // Synthetic open-account canaries: a closed subject's pruning must not touch or serialize them.
 const open=await fixture(db);
 open.execution=(await db.query('SELECT b2a_test.bind($1) v',[open])).rows[0].v;
 open.session=(await db.query('SELECT session_id FROM runtime_executions WHERE id=$1',[open.execution])).rows[0].session_id;
 await db.query(`INSERT INTO runtime_session_history(session_id,revision,execution_id,item)
  SELECT $1,g,$2,jsonb_build_object('privateCanary',repeat(md5(g::text),2048)) FROM generate_series(1,48) g`,[open.session,open.execution]);
 await db.query(`INSERT INTO runtime_session_batches(session_id,execution_id,batch,items,start_revision,end_revision)
  SELECT $1,$2,g,jsonb_build_array(jsonb_build_object('privateCanary',repeat(md5(g::text),2048))),g,g+1
  FROM generate_series(0,47) g`,[open.session,open.execution]);
 const snapshot=async()=>(await db.query(`SELECT
  (SELECT md5(string_agg(md5(item::text),'' ORDER BY revision)) FROM runtime_session_history WHERE session_id=$1) h,
  (SELECT md5(string_agg(md5(items::text),'' ORDER BY batch)) FROM runtime_session_batches WHERE session_id=$1) b`,[open.session])).rows[0];
 const before=await snapshot();
 // More open owners with uneven row counts so the comparison spans several actors and sessions.
 for(const rows of [1,3,7]) {
  const other=await fixture(db);
  other.execution=(await db.query('SELECT b2a_test.bind($1) v',[other])).rows[0].v;
  other.session=(await db.query('SELECT session_id FROM runtime_executions WHERE id=$1',[other.execution])).rows[0].session_id;
  await db.query(`INSERT INTO runtime_session_history(session_id,revision,execution_id,item)
   SELECT $1,g,$2,jsonb_build_object('body',g) FROM generate_series(1,$3::int) g`,[other.session,other.execution,rows]);
  await db.query(`INSERT INTO runtime_session_batches(session_id,execution_id,batch,items,start_revision,end_revision)
   SELECT $1,$2,g,jsonb_build_array(g),g,g+1 FROM generate_series(0,$3::int-1) g`,[other.session,other.execution,rows]);
 }

 let compared=0;
 const actors=(await db.query('SELECT DISTINCT actor_id a FROM runtime_sessions ORDER BY 1')).rows.map(r=>r.a);
 for(const table of tables) for(const actor of actors) {
  const legacy=(await db.query(ownerScope(table),[actor])).rows.map(r=>r.c);
  const filtered=(await db.query(sessionScope(table),[actor])).rows.map(r=>r.c);
  assert.deepEqual(filtered,legacy,`${table} scope for ${actor} unchanged`);
  compared+=legacy.length;
 }
 assert.ok(actors.length>=5&&compared>=118,'scope comparison covered real rows, including the canaries');

 const closed=await ready(db,{version:'v1'});
 await rpc(db,'account_erasure_prune_business',closed.actor,100);
 await rpc(db,'account_erasure_prune_business',closed.actor,100);
 assert.deepEqual(await snapshot(),before,'open account history and batches remain exact');
 const explain=async query=>(await db.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+query,[closed.actor])).rows[0]['QUERY PLAN'][0];
 const timings=[];
 for(const table of tables) {
  const legacy=await explain(ownerScope(table)),filtered=await explain(sessionScope(table));
  timings.push(`${table} ${legacy['Execution Time']}ms→${filtered['Execution Time']}ms`);
 }
 report.checks.push(`owned session prune: batches/history scope identical for ${actors.length} actors (${compared} rows); open-account canaries exact; ${timings.join(', ')}`);
}
