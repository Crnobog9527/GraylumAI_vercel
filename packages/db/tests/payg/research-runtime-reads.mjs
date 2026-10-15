/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RT-3b host reads and user projections. Synthetic fixtures; caller supplies the admitted local database.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';
import {toolFixture,claimTool,toolResult} from './research-tools.mjs';

const keywords = [{id:'k1',text:'收纳'},{id:'k2',text:'租房'},{id:'k3',text:'小户型'}];
const denied = /RESEARCH_SCOPE_DENIED|BILL2_ACTOR_DENIED|CONTENT_ERASED/;
async function session(db,createFixture,options={}) {
  const f = await toolFixture(createFixture,{db,...options});
  const execution = (await db.query('SELECT b2a_test.bind($1) v',[f])).rows[0].v;
  const session = (await db.query('SELECT session_id s FROM runtime_executions WHERE id=$1',[execution])).rows[0].s;
  return {...f,execution,session};
}
async function operation(db,f,callId=null) {
  const id = randomUUID();
  const identityHash = callId
    ? (await db.query("SELECT payload->>'requestHash' h FROM bill2_calls WHERE id=$1",[callId])).rows[0].h
    : 'a'.repeat(64);
  await rpc(db,'research_runtime_plan_create',f.actor,id,f.session,f.execution,null,
    {budgetUnits:10000,maxOperations:1,operations:[{operationId:id,identityHash,maxQuoteUnits:10000}]});
  const reserved = await rpc(db,'research_transition','reserve',id,f.actor,id,{identityHash,quoteUnits:10000});
  await rpc(db,'research_transition','dispatch',id,f.actor,id,{token:reserved.token});
  const result = {toolName:'web_search',args:{query:'test query'},items:[{url:'https://example.com/source',body:'PRIVATE_BODY'}],
    fetchedAt:'2026-10-15T00:00:00.000Z',truncated:false,cost:{actual:0.01},supplierSecret:'PRIVATE_SECRET'};
  await rpc(db,'research_transition','finish',id,f.actor,id,{token:reserved.token,state:'succeeded',result});
  if (callId) await rpc(db,'research_runtime_link',f.actor,id,f.session,f.execution,null,id,callId);
  return {id,result};
}
async function host(db,f,kind,id) {
  return rpc(db,'research_runtime_read',f.actor,f.session,f.execution,kind,id);
}
async function cardsAndDiscovery(db,f) {
  const card = randomUUID();
  await rpc(db,'research_card_create',f.actor,card,f.session,f.execution,{kind:'keywords',options:keywords});
  const confirmed = await rpc(db,'research_card_confirm',f.actor,card,{selected:['k1']});
  const discovery = await rpc(db,'research_discovery_start',f.actor,f.session,f.execution,confirmed.confirmationId,['tiktok']);
  const candidates = randomUUID();
  await rpc(db,'research_card_create',f.actor,candidates,f.session,f.execution,
    {kind:'candidates',discoveryId:discovery.discoveryId,followUp:true,minSelect:1,
      options:[{id:'c1',platform:'tiktok',account:'alpha',evidenceRef:'e1',label:'Alpha',selectable:true}]});
  await rpc(db,'research_card_confirm',f.actor,candidates,{selected:['c1']});
  return {card,candidates,discovery:discovery.discoveryId};
}

