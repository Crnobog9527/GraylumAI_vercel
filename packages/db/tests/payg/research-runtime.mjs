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
async function linkedOperation(db,f,callId,finish,identity) {
  // The operation's identity is the BILL2 call's requestHash (the same supplier request).
  const identityHash = identity ?? (await db.query("SELECT payload->>'requestHash' h FROM bill2_calls WHERE id=$1",[callId])).rows[0].h;
  const plan = randomUUID(), op = randomUUID();
  await rpc(db,'research_transition','create',plan,f.actor,null,{budgetUnits:1000,maxOperations:1,
    operations:[{operationId:op,identityHash,maxQuoteUnits:100}]});
  const reserved = await rpc(db,'research_transition','reserve',plan,f.actor,op,{identityHash,quoteUnits:10});
  assert.equal((await rpc(db,'research_transition','dispatch',plan,f.actor,op,{token:reserved.token})).dispatch,true);
  if (finish) await rpc(db,'research_transition','finish',plan,f.actor,op,{token:reserved.token,state:finish,
    result:{items:[{fields:{followers:12000}}],query:'PRIVATE_QUERY',cost:{actual:0}}});
  await rpc(db,'research_runtime_link',f.actor,plan,f.session,f.execution,null,op,callId);
  return {plan,op};
}

