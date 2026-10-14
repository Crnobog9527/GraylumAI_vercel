/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RESEARCH-TOOLS RT-3b storage (0263): selection cards, discoveries, one paid fetch per account, refresh grants,
// evidence links, and their erasure. Synthetic fixtures only.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';
import {toolFixture,claimTool,toolResult,toolCallRow} from './research-tools.mjs';

const keywordOptions = [{id:'k1',text:'家居收纳'},{id:'k2',text:'租房改造'},{id:'k3',text:'小户型'}];
const candidate = (id,account,selectable=true) => ({id,platform:'tiktok',account,evidenceRef:'e1#'+id,label:'@'+account,selectable});
const count = async (db,table,where,args) => (await db.query(`SELECT count(*)::int n FROM ${table} WHERE ${where}`,args)).rows[0].n;

/** A run bound to a runtime session/answer (b2a_test.bind) with a tool policy. */
async function session(db,createFixture) {
  const f = await toolFixture(createFixture,{db});
  const execution = (await db.query('SELECT b2a_test.bind($1) v',[f])).rows[0].v;
  const sessionId = (await db.query('SELECT session_id s FROM runtime_executions WHERE id=$1',[execution])).rows[0].s;
  return {...f,execution,session:sessionId};
}
/** A research plan with one operation, linked to the session/answer and (optionally) a BILL2 tool call. */
async function linkedOperation(db,f,callId,finish) {
  const plan = randomUUID(), op = randomUUID(), identityHash = 'a'.repeat(64);
  await rpc(db,'research_transition','create',plan,f.actor,null,{budgetUnits:1000,maxOperations:1,
    operations:[{operationId:op,identityHash,maxQuoteUnits:100}]});
  const reserved = await rpc(db,'research_transition','reserve',plan,f.actor,op,{identityHash,quoteUnits:10});
  assert.equal((await rpc(db,'research_transition','dispatch',plan,f.actor,op,{token:reserved.token})).dispatch,true);
  if (finish) await rpc(db,'research_transition','finish',plan,f.actor,op,{token:reserved.token,state:finish,
    result:{items:[{fields:{followers:12000}}],query:'PRIVATE_QUERY',cost:{actual:0}}});
  await rpc(db,'research_runtime_link',f.actor,plan,f.session,f.execution,null,op,callId);
  return {plan,op};
}

