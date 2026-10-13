/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// FUSION-REVIEW PR-3a (0235): sessionless Fusion outputs, recovery batch, conversation deletion and
// account erasure coverage.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';

const wallet = async (db,actor) => (await db.query('SELECT credits FROM profiles WHERE id=$1',[actor])).rows[0].credits;
const calls = async (db,runs) => (await db.query('SELECT * FROM bill2_calls WHERE run_id=ANY($1::uuid[]) ORDER BY run_id',[runs])).rows;
const charged = async (db,runs) => Number((await db.query('SELECT coalesce(sum(charged),0) v FROM bill2_runs WHERE id=ANY($1::uuid[])',[runs])).rows[0].v);
const outputs = async (db,actor) => Number((await db.query('SELECT count(*) v FROM fusion_call_outputs WHERE actor_id=$1',[actor])).rows[0].v);

async function sessionGroup(db,createFixture,{n=2,credits=18}={}) {
  const first = await createFixture(db,{credits,phase:'fusion_review'});
  const members = [first];
  for (let i=1;i<n;i++) members.push(await createFixture(db,{actor:first.actor,phase:'fusion_review'}));
  const session = randomUUID();
  await db.query("INSERT INTO runtime_sessions(id,actor_id,scope,start_request_id,start_payload) VALUES($1,$2,$3,$4,'{}')",
    [session,first.actor,first.payload.scope,randomUUID()]);
  const id = await rpc(db,'fusion_group_create',first.actor,randomUUID(),'review',session);
  for (const f of members) await rpc(db,'fusion_group_attach',first.actor,id,f.run);
  const items = members.map(f=>({runId:f.run,sequence:1,payload:f.claimPayload}));
  const claimed = await rpc(db,'fusion_group_claim',first.actor,id,'review:1',1,JSON.stringify(items));
  assert.equal(claimed.state,'claimed');
  for (const c of claimed.calls) assert.equal((await rpc(db,'bill2_dispatch',first.actor,c.runId,c.id,c.dispatchToken)).dispatch,true);
  return {actor:first.actor,id,session,members,runs:members.map(f=>f.run),calls:claimed.calls};
}
const receipt = (db,g,f,c,cost='0.0004') => rpc(db,'bill2_record',g.actor,f.run,c.id,{provider:f.claimPayload.provider,account:'sandbox',
  model:f.claimPayload.model,protocol:f.claimPayload.protocol,providerId:'generation-'+c.id,source:'response',sourceHash:'c'.repeat(64),
  observedAt:new Date().toISOString(),coverage:'request_total',final:true,cost,currency:'USD',usage:{inputTokens:Math.round(Number(cost)*1e6),outputTokens:0}});
const callOf = (g,f) => g.calls.find(c=>c.runId===f.run);

