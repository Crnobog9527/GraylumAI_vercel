/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RT-3b PR-2 (0267): nine-tool PAYG ceiling, unsent-operation closeout, per-call credits and subcall display fields.
// Synthetic fixtures; caller supplies the admitted local database.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';
import {claim} from './fixture.mjs';
import {toolFixture,claimTool,toolResult} from './research-tools.mjs';

const denied = /RESEARCH_SCOPE_DENIED|BILL2_ACTOR_DENIED|CONTENT_ERASED/;
async function session(db,createFixture,options={}) {
  const f = await toolFixture(createFixture,{db,...options});
  const execution = (await db.query('SELECT b2a_test.bind($1) v',[f])).rows[0].v;
  const session = (await db.query('SELECT session_id s FROM runtime_executions WHERE id=$1',[execution])).rows[0].s;
  return {...f,execution,session};
}
// One runtime plan + operation, reserved and dispatched on the research side, optionally linked and finished.
async function operation(db,f,{callId=null,dispatch=true,result=null}={}) {
  const id = randomUUID();
  const identityHash = callId
    ? (await db.query("SELECT payload->>'requestHash' h FROM bill2_calls WHERE id=$1",[callId])).rows[0].h : 'a'.repeat(64);
  await rpc(db,'research_runtime_plan_create',f.actor,id,f.session,f.execution,null,
    {budgetUnits:10000,maxOperations:1,operations:[{operationId:id,identityHash,maxQuoteUnits:10000}]});
  const reserved = await rpc(db,'research_transition','reserve',id,f.actor,id,{identityHash,quoteUnits:10000});
  if (callId) await rpc(db,'research_runtime_link',f.actor,id,f.session,f.execution,null,id,callId);
  if (dispatch) assert.equal((await rpc(db,'research_transition','dispatch',id,f.actor,id,{token:reserved.token})).dispatch,true);
  if (result) await rpc(db,'research_transition','finish',id,f.actor,id,{token:reserved.token,state:'succeeded',result});
  return id;
}
const state = async (db,id) => (await db.query(`SELECT o.state,o.result IS NULL empty,p.cancelled FROM research_operations o
  JOIN research_plans p ON p.id=o.plan_id WHERE o.id=$1`,[id])).rows[0];
const withTools = (f,tools) => ({payg:{...f.claimPayload.payg,tools}});
const calls = async (db,f) => (await db.query('SELECT count(*)::int n FROM bill2_calls WHERE run_id=$1',[f.run])).rows[0].n;