export async function researchRuntimeReadCases({db,report,createFixture}) {
  // Every projection is callable only by the host role, including valid actor ids supplied by clients.
  const f = await session(db,createFixture,{multiplier:'1.25'});
  const other = await session(db,createFixture);
  const sameActor = await session(db,createFixture,{actor:f.actor});
  const c = await claimTool(db,f,1);
  await rpc(db,'bill2_record',f.actor,f.run,c.id,toolResult(c,'delivered','1','0.01'));
  const op = await operation(db,f,c.id);
  const records = await cardsAndDiscovery(db,f);
  const tx = (await db.query(`SELECT id FROM credit_transactions WHERE user_id=$1 AND bill2_run_id=$2
    AND reason_code='bill2_spend' ORDER BY created_at,id LIMIT 1`,[f.actor,f.run])).rows[0]?.id;
  assert.ok(tx,'settled tool call has a user ledger transaction');
  const calls = [
    ['research_runtime_read',f.actor,f.session,f.execution,'operation',op.id],
    ['research_user_tool_charges',f.actor,tx],
    ['research_user_evidence',f.actor,10,null,null],
    ['research_user_cards',f.actor,f.session],
  ];
  for (const role of ['anon','authenticated']) {
    await db.query('SET ROLE '+role);
    try { for (const [name,...args] of calls) await assert.rejects(rpc(db,name,...args),/permission denied/); }
    finally { await db.query('RESET ROLE'); }
  }
  await db.query('SET ROLE service_role');
  try {
    assert.deepEqual((await host(db,f,'operation',op.id)).result,op.result);
    assert.equal((await host(db,f,'operation',op.id)).executionId,f.execution);
    assert.equal((await host(db,f,'plan',op.id)).executionId,f.execution);
    assert.equal((await host(db,f,'card',records.card)).cardId,records.card);
    assert.equal((await host(db,f,'discovery',records.discovery)).discoveryId,records.discovery);
    assert.equal((await host(db,f,'selected',records.discovery))[0].account,'alpha');
    assert.equal((await rpc(db,'research_user_cards',f.actor,f.session)).length,2);
    assert.equal((await rpc(db,'research_user_evidence',f.actor,10,null,null)).length,1);
    const charges = await rpc(db,'research_user_tool_charges',f.actor,tx);
    assert.equal(charges.length,1);
    assert.deepEqual(Object.keys(charges[0]).sort(),['args','callId','credits','source','toolName']);
    assert.equal(charges[0].callId,c.id);
    assert.equal(charges[0].source,'tool_usage');
    assert.equal(Number(charges[0].credits),1.25,'unrounded frozen nominal contribution, not the integer ledger deduction');
    assert.equal(charges[0].toolName,'web_search');
    assert.deepEqual(charges[0].args,{query:'test query'});
    assert.doesNotMatch(JSON.stringify(charges),/PRIVATE_BODY|PRIVATE_SECRET|cost|multiplier|price|provider|supplier/i);
    await assert.rejects(rpc(db,'research_user_tool_charges',other.actor,tx),denied);
    await assert.rejects(rpc(db,'research_user_cards',other.actor,f.session),denied);
    await assert.rejects(rpc(db,'research_runtime_read',other.actor,f.session,f.execution,'card',records.card),denied);
    for (const foreign of [other,sameActor]) {
      for (const [kind,id] of [['operation',op.id],['plan',op.id],['card',records.card],['discovery',records.discovery]]) {
        assert.equal(await host(db,foreign,kind,id),null,kind+': no cross-session read');
      }
      assert.deepEqual(await host(db,foreign,'selected',records.discovery),[]);
    }
    assert.deepEqual(await rpc(db,'research_user_evidence',other.actor,10,null,null),[]);
    await assert.rejects(host(db,f,'invalid_kind',op.id),/RESEARCH_READ_INVALID/);
  } finally { await db.query('RESET ROLE'); }
  report.checks.push('RT-3b reads: host-only RPCs; actor and session isolation; user charge whitelist and unrounded 1.25-credit contribution');

  // Stable keyset ordering when timestamps tie, with no duplicates or omissions.
  const extra = [await operation(db,f),await operation(db,f)];
  const ids = [op.id,...extra.map(x=>x.id)];
  await db.query("UPDATE research_operations SET created_at='2026-10-15T00:00:00Z' WHERE id=ANY($1::uuid[])",[ids]);
  const first = await rpc(db,'research_user_evidence',f.actor,2,null,null);
  const last = first.at(-1);
  const second = await rpc(db,'research_user_evidence',f.actor,2,last.createdAt,last.operationId);
  assert.deepEqual([...first,...second].map(x=>x.operationId),[...ids].sort().reverse());
  assert.deepEqual(await rpc(db,'research_user_evidence',f.actor,2,last.createdAt,last.operationId),second);
  assert.deepEqual(Object.keys(first[0]).sort(),['operationId','toolName','args','state','fetchedAt','itemCount','truncated',
    'sources','sessionId','sessionTitle','createdAt'].sort());
  assert.deepEqual(first[0].sources,['https://example.com/source']);
  assert.equal(first[0].itemCount,1);
  assert.doesNotMatch(JSON.stringify(first),/PRIVATE_BODY|PRIVATE_SECRET|cost|supplier/i);
  for (const args of [[0,null,null],[102,null,null],[2,last.createdAt,null],[2,null,last.operationId]]) {
    await assert.rejects(rpc(db,'research_user_evidence',f.actor,...args),denied);
  }
  report.checks.push('RT-3b evidence projection: explicit public fields, no raw body or supplier cost; tied timestamp pagination stable and complete');

  // A used refresh is readable as resumable only while its own attempt is still prepared.
  const fetch = await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',null);
  await rpc(db,'research_account_fetch_dispatch',f.actor,fetch.fetchId,fetch.attempt);
  await rpc(db,'research_account_fetch_finish',f.actor,fetch.fetchId,fetch.attempt,'succeeded',{operations:[op.id]});
  const grant = await rpc(db,'research_refresh_create',f.actor,f.session,'tiktok','alpha');
  assert.equal((await host(db,f,'refresh',grant)).used,false);
  assert.equal(await host(db,other,'refresh',grant),null);
  assert.equal(await host(db,sameActor,'refresh',grant),null);
  const refresh = await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',grant);
  assert.equal((await host(db,f,'refresh',grant)).used,false,'prepared consumed grant is recoverable');
  await rpc(db,'research_account_fetch_dispatch',f.actor,refresh.fetchId,refresh.attempt);
  assert.equal((await host(db,f,'refresh',grant)).used,true,'sent refresh cannot be reused');
  report.checks.push('RT-3b refresh reads: same-grant prepared recovery allowed; dispatched refresh remains used; foreign sessions see no grant');

  // A live sibling answer must not expose the deleted source answer before asynchronous cleanup.
  const sibling = randomUUID();
  await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state)
    VALUES($1,$2,$3,gen_random_uuid(),'{}',0,'interrupted')`,[sibling,f.actor,f.session]);
  await db.query(`UPDATE runtime_executions SET content_deleted_at=now(),
    payload=jsonb_build_object('input',payload->'input'),result=NULL,primary_result=NULL,match_result=NULL,
    unavailable_reason='content_deleted' WHERE id=$1`,[f.execution]);
  const live = {...f,execution:sibling};
  for (const [kind,id] of [['operation',op.id],['plan',op.id],['card',records.card],['discovery',records.discovery],['refresh',grant]]) {
    assert.equal(await host(db,live,kind,id),null,kind+': deleted source answer hidden');
  }
  assert.deepEqual(await host(db,live,'selected',records.discovery),[]);
  assert.deepEqual(await rpc(db,'research_user_cards',f.actor,f.session),[]);
  assert.deepEqual(await rpc(db,'research_user_evidence',f.actor,10,null,null),[]);
  assert.deepEqual(await rpc(db,'research_user_tool_charges',f.actor,tx),[]);
  await rpc(db,'content_erasure_mark_session',f.actor,f.session);
  await assert.rejects(host(db,live,'operation',op.id),denied);
  await assert.rejects(rpc(db,'research_user_cards',f.actor,f.session),denied);
  assert.deepEqual(await rpc(db,'research_user_evidence',f.actor,10,null,null),[]);
  assert.deepEqual(await rpc(db,'research_user_tool_charges',f.actor,tx),[]);
  report.checks.push('RT-3b reads hide marked answers through live sibling executions and hide marked sessions before physical cleanup');
}
