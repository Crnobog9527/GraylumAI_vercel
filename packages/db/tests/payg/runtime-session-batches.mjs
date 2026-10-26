/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {rpc} from '../erasure-b2a/cases.mjs';
// DB-PERF 0400 (PR-6 A): append_batches writes consecutive Session batches in one owner call, with the same result as
// one append per batch; each batch keeps the single-append replay, conflict, order and size rules; all or nothing.
export async function runtimeSessionBatchCases({db,report,setup}) {
  const user={role:'user',content:'synthetic batch question'};
  const reply={role:'assistant',content:'synthetic batch reply'};
  const extra={role:'assistant',content:'synthetic organizer note'};
  const state=async f=>({
    batches:(await db.query('SELECT batch,items,start_revision-s0 AS first,end_revision-s0 AS last FROM runtime_session_batches b,'
      +' (SELECT min(start_revision) s0 FROM runtime_session_batches WHERE execution_id=$1) z WHERE execution_id=$1 ORDER BY batch',[f.execution])).rows,
    history:(await db.query('SELECT h.revision-z.s0 AS rev,item,internal_control FROM runtime_session_history h,'
      +' (SELECT min(start_revision) s0 FROM runtime_session_batches WHERE execution_id=$1) z WHERE execution_id=$1 ORDER BY revision',[f.execution])).rows,
    revision:(await db.query('SELECT s.revision-z.s0 AS r FROM runtime_sessions s,(SELECT min(start_revision) s0 FROM runtime_session_batches WHERE execution_id=$2) z WHERE s.id=$1',[f.session,f.execution])).rows[0].r,
  });
  const owner=(f,value)=>rpc(db,'runtime_execution',f.actor,f.execution,'owner_session',{epoch:1,value});
  const freeze=f=>owner(f,{action:'freeze',items:[]});

  // Same result as one append per batch.
  const single=await setup();await freeze(single);
  await owner(single,{action:'append',items:[user],batch:0});
  await owner(single,{action:'append',items:[reply],batch:1});
  const many=await setup();await freeze(many);
  assert.equal(await owner(many,{action:'append_batches',items:[[user],[reply]],batch:0}),null);
  assert.deepEqual(await state(many),await state(single));
  assert.equal(Number((await state(many)).revision),2);
  report.checks.push('DB-PERF 0400: append_batches saves the same batches, history and Session revision as one append per batch');

  // An identical repeat (lost acknowledgement) is a replay; a later single append continues the order.
  const before=await state(many);
  assert.equal(await owner(many,{action:'append_batches',items:[[user],[reply]],batch:0}),null);
  assert.deepEqual(await state(many),before);
  await owner(many,{action:'append',items:[extra],batch:2});
  assert.equal((await state(many)).batches.length,3);
  report.checks.push('DB-PERF 0400: a repeated append_batches is a replay; later single appends continue the batch order');

  // A different batch conflicts and nothing of the call is saved; a gap is refused; sizes are bounded.
  const mixed=await setup();await freeze(mixed);
  await owner(mixed,{action:'append',items:[user],batch:0});
  await assert.rejects(owner(mixed,{action:'append_batches',items:[[{role:'user',content:'different'}],[reply]],batch:0}),/RUNTIME_SESSION_CONFLICT/);
  assert.equal((await state(mixed)).batches.length,1,'a conflicting call saves none of its batches');
  await assert.rejects(owner(mixed,{action:'append_batches',items:[[reply]],batch:2}),/RUNTIME_SESSION_BATCH_ORDER/);
  await assert.rejects(owner(mixed,{action:'append_batches',items:[],batch:1}),/RUNTIME_SESSION_BATCH/);
  await assert.rejects(owner(mixed,{action:'append_batches',items:Array.from({length:33},()=>[reply]),batch:1}),/RUNTIME_SESSION_BATCH/);
  await assert.rejects(owner(mixed,{action:'append_batches',items:[[reply],Array.from({length:129},()=>reply)],batch:1}),/RUNTIME_SESSION_BATCH/);
  assert.equal((await state(mixed)).batches.length,1,'refused calls save nothing');
  // The saved first batch plus new ones in one call: replay of batch 0, then batch 1 written.
  await owner(mixed,{action:'append_batches',items:[[user],[reply]],batch:0});
  assert.deepEqual((await state(mixed)).batches.map(b=>b.batch),[0,1]);
  report.checks.push('DB-PERF 0400: append_batches conflict, gap, empty and oversize calls save nothing; a saved prefix replays');

  // Closed rounds and other actors are refused exactly like append.
  const closed=await setup();await freeze(closed);
  await db.query('UPDATE bill2_runs SET cancel_requested=true WHERE id=$1',[closed.run]);
  await assert.rejects(owner(closed,{action:'append_batches',items:[[user]],batch:0}),/RUNTIME_SESSION_CLOSED|RUNTIME_EXECUTION_CANCELLED|RUNTIME_RESUME_CONFLICT/);
  await assert.rejects(rpc(db,'runtime_session_items',closed.actor,closed.session,closed.execution,'append_batches',JSON.stringify([[user]]),null,0),/RUNTIME_SESSION_CLOSED/);
  const other=await setup();
  await assert.rejects(rpc(db,'runtime_session_items',other.actor,many.session,many.execution,'append_batches',JSON.stringify([[user]]),null,3),/RUNTIME_SESSION_DENIED|BILL2/);
  report.checks.push('DB-PERF 0400: append_batches refuses closed rounds and other actors like append');
}
