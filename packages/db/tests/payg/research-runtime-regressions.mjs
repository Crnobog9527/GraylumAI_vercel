/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';
import {toolFixture} from './research-tools.mjs';

// Same cache contract as benchmarkFetch/accountMetrics; raw query/source/call evidence stays in operations.
export const accountEvidence = (ref='op-1',platform='tiktok',account='alpha') => ({
  platform,account,fetchedAt:'2026-10-15T00:00:00.000Z',
  metrics:{followers:{value:12000,refs:[ref+'#1']},postsAnalyzed:0,
    medianViews:{value:null,refs:[]},engagementRate:{value:null,refs:[]},postsPerWeek:{value:null,refs:[]},
    lastPublishedAt:{value:null,refs:[]},earliestPublishedAt:{value:null,refs:[]},wholeHistory:false,
    missing:['medianViews','engagementRate','postsPerWeek','lastPublishedAt']},
  classification:{category:null,qualified:false,excluded:'NO_POSTS'},
});
async function fixture(db,createFixture) {
  const f=await toolFixture(createFixture,{db});
  const execution=(await db.query('SELECT b2a_test.bind($1) v',[f])).rows[0].v;
  const session=(await db.query('SELECT session_id v FROM runtime_executions WHERE id=$1',[execution])).rows[0].v;
  return {...f,execution,session};
}
async function answer(db,f) {
  const id=randomUUID();
  await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state)
    VALUES($1,$2,$3,gen_random_uuid(),'{}',0,'interrupted')`,[id,f.actor,f.session]);
  return id;
}
async function erase(db,f,kind,id) {
  const scope=await rpc(db,'content_erasure_scope',f.actor,kind,id);
  const hash=(await db.query("SELECT encode(sha256(convert_to($1::jsonb::text,'utf8')),'hex') h",[scope])).rows[0].h;
  return rpc(db,'content_erasure_confirm',f.actor,kind,id,hash);
}
async function plan(db,f,discovery=null) {
  const id=randomUUID(),op=randomUUID(),payload={budgetUnits:100,maxOperations:1,
    operations:[{operationId:op,identityHash:'d'.repeat(64),maxQuoteUnits:100}]};
  await rpc(db,'research_runtime_plan_create',f.actor,id,f.session,f.execution,discovery,payload);
  return {id,op};
}
export async function researchRuntimeRegressionCases({db,report,createFixture}) {
  const failures=[];
  const check=async(name,run)=>{try{await run();report.checks.push(name);}catch(error){failures.push(name+': '+error.message);}};
  for(const kind of ['answer','session']) await check('RT-3b unreserved plan erased with '+kind,async()=>{
    const f=await fixture(db,createFixture),p=await plan(db,f);
    await erase(db,f,kind,kind==='answer'?f.execution:f.session);
    const row=(await db.query('SELECT operations,erased_at IS NOT NULL erased FROM research_plans WHERE id=$1',[p.id])).rows[0];
    assert.deepEqual(row,{operations:null,erased:true});
    await assert.rejects(rpc(db,'research_transition','reserve',p.id,f.actor,p.op,{identityHash:'d'.repeat(64),quoteUnits:10}));
    assert.equal((await db.query('SELECT count(*)::int n FROM research_operations WHERE plan_id=$1',[p.id])).rows[0].n,0);
  });
  await check('RT-3b success rejects empty/malformed evidence, accepts the host cache contract',async()=>{
    const f=await fixture(db,createFixture),fetch=await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',null);
    await rpc(db,'research_account_fetch_dispatch',f.actor,fetch.fetchId,fetch.attempt);
    const good=accountEvidence();
    for(const bad of [{},{operations:[]},{...good,metrics:{}},{...good,fetchedAt:'invalid'},
      {...good,account:'other'},{...good,classification:{}}]) {
      await assert.rejects(rpc(db,'research_account_fetch_finish',f.actor,fetch.fetchId,fetch.attempt,'succeeded',bad),/RESEARCH_FETCH_INVALID/);
    }
    await rpc(db,'research_account_fetch_finish',f.actor,fetch.fetchId,fetch.attempt,'succeeded',good);
    assert.deepEqual((await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',null)).evidence,good);
  });
  await check('RT-3b deleting keyword source clears derived discovery, candidate card and unreserved plan',async()=>{
    const f=await fixture(db,createFixture),e2=await answer(db,f),card=randomUUID();
    await rpc(db,'research_card_create',f.actor,card,f.session,f.execution,{kind:'keywords',
      options:['one','two','three'].map((text,i)=>({id:'k'+i,text}))});
    const confirmed=await rpc(db,'research_card_confirm',f.actor,card,{selected:['k0']});
    const d=await rpc(db,'research_discovery_start',f.actor,f.session,e2,confirmed.confirmationId,['tiktok']);
    const p=await plan(db,{...f,execution:e2},d.discoveryId),candidate=randomUUID();
    await rpc(db,'research_card_create',f.actor,candidate,f.session,e2,{kind:'candidates',discoveryId:d.discoveryId,
      followUp:true,minSelect:1,options:[{id:'a',platform:'tiktok',account:'alpha',evidenceRef:'op#1',label:'Alpha',selectable:true}]});
    await erase(db,f,'answer',f.execution);
    assert.equal((await db.query('SELECT count(*)::int n FROM research_discoveries WHERE id=$1',[d.discoveryId])).rows[0].n,0);
    assert.equal((await db.query('SELECT count(*)::int n FROM research_selection_cards WHERE id=$1',[candidate])).rows[0].n,0);
    assert.equal(await rpc(db,'research_runtime_read',f.actor,f.session,e2,'discovery',d.discoveryId),null);
    assert.equal((await db.query('SELECT erased_at IS NOT NULL v FROM research_plans WHERE id=$1',[p.id])).rows[0].v,true);
  });
  await check('RT-3b charged refresh blocks new and unused grants, including after its answer is deleted',async()=>{
    const f=await fixture(db,createFixture),e2=await answer(db,f);
    const fetch=await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',null);
    await rpc(db,'research_account_fetch_dispatch',f.actor,fetch.fetchId,fetch.attempt);
    await rpc(db,'research_account_fetch_finish',f.actor,fetch.fetchId,fetch.attempt,'succeeded',accountEvidence());
    const grant=await rpc(db,'research_refresh_create',f.actor,f.session,'tiktok','alpha');
    const unused=await rpc(db,'research_refresh_create',f.actor,f.session,'tiktok','alpha');
    const retry=await rpc(db,'research_account_fetch_claim',f.actor,f.session,e2,'tiktok','alpha',grant);
    await rpc(db,'research_account_fetch_dispatch',f.actor,fetch.fetchId,retry.attempt);
    await rpc(db,'research_account_fetch_finish',f.actor,fetch.fetchId,retry.attempt,'failed_charged',null);
    const refused=async()=>{
      await assert.rejects(rpc(db,'research_refresh_create',f.actor,f.session,'tiktok','alpha'),/RESEARCH_REFRESH_INVALID/);
      for(const authorization of [grant,unused]) {
        await assert.rejects(rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',authorization),/RESEARCH_REFRESH_INVALID/);
      }
      assert.equal((await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',null)).claimed,false);
    };
    await refused();await erase(db,f,'answer',e2);await refused();
  });
  assert.deepEqual(failures,[],'RT-3b review regressions');
}