export async function researchRuntimeCases({db,Client,connectionString,report,createFixture}) {
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
    const again = randomUUID();
    await rpc(db,'research_card_create',f.actor,again,f.session,f.execution,{kind:'keywords',options:keywordOptions});
    const second = await rpc(db,'research_card_confirm',f.actor,again,{selected:['k1']});
    await assert.rejects(rpc(db,'research_discovery_start',f.actor,f.session,f.execution,second.confirmationId,['tiktok','tiktok']),
      /RESEARCH_DISCOVERY_INVALID/);
    const saved = await rpc(db,'research_discovery_save',f.actor,f.session,started.discoveryId,{next:3},'running');
    assert.deepEqual(saved.cursor,{next:3});
    // Candidate card: ticks only; accounts come from the host's options; head references cannot be picked.
    const cc = randomUUID();
    // A first card needs 8–12 selectable accounts; this follow-up card (followUp) offers two.
    await assert.rejects(rpc(db,'research_card_create',f.actor,randomUUID(),f.session,f.execution,{kind:'candidates',
      discoveryId:started.discoveryId,options:['a','b','c','d','e','f','g'].map(x=>candidate('n'+x,'seven'+x))}),/RESEARCH_CARD_INVALID/);
    await rpc(db,'research_card_create',f.actor,cc,f.session,f.execution,{kind:'candidates',discoveryId:started.discoveryId,followUp:true,
      options:[candidate('c1','alpha'),candidate('c2','beta'),candidate('h1','bigstar',false)]});
    await assert.rejects(rpc(db,'research_card_confirm',f.actor,cc,{selected:['c1'],additions:['x']}),/RESEARCH_CARD_INVALID/);
    await assert.rejects(rpc(db,'research_card_confirm',f.actor,cc,{selected:['h1']}),/RESEARCH_CARD_INVALID/);
    // Two selectable candidates: the minimum is all of them; a card with more asks for at least 3.
    await assert.rejects(rpc(db,'research_card_confirm',f.actor,cc,{selected:['c1']}),/RESEARCH_CARD_INVALID/);
    const picked = await rpc(db,'research_card_confirm',f.actor,cc,{selected:['c2','c1']});
    assert.deepEqual(picked.items.map(x=>x.account).sort(),['alpha','beta']);
    const wide = randomUUID();
    await rpc(db,'research_card_create',f.actor,wide,f.session,f.execution,{kind:'candidates',discoveryId:started.discoveryId,
      options:['a','b','c','d','e','f','g','h'].map(x=>candidate('c'+x,'acct'+x))});
    await assert.rejects(rpc(db,'research_card_confirm',f.actor,wide,{selected:['ca','cb']}),/RESEARCH_CARD_INVALID/);
    await assert.rejects(rpc(db,'research_card_confirm',f.actor,wide,{selected:['ca','cb','cc','cd','ce','cf']}),/RESEARCH_CARD_INVALID/);
    assert.equal((await rpc(db,'research_card_confirm',f.actor,wide,{selected:['ca','cb','cc']})).items.length,3);
    const more = randomUUID();
    await assert.rejects(rpc(db,'research_card_create',f.actor,randomUUID(),f.session,f.execution,{kind:'candidates',
      discoveryId:started.discoveryId,minSelect:1,options:['i','j','k','l'].map(x=>candidate('m'+x,'acct'+x))}),/RESEARCH_CARD_INVALID/);
    await rpc(db,'research_card_create',f.actor,more,f.session,f.execution,{kind:'candidates',discoveryId:started.discoveryId,followUp:true,minSelect:1,
      options:['i','j','k','l'].map(x=>candidate('c'+x,'acct'+x))});
    assert.equal((await rpc(db,'research_card_confirm',f.actor,more,{selected:['ci']})).items.length,1);
    await assert.rejects(rpc(db,'research_card_create',f.actor,randomUUID(),f.session,f.execution,{kind:'keywords',minSelect:1,
      options:keywordOptions}),/RESEARCH_CARD_INVALID/);
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
    const crashed = await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',null);
    assert.equal(crashed.claimed,true);
    // Nothing was sent (a crash after the claim): the claim can be taken again, and the old attempt can never send.
    const first = await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',null);
    assert.deepEqual([first.claimed,first.fetchId],[true,crashed.fetchId]);
    assert.equal(await rpc(db,'research_account_fetch_dispatch',f.actor,first.fetchId,crashed.attempt),false);
    assert.equal(await rpc(db,'research_account_fetch_dispatch',f.actor,first.fetchId,first.attempt),true);
    assert.equal(await rpc(db,'research_account_fetch_dispatch',f.actor,first.fetchId,first.attempt),false,'sent once');
    // Once sent, it is never claimed again.
    assert.deepEqual(await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',null),
      {claimed:false,fetchId:first.fetchId,state:'in_progress',evidence:null});
    await assert.rejects(rpc(db,'research_refresh_create',f.actor,f.session,'tiktok','alpha'),/RESEARCH_REFRESH_INVALID/);
    await rpc(db,'research_account_fetch_finish',f.actor,first.fetchId,first.attempt,'succeeded',{operations:['op-1']});
    assert.deepEqual((await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',null)).evidence,{operations:['op-1']});
    const grant = await rpc(db,'research_refresh_create',f.actor,f.session,'tiktok','alpha');
    await assert.rejects(rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','beta',grant),/RESEARCH_REFRESH_INVALID/);
    const refreshed = await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',grant);
    assert.equal(refreshed.claimed,true);
    assert.notEqual(refreshed.attempt,first.attempt,'each paid attempt has its own token');
    // A late result of the first attempt cannot finish the refresh.
    await assert.rejects(rpc(db,'research_account_fetch_finish',f.actor,first.fetchId,first.attempt,'succeeded',{operations:['op-old']}),/RESEARCH_FETCH_CONFLICT/);
    // Unknown result: the grant is already used, nothing is fetched again, and the last success is still served.
    assert.equal(await rpc(db,'research_account_fetch_dispatch',f.actor,first.fetchId,refreshed.attempt),true);
    await rpc(db,'research_account_fetch_finish',f.actor,first.fetchId,refreshed.attempt,'unknown',null);
    await assert.rejects(rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',grant),/RESEARCH_REFRESH_USED/);
    const after = await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',null);
    assert.deepEqual([after.claimed,after.evidence],[false,{operations:['op-1']}],'a failed refresh keeps the earlier paid evidence');
    // A refresh that succeeds replaces it.
    const grant2 = await rpc(db,'research_refresh_create',f.actor,f.session,'tiktok','alpha');
    const r2 = await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',grant2);
    await rpc(db,'research_account_fetch_dispatch',f.actor,first.fetchId,r2.attempt);
    await rpc(db,'research_account_fetch_finish',f.actor,first.fetchId,r2.attempt,'succeeded',{operations:['op-2']});
    assert.deepEqual((await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',null)).evidence,{operations:['op-2']});
    await assert.rejects(rpc(db,'research_refresh_create',other.actor,f.session,'tiktok','alpha'),/RESEARCH_SCOPE_DENIED|RESEARCH_REFRESH_INVALID/);
    // A confirmed free failure may be tried again.
    const b = await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'x','beta',null);
    await rpc(db,'research_account_fetch_finish',f.actor,b.fetchId,b.attempt,'failed',null);
    assert.equal((await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'x','beta',null)).claimed,true);
    {
    const f = await session(db,createFixture);
    const g = await toolFixture(createFixture,{db,actor:f.actor});
    const foreign = await claimTool(db,g,1,{},false);
    await assert.rejects(linkedOperation(db,f,foreign.id,null),/RESEARCH_LINK_CONFLICT/);
    // Within the same answer, an operation is only tied to the call of the same request.
    const own = await claimTool(db,f,1,{},false);
    await assert.rejects(linkedOperation(db,f,own.id,null,'e'.repeat(64)),/RESEARCH_LINK_CONFLICT/);
    await linkedOperation(db,f,own.id,null);
    // Writes after a conversation was marked deleted are refused (they lock and re-check the marker).
    const gone = await session(db,createFixture);
    await rpc(db,'content_erasure_mark_session',gone.actor,gone.session);
    await assert.rejects(rpc(db,'research_card_create',gone.actor,randomUUID(),gone.session,gone.execution,
      {kind:'keywords',options:keywordOptions}),/RESEARCH_SCOPE_DENIED/);
    await assert.rejects(rpc(db,'research_account_fetch_claim',gone.actor,gone.session,gone.execution,'tiktok','alpha',null),
      /RESEARCH_SCOPE_DENIED/);
  }
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
    await rpc(db,'research_account_fetch_dispatch',f.actor,fetch.fetchId,fetch.attempt);
    await rpc(db,'research_account_fetch_finish',f.actor,fetch.fetchId,fetch.attempt,'succeeded',{operations:[linked.op]});
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

  // Deleting the answer that produced the last successful evidence removes the fetch record, even when a later
  // answer's refresh failed (the record's current answer is then the later one).
  {
    const f = await session(db,createFixture);
    const e2 = randomUUID();
    await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state)
      VALUES($1,$2,$3,gen_random_uuid(),'{}',0,'interrupted')`,[e2,f.actor,f.session]);
    const one = await rpc(db,'research_account_fetch_claim',f.actor,f.session,f.execution,'tiktok','alpha',null);
    await rpc(db,'research_account_fetch_dispatch',f.actor,one.fetchId,one.attempt);
    await rpc(db,'research_account_fetch_finish',f.actor,one.fetchId,one.attempt,'succeeded',{operations:['op-e1']});
    const grant = await rpc(db,'research_refresh_create',f.actor,f.session,'tiktok','alpha');
    const two = await rpc(db,'research_account_fetch_claim',f.actor,f.session,e2,'tiktok','alpha',grant);
    await rpc(db,'research_account_fetch_dispatch',f.actor,two.fetchId,two.attempt);
    await rpc(db,'research_account_fetch_finish',f.actor,two.fetchId,two.attempt,'failed',null);
    await db.query("UPDATE runtime_executions SET state='completed' WHERE id=$1",[f.execution]).catch(()=>{});
    const scope = await rpc(db,'content_erasure_scope',f.actor,'answer',f.execution);
    const hash = (await db.query("SELECT encode(sha256(convert_to($1::jsonb::text,'utf8')),'hex') h",[scope])).rows[0].h;
    await rpc(db,'content_erasure_confirm',f.actor,'answer',f.execution,hash);
    assert.equal(await count(db,'research_account_fetches','id=$1',[one.fetchId]),0,'the record carrying E1 evidence is deleted with E1');
    report.checks.push('RT-3b answer deletion: the fetch record goes with the answer that produced its last successful evidence, even after a later failed refresh');
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

  // Concurrency with deletion, on two real connections (the lock order of research_session_owned).
  {
    const [deleter,writer] = [new Client({connectionString}),new Client({connectionString})];
    await Promise.all([deleter.connect(),writer.connect()]);
    try {
      await Promise.all([deleter,writer].map(w=>w.query("SET statement_timeout='15s'")));
      const pid = (await writer.query('SELECT pg_backend_pid() p')).rows[0].p;
      const waiting = async () => (await db.query(`SELECT wait_event_type='Lock' w FROM pg_stat_activity WHERE pid=$1`,[pid])).rows[0]?.w;
      // 1) A deletion in progress: a write arriving now waits for it, then is refused.
      const g = await session(db,createFixture);
      await deleter.query('BEGIN');
      await rpc(deleter,'content_erasure_mark_session',g.actor,g.session);
      const late = rpc(writer,'research_card_create',g.actor,randomUUID(),g.session,g.execution,{kind:'keywords',options:keywordOptions})
        .then(()=>'created',e=>String(e.message));
      for (let i=0;i<50&&!(await waiting());i++) await new Promise(r=>setTimeout(r,50));
      assert.equal(await waiting(),true,'the write waits for the deletion');
      await deleter.query('COMMIT');
      assert.match(await late,/RESEARCH_SCOPE_DENIED/,'a write arriving during deletion is refused');
      // 2) A write already holding its locks: the deletion waits for it, and the cleanup then removes what it wrote.
      const h = await session(db,createFixture);
      await writer.query('BEGIN');
      const card = randomUUID();
      await rpc(writer,'research_card_create',h.actor,card,h.session,h.execution,{kind:'keywords',options:keywordOptions});
      const marking = rpc(deleter,'content_erasure_mark_session',h.actor,h.session).then(r=>r.status,e=>String(e.message));
      await new Promise(r=>setTimeout(r,300));
      await writer.query('COMMIT');
      assert.equal(await marking,'deleted');
      await rpc(db,'content_erasure_sweep_sessions',50,null,null);
      assert.equal(await count(db,'research_selection_cards','id=$1',[card]),0,'the committed card is removed by the deletion cleanup');
      report.checks.push('RT-3b concurrency: a research write arriving while a conversation deletion is in progress waits and is refused; a write that committed first is removed by that deletion');
    } finally {
      await Promise.all([deleter,writer].map(w=>w.query('ROLLBACK').catch(()=>{})));
      await Promise.all([deleter.end(),writer.end()]);
    }
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