export async function researchRuntimeCases({db,report,createFixture}) {
  // Keyword card: selection, edits and additions; confirmed once; the same submission replays.
  {
    const f = await session(db,createFixture);
    const card = randomUUID();
    await rpc(db,'research_card_create',f.actor,card,f.session,f.execution,{kind:'keywords',options:keywordOptions});
    await assert.rejects(rpc(db,'research_card_create',f.actor,randomUUID(),f.session,f.execution,
      {kind:'keywords',options:keywordOptions.slice(0,2)}),/RESEARCH_CARD_INVALID/);
    await assert.rejects(rpc(db,'research_card_create',randomUUID(),randomUUID(),f.session,f.execution,
      {kind:'keywords',options:keywordOptions}),/BILL2_ACTOR_DENIED|RESEARCH_SCOPE_DENIED/);
    const submit = {selected:['k1','k3'],edits:{k3:'小户型收纳'},additions:['宿舍好物']};
    await assert.rejects(rpc(db,'research_card_confirm',f.actor,card,{selected:['k1'],additions:['x'.repeat(41)]}),/RESEARCH_CARD_INVALID/);
    await assert.rejects(rpc(db,'research_card_confirm',f.actor,card,{selected:['k1'],edits:{k2:'改'}}),/RESEARCH_CARD_INVALID/);
    await assert.rejects(rpc(db,'research_card_confirm',f.actor,card,{selected:['k9']}),/RESEARCH_CARD_INVALID/);
    const confirmed = await rpc(db,'research_card_confirm',f.actor,card,submit);
    assert.deepEqual(confirmed.items,['家居收纳','小户型收纳','宿舍好物']);
    assert.deepEqual((await rpc(db,'research_card_confirm',f.actor,card,submit)).confirmationId,confirmed.confirmationId);
    await assert.rejects(rpc(db,'research_card_confirm',f.actor,card,{selected:['k2']}),/RESEARCH_CARD_ALREADY_CONFIRMED/);
    assert.deepEqual(await rpc(db,'research_confirmation_read',f.actor,f.session,confirmed.confirmationId),
      {kind:'keywords',discoveryId:null,items:confirmed.items});
    const other = await session(db,createFixture);
    assert.equal(await rpc(db,'research_confirmation_read',other.actor,other.session,confirmed.confirmationId),null);
    // Discovery: only from a keyword confirmation of this session; one per confirmation.
    const started = await rpc(db,'research_discovery_start',f.actor,f.session,f.execution,confirmed.confirmationId,['tiktok','x']);
    assert.deepEqual(started.keywords,confirmed.items);
    assert.equal((await rpc(db,'research_discovery_start',f.actor,f.session,f.execution,confirmed.confirmationId,['tiktok','x'])).discoveryId,started.discoveryId);
    await assert.rejects(rpc(db,'research_discovery_start',f.actor,f.session,f.execution,confirmed.confirmationId,['tiktok']),/RESEARCH_DISCOVERY_CONFLICT/);
    await assert.rejects(rpc(db,'research_discovery_start',f.actor,f.session,f.execution,randomUUID(),['tiktok']),/RESEARCH_NOT_CONFIRMED/);
    const saved = await rpc(db,'research_discovery_save',f.actor,f.session,started.discoveryId,{next:3},'running');
    assert.deepEqual(saved.cursor,{next:3});
    // Candidate card: ticks only; accounts come from the host's options; head references cannot be picked.
    const cc = randomUUID();
    await rpc(db,'research_card_create',f.actor,cc,f.session,f.execution,{kind:'candidates',discoveryId:started.discoveryId,
      options:[candidate('c1','alpha'),candidate('c2','beta'),candidate('h1','bigstar',false)]});
    await assert.rejects(rpc(db,'research_card_confirm',f.actor,cc,{selected:['c1'],additions:['x']}),/RESEARCH_CARD_INVALID/);
    await assert.rejects(rpc(db,'research_card_confirm',f.actor,cc,{selected:['h1']}),/RESEARCH_CARD_INVALID/);
    const picked = await rpc(db,'research_card_confirm',f.actor,cc,{selected:['c2','c1']});
    assert.deepEqual(picked.items.map(x=>x.account).sort(),['alpha','beta']);
    assert.ok(picked.items.every(x=>!('label' in x)&&!('selectable' in x)));
    report.checks.push('RT-3b cards: keyword card select/edit/add confirmed once (replay same, change refused); candidate card ticks only, head references not selectable, accounts from host options; discovery only from this session\'s keyword confirmation');
  }

  // User message source and one paid fetch per account per session, with one-time refresh grants.
  {
    const f = await session(db,createFixture);
    await db.query("UPDATE runtime_executions SET payload=jsonb_build_object('input','看 https://www.tiktok.com/@alpha') WHERE id=$1",[f.execution]);
    assert.equal(await rpc(db,'research_user_message',f.actor,f.session,f.execution),'看 https://www.tiktok.com/@alpha');
    const other = await session(db,createFixture);
    assert.equal(await rpc(db,'research_user_message',f.actor,f.session,other.execution),null);
    const first = await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',null);
    assert.equal(first.claimed,true);
    assert.deepEqual(await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',null),
      {claimed:false,fetchId:first.fetchId,state:'in_progress',evidence:null});
    await assert.rejects(rpc(db,'research_refresh_create',f.actor,f.session,'tiktok','alpha'),/RESEARCH_REFRESH_INVALID/);
    await rpc(db,'research_account_fetch_finish',f.actor,first.fetchId,'succeeded',{operations:['op-1']});
    assert.deepEqual((await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',null)).evidence,{operations:['op-1']});
    const grant = await rpc(db,'research_refresh_create',f.actor,f.session,'tiktok','alpha');
    await assert.rejects(rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','beta',grant),/RESEARCH_REFRESH_INVALID/);
    assert.equal((await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',grant)).claimed,true);
    // Unknown result: the grant is already used, and the account is not fetched again.
    await rpc(db,'research_account_fetch_finish',f.actor,first.fetchId,'unknown',null);
    await assert.rejects(rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',grant),/RESEARCH_REFRESH_USED/);
    assert.equal((await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',null)).claimed,false);
    await assert.rejects(rpc(db,'research_refresh_create',other.actor,f.session,'tiktok','alpha'),/RESEARCH_SCOPE_DENIED|RESEARCH_REFRESH_INVALID/);
    // A confirmed free failure may be tried again.
    const b = await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'x','beta',null);
    await rpc(db,'research_account_fetch_finish',f.actor,b.fetchId,'failed',null);
    assert.equal((await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'x','beta',null)).claimed,true);
    report.checks.push('RT-3b fetches: user message only from this session; one paid fetch per account per session (in-progress and unknown never resent, success reused); refresh grant used before sending and only once, only for its own fetched account; free failure retryable');
  }

  // Conversation deletion with a settled unknown search: the text goes, the supplier-cost record stays.
  {
    const f = await session(db,createFixture);
    const c = await claimTool(db,f,1);
    await rpc(db,'bill2_record',f.actor,f.run,c.id,toolResult(c,'unknown',null,null));
    const linked = await linkedOperation(db,f,c.id,'unknown');
    const card = randomUUID();
    await rpc(db,'research_card_create',f.actor,card,f.session,f.execution,{kind:'keywords',options:keywordOptions});
    const fetch = await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',null);
    await rpc(db,'research_account_fetch_finish',f.actor,fetch.fetchId,'succeeded',{operations:[linked.op]});
    await rpc(db,'research_refresh_create',f.actor,f.session,'tiktok','alpha');
    const before = (await db.query(`SELECT supplier_cost_state,supplier_cost_bound_usd::text bound,selected_cost_usd,charged_delta,
      nominal_source,metering_missing,budget_conflict,settled_at FROM bill2_calls WHERE id=$1`,[c.id])).rows[0];
    assert.equal(before.supplier_cost_state,'pending');
    await rpc(db,'bill2_close',f.actor,f.run,'delivered',{kind:'usable_result',evidenceRef:'r',evidenceHash:'d'.repeat(64),body:'x'}).catch(()=>{});
    const scope = await rpc(db,'content_erasure_scope',f.actor,'session',f.session);
    const hash = (await db.query("SELECT encode(sha256(convert_to($1::jsonb::text,'utf8')),'hex') h",[scope])).rows[0].h;
    await rpc(db,'content_erasure_confirm',f.actor,'session',f.session,hash);
    const op = (await db.query('SELECT erased_at IS NOT NULL erased,result FROM research_operations WHERE id=$1',[linked.op])).rows[0];
    assert.deepEqual(op,{erased:true,result:{cost:{actual:0}}},'evidence text cleared, only the cost key kept');
    for (const t of ['research_selection_cards','research_account_fetches','research_refresh_grants'])
      assert.equal(await count(db,t,'session_id=$1',[f.session]),0,t+' deleted');
    const after = (await db.query(`SELECT supplier_cost_state,supplier_cost_bound_usd::text bound,selected_cost_usd,charged_delta,
      nominal_source,metering_missing,budget_conflict,settled_at FROM bill2_calls WHERE id=$1`,[c.id])).rows[0];
    assert.deepEqual(after,before,'supplier-cost pending state, bound, settlement and metering flags are kept');
    report.checks.push('RT-3b conversation deletion with a settled unknown search: not blocked; evidence text cleared (cost key kept); cards, fetches and grants deleted; the BILL2 call keeps pending supplier cost, bound, settlement and metering flags for reconciliation and route blocking');
  }

  // A runtime search whose BILL2 call is not settled yet still blocks deletion (money not final).
  {
    const f = await session(db,createFixture);
    const c = await claimTool(db,f,1);
    await linkedOperation(db,f,c.id,'unknown');
    const erase = async () => {
      const scope = await rpc(db,'content_erasure_scope',f.actor,'session',f.session);
      const hash = (await db.query("SELECT encode(sha256(convert_to($1::jsonb::text,'utf8')),'hex') h",[scope])).rows[0].h;
      return rpc(db,'content_erasure_confirm',f.actor,'session',f.session,hash);
    };
    await assert.rejects(erase(),/CONTENT_ERASURE_BUSY/);
    // The same conversation becomes deletable as soon as the tool call settles (here: unknown → user 0).
    await rpc(db,'bill2_record',f.actor,f.run,c.id,toolResult(c,'unknown',null,null));
    assert.equal((await erase()).kind,'session');
    report.checks.push('RT-3b deletion waits while the linked BILL2 tool call is unsettled and proceeds once it settles');
  }

  // Account erasure: settled runtime searches count as finished; host records deleted; counts reported.
  {
    const f = await session(db,createFixture);
    const c = await claimTool(db,f,1);
    await rpc(db,'bill2_record',f.actor,f.run,c.id,toolResult(c,'unknown',null,null));
    const linked = await linkedOperation(db,f,c.id,'unknown');
    await rpc(db,'research_card_create',f.actor,randomUUID(),f.session,f.execution,{kind:'keywords',options:keywordOptions});
    await closeAccount(db,f);
    const counts = (await db.query('SELECT account_erasure_scrub_content($1) v',[f.actor])).rows[0].v;
    assert.equal(counts.research_selection_cards_deleted,1);
    assert.equal(counts.research_operations_skipped,0);
    assert.equal((await db.query('SELECT erased_at IS NOT NULL e FROM research_operations WHERE id=$1',[linked.op])).rows[0].e,true);
    assert.equal((await toolCallRow(db,c.id)).supplier_cost_state,'pending');
    report.checks.push('RT-3b account erasure: settled runtime search scrubbed (not skipped), host records deleted with reported counts, supplier-cost record kept');
  }

  for (const role of ['anon','authenticated']) {
    await db.query('SET ROLE '+role);
    await assert.rejects(db.query('SELECT research_card_confirm($1,$1,$2)',[randomUUID(),{selected:[]}]),/permission denied/);
    await assert.rejects(db.query('SELECT research_account_fetch_claim($1,$1,$1,$2,$2,NULL)',[randomUUID(),'x']),/permission denied/);
    await db.query('RESET ROLE');
  }
  await db.query('SET ROLE service_role');
  await assert.rejects(db.query('SELECT research_session_owned($1,$1,NULL)',[randomUUID()]),/permission denied/);
  await assert.rejects(db.query('SELECT count(*) FROM research_selection_cards'),/permission denied/);
  await db.query('RESET ROLE');
  report.checks.push('RT-3b grants: client roles cannot call the RPCs; private helpers and tables closed to service_role');
}