export async function researchRuntimeWiringCases({db,report,createFixture}) {
  // Nine tool definitions per PAYG call; each frozen run still applies its own profile maxTools.
  const nine = await createFixture(db,{maxTools:9});
  await claim(db,nine,1,false,withTools(nine,9));
  assert.equal(await calls(db,nine),1);
  const three = await createFixture(db,{maxTools:3});
  await assert.rejects(claim(db,three,1,false,withTools(three,4)));
  const ten = await createFixture(db,{maxTools:10});
  await assert.rejects(claim(db,ten,1,false,withTools(ten,10)));
  assert.equal(await calls(db,three)+await calls(db,ten),0);
  report.checks.push('0267: a 9-tool run claims nine tools; a 3-tool run still refuses a fourth; ten stay refused before any hold');

  // An operation dispatched without a result or BILL2 link was never sent: closed once as cancelled.
  const f = await session(db,createFixture,{multiplier:'1.25'});
  const other = await session(db,createFixture);
  const stuck = await operation(db,f);
  await db.query('SET ROLE service_role');
  try {
    await assert.rejects(rpc(db,'research_runtime_close_unsent',other.actor,f.session,stuck),denied);
    assert.equal(await rpc(db,'research_runtime_close_unsent',other.actor,other.session,stuck),false);
    assert.equal(await rpc(db,'research_runtime_close_unsent',f.actor,f.session,stuck),true);
    assert.equal(await rpc(db,'research_runtime_close_unsent',f.actor,f.session,stuck),false,'idempotent: already closed');
  } finally { await db.query('RESET ROLE'); }
  assert.deepEqual(await state(db,stuck),{state:'cancelled',empty:true,cancelled:true});
  report.checks.push('0267: dispatched + no result + no link closes once as cancelled (plan cancelled); other actors/sessions cannot close it');

  // A linked (possibly sent) or finished operation is never closed; a prepared one is left for the normal path.
  const c = await claimTool(db,f,1);
  const linked = await operation(db,f,{callId:c.id});
  const finished = await operation(db,f,{result:{toolName:'web_search',items:[]}});
  const prepared = await operation(db,f,{dispatch:false});
  await db.query('SET ROLE service_role');
  try {
    for (const id of [linked,finished,prepared]) assert.equal(await rpc(db,'research_runtime_close_unsent',f.actor,f.session,id),false);
  } finally { await db.query('RESET ROLE'); }
  assert.equal((await state(db,linked)).state,'dispatched');
  assert.equal((await state(db,finished)).state,'succeeded');
  assert.equal((await state(db,prepared)).state,'prepared');
  report.checks.push('0267: linked, finished and prepared operations are never closed by the unsent closeout');

  // The answer's own settled tool call credits, with the frozen multiplier before the run's single ceil.
  await db.query('SET ROLE service_role');
  try {
    const before = await rpc(db,'research_runtime_call_charge',f.actor,f.session,f.execution,c.id);
    assert.deepEqual(before,{source:null,credits:null},'not settled yet');
  } finally { await db.query('RESET ROLE'); }
  await rpc(db,'bill2_record',f.actor,f.run,c.id,toolResult(c,'delivered','1','0.01'));
  await db.query('SET ROLE service_role');
  try {
    const charge = await rpc(db,'research_runtime_call_charge',f.actor,f.session,f.execution,c.id);
    assert.equal(charge.source,'tool_usage');
    assert.equal(Number(charge.credits),1.25);
    assert.deepEqual(Object.keys(charge).sort(),['credits','source']);
    await assert.rejects(rpc(db,'research_runtime_call_charge',other.actor,f.session,f.execution,c.id),denied);
    assert.equal(await rpc(db,'research_runtime_call_charge',other.actor,other.session,other.execution,c.id),null);
  } finally { await db.query('RESET ROLE'); }
  for (const role of ['anon','authenticated']) {
    await db.query('SET ROLE '+role);
    try {
      await assert.rejects(rpc(db,'research_runtime_call_charge',f.actor,f.session,f.execution,c.id),/permission denied/);
      await assert.rejects(rpc(db,'research_runtime_close_unsent',f.actor,f.session,stuck),/permission denied/);
    } finally { await db.query('RESET ROLE'); }
  }
  report.checks.push('0267: call credits = unrounded frozen nominal (1.25), null before settlement; scoped to the answer; host-only');

  // Charges and evidence return each subcall's own query / platform / dataKind; rows without them return null.
  const g = await session(db,createFixture);
  const d = await claimTool(db,g,1);
  await rpc(db,'bill2_record',g.actor,g.run,d.id,toolResult(d,'delivered','1','0.01'));
  const call = {query:'alice',platform:'tiktok',dataKind:'account_posts'};
  const id = randomUUID();
  const identityHash = (await db.query("SELECT payload->>'requestHash' h FROM bill2_calls WHERE id=$1",[d.id])).rows[0].h;
  await rpc(db,'research_runtime_plan_create',g.actor,id,g.session,g.execution,null,
    {budgetUnits:10000,maxOperations:1,operations:[{operationId:id,identityHash,maxQuoteUnits:10000}]});
  const reserved = await rpc(db,'research_transition','reserve',id,g.actor,id,{identityHash,quoteUnits:10000});
  await rpc(db,'research_runtime_link',g.actor,id,g.session,g.execution,null,id,d.id);
  await rpc(db,'research_transition','dispatch',id,g.actor,id,{token:reserved.token});
  await rpc(db,'research_transition','finish',id,g.actor,id,{token:reserved.token,state:'succeeded',
    result:{toolName:'benchmark_fetch',args:{accounts:[{platform:'tiktok',account:'alice'}]},call,items:[],fetchedAt:'2026-10-16T00:00:00Z',truncated:false}});
  await operation(db,g,{result:{toolName:'web_search',args:{query:'old row'},items:[]}});
  const tx = (await db.query(`SELECT id FROM credit_transactions WHERE user_id=$1 AND bill2_run_id=$2
    AND reason_code='bill2_spend' ORDER BY created_at,id LIMIT 1`,[g.actor,g.run])).rows[0].id;
  await db.query('SET ROLE service_role');
  try {
    const charges = await rpc(db,'research_user_tool_charges',g.actor,tx);
    assert.equal(charges.length,1);
    assert.deepEqual({query:charges[0].query,platform:charges[0].platform,dataKind:charges[0].dataKind},call);
    const evidence = await rpc(db,'research_user_evidence',g.actor,10,null,null);
    const fresh = evidence.find(row=>row.operationId===id);
    assert.deepEqual({query:fresh.query,platform:fresh.platform,dataKind:fresh.dataKind},call);
    const old = evidence.find(row=>row.operationId!==id);
    assert.deepEqual({query:old.query,platform:old.platform,dataKind:old.dataKind},{query:null,platform:null,dataKind:null});
    assert.doesNotMatch(JSON.stringify([charges,evidence]),/cost|supplier|provider/i);
  } finally { await db.query('RESET ROLE'); }
  report.checks.push('0267: toolCharges and evidence rows carry the subcall\'s own query/platform/dataKind; older rows return null');
}