export async function fusionSessionlessCases({db,report,createFixture}) {
  // Saved output: idempotent, conflicting body refused, readable while the conversation exists.
  const g = await sessionGroup(db,createFixture);
  const c0 = callOf(g,g.members[0]);
  const saved = await rpc(db,'fusion_call_output_save',g.actor,c0.id,'review A');
  assert.equal(saved.bodyHash,createHash('sha256').update('review A').digest('hex'));
  assert.equal((await rpc(db,'fusion_call_output_save',g.actor,c0.id,'review A')).bodyHash,saved.bodyHash);
  await assert.rejects(rpc(db,'fusion_call_output_save',g.actor,c0.id,'other'),/FUSION_OUTPUT_CONFLICT/);
  await assert.rejects(rpc(db,'fusion_call_output_save',randomUUID(),c0.id,'review A'),/./);
  assert.equal((await rpc(db,'fusion_call_output_read',g.actor,c0.id)).body,'review A');
  report.checks.push('Fusion output save is idempotent, refuses a different body and another user; readable while the conversation exists');

  // Unjudged at the recovery deadline: a saved Fusion output is billed like usable; none is no_delivery.
  for (const f of g.members) await receipt(db,g,f,callOf(g,f));
  await db.query("UPDATE bill2_calls SET recovery_deadline=now()-interval '1 second' WHERE run_id=ANY($1::uuid[])",[g.runs]);
  for (const r of g.runs) await rpc(db,'bill2_finalize',g.actor,r);
  const verdicts = Object.fromEntries((await calls(db,g.runs)).map(c=>[c.id,c.fusion_verdict]));
  assert.equal(verdicts[c0.id],'unjudged_saved');
  assert.equal(verdicts[callOf(g,g.members[1]).id],'no_delivery');
  assert.equal(await charged(db,g.runs),1,'only the call with a saved Fusion output is charged');
  await assert.rejects(rpc(db,'fusion_call_output_save',g.actor,callOf(g,g.members[1]).id,'too late'),/FUSION_OUTPUT_DENIED/);
  report.checks.push('unjudged at deadline: saved Fusion output (no runtime execution) bills as unjudged_saved; no output is no_delivery; '+
    'a body arriving after that settlement is refused');

  // A verdict must match the saved body: body verdicts need it, no_delivery needs its absence.
  const v = await sessionGroup(db,createFixture,{n:2,credits:18});
  const [v0,v1] = v.members.map(f=>callOf(v,f));
  for (const verdict of ['usable','format_invalid','revision_invalid'])
    await assert.rejects(rpc(db,'fusion_call_verdict',v.actor,v0.id,verdict),/FUSION_VERDICT_DENIED/);
  await rpc(db,'fusion_call_output_save',v.actor,v1.id,'saved body');
  await assert.rejects(rpc(db,'fusion_call_verdict',v.actor,v1.id,'no_delivery'),/FUSION_VERDICT_DENIED/);
  assert.equal(await rpc(db,'fusion_call_verdict',v.actor,v0.id,'no_delivery'),'no_delivery');
  assert.equal(await rpc(db,'fusion_call_verdict',v.actor,v1.id,'usable'),'usable');
  report.checks.push('verdicts are checked against the saved output: no body verdict without a body, no no_delivery with one');

  // Recovery batch lists grouped runs with unsettled calls only.
  const pending = await sessionGroup(db,createFixture,{n:1,credits:9});
  const rows = (await db.query('SELECT * FROM fusion_pending_financial_batch(200)')).rows;
  const listed = rows.find(r=>r.run_id===pending.runs[0]);
  assert.ok(listed && listed.call_id===pending.calls[0].id && listed.actor_id===pending.actor && listed.dispatched===true);
  assert.ok(listed.dispatch_deadline instanceof Date && listed.recovery===null,'isolated fixture runs carry no staging binding');
  assert.ok(!rows.some(r=>r.run_id===g.runs[0]),'settled group runs are not listed');
  report.checks.push('fusion_pending_financial_batch lists unsettled sessionless group calls with dispatch state, deadline and binding');

  // Paging: a cursor moves past calls that cannot progress; undispatched calls wait for their dispatch deadline.
  const paged = await sessionGroup(db,createFixture,{n:2,credits:18});
  // Timestamps travel as text (as PostgREST returns them), keeping microseconds for the cursor.
  const pageRows = (await db.query('SELECT call_id,run_id,created_at::text created FROM fusion_pending_financial_batch(200)')).rows
    .filter(r=>paged.runs.includes(r.run_id));
  assert.equal(pageRows.length,2);
  const firstRow = pageRows[0];
  const nextPage = (await db.query('SELECT * FROM fusion_pending_financial_batch(200,$1,$2)',[firstRow.created,firstRow.call_id])).rows;
  assert.ok(!nextPage.some(r=>r.call_id===firstRow.call_id) && nextPage.some(r=>paged.runs.includes(r.run_id)));
  const fresh = await createFixture(db,{credits:9,phase:'fusion_review'});
  const freshSession = randomUUID();
  await db.query("INSERT INTO runtime_sessions(id,actor_id,scope,start_request_id,start_payload) VALUES($1,$2,$3,$4,'{}')",
    [freshSession,fresh.actor,fresh.payload.scope,randomUUID()]);
  const freshGroup = await rpc(db,'fusion_group_create',fresh.actor,randomUUID(),'review',freshSession);
  await rpc(db,'fusion_group_attach',fresh.actor,freshGroup,fresh.run);
  const freshClaim = await rpc(db,'fusion_group_claim',fresh.actor,freshGroup,'review:1',1,
    JSON.stringify([{runId:fresh.run,sequence:1,payload:fresh.claimPayload}]));
  const listedFresh = async () => (await db.query('SELECT * FROM fusion_pending_financial_batch(200)')).rows.some(r=>r.run_id===fresh.run);
  assert.equal(await listedFresh(),false,'an undispatched call before its dispatch deadline is not listed');
  await db.query("UPDATE bill2_calls SET dispatch_deadline=now()-interval '1 second' WHERE id=$1",[freshClaim.calls[0].id]);
  assert.equal(await listedFresh(),true);
  report.checks.push('recovery batch pages by (created_at, id) and lists undispatched calls only after their dispatch deadline');

  // Deleting the source conversation deletes its Fusion outputs, scrubs the runs and leaves no hold.
  const del = await sessionGroup(db,createFixture,{n:2,credits:18});
  const d0 = callOf(del,del.members[0]);
  await rpc(db,'fusion_call_output_save',del.actor,d0.id,'to be deleted');
  await receipt(db,del,del.members[0],d0);
  await rpc(db,'content_erasure_mark_session',del.actor,del.session);
  assert.equal(await outputs(db,del.actor),0,'outputs of the deleted conversation are gone');
  assert.equal(await rpc(db,'fusion_call_output_read',del.actor,d0.id),null);
  await assert.rejects(rpc(db,'fusion_call_output_save',del.actor,callOf(del,del.members[1]).id,'late'),/FUSION_OUTPUT_DENIED/);
  const runs = (await db.query('SELECT content_deleted_at,closed FROM bill2_runs WHERE id=ANY($1::uuid[])',[del.runs])).rows;
  assert.ok(runs.every(r=>r.content_deleted_at!==null && r.closed),'group runs marked and closed');
  const scrubbed = (await db.query(`SELECT r.content_erased_at run_at,c.content_erased_at call_at FROM bill2_runs r
    JOIN bill2_calls c ON c.run_id=r.id WHERE r.id=ANY($1::uuid[])`,[del.runs])).rows;
  assert.ok(scrubbed.length===2 && scrubbed.every(x=>x.run_at && x.call_at),'run and call payloads are scrubbed, even without a receipt');
  // Content deletion cancels the runs: like BILL2 cancel-after-dispatch, a known cost is billed (user_stopped),
  // and a call without a receipt keeps its hold until the late receipt (or recovery) settles it.
  const after = Object.fromEntries((await calls(db,del.runs)).map(c=>[c.id,c]));
  const d1 = callOf(del,del.members[1]);
  assert.equal(after[d0.id].fusion_verdict,'user_stopped');assert.equal(after[d0.id].charged_delta,1);
  assert.equal(after[d1.id].settled_at,null);assert.equal(await wallet(db,del.actor),8);
  await receipt(db,del,del.members[1],d1);
  await rpc(db,'bill2_finalize',del.actor,del.members[1].run);
  const late = (await calls(db,[del.members[1].run]))[0];
  assert.equal(late.fusion_verdict,'user_stopped');assert.ok(late.settled_at);
  assert.equal(await wallet(db,del.actor),16,'late receipt settles at known cost and releases the rest of the hold');
  await assert.rejects(rpc(db,'fusion_group_create',del.actor,randomUUID(),'review',del.session),/FUSION_GROUP_DENIED/);
  report.checks.push('deleting the source conversation deletes its Fusion outputs, closes and scrubs the group runs (user_stopped at known cost; late receipt settles), refuses new outputs and groups');

  // A run cannot join a group whose source conversation was deleted.
  const extra = await createFixture(db,{actor:del.actor,phase:'fusion_review'});
  await assert.rejects(rpc(db,'fusion_group_attach',del.actor,del.id,extra.run),/FUSION_GROUP_DENIED/);
  // A run already closed as delivered but not yet judged settles as user_stopped when its conversation is deleted.
  const closed = await sessionGroup(db,createFixture,{n:1,credits:9});
  const cc = callOf(closed,closed.members[0]);
  await receipt(db,closed,closed.members[0],cc);
  await rpc(db,'fusion_call_output_save',closed.actor,cc.id,'delivered body');
  await rpc(db,'bill2_close',closed.actor,closed.runs[0],'delivered',{kind:'usable_result',evidenceRef:'fusion-output',
    evidenceHash:'d'.repeat(64)});
  await rpc(db,'content_erasure_mark_session',closed.actor,closed.session);
  const settledClosed = (await calls(db,closed.runs))[0];
  assert.equal(settledClosed.fusion_verdict,'user_stopped');assert.ok(settledClosed.settled_at);
  assert.equal(await wallet(db,closed.actor),8,'known cost billed, rest of the hold released at deletion');
  report.checks.push('attach refused after source deletion; a closed-but-unjudged run settles as user_stopped on deletion');

  // Account erasure removes Fusion outputs and counts them as remaining body until then.
  const acct = await sessionGroup(db,createFixture,{n:1,credits:9});
  await rpc(db,'fusion_call_output_save',acct.actor,callOf(acct,acct.members[0]).id,'account body');
  assert.equal(Number((await db.query('SELECT account_erasure_body_remaining($1) v',[acct.actor])).rows[0].v)>=1,true);
  await closeAccount(db,{actor:acct.actor});
  await db.query('SELECT account_erasure_scrub_content($1)',[acct.actor]);
  assert.equal(await outputs(db,acct.actor),0);
  report.checks.push('account erasure removes Fusion outputs; body-remaining proof counts them until removed');

  // The sourceless 0234 group form is not callable by the service role.
  await db.query('SET ROLE service_role');
  try { await assert.rejects(db.query("SELECT fusion_group_create($1,$2,'review')",[g.actor,randomUUID()]),/permission denied/); }
  finally { await db.query('RESET ROLE'); }
  report.checks.push('service role must bind a group to a source conversation');
}
