/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 V2-7b (0433): a review on the turn path, started on a real formal report version. The start is read first
// (fusion_review_turn_source: fusion_review_start's checks, read-only), then turn_fusion_open writes the review record
// (config.path 'turn': no fee) and opens its jury turn in one transaction; a refused open
// leaves no review; the BILL2 review functions refuse or skip turn-path reviews; the read model shows the turn's calls, the
// frozen source reads, and the fixed price is settled once by the turn. No model call.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';
import {seed} from './cases.mjs';

const FEE = 1500, HOLD = 180;
const hash = text => createHash('sha256').update(text).digest('hex');
const review = {enabled:true,reviewerModelIds:[],summaryModelId:null,skillId:null,maxRounds:2,opinionOutputTokens:4096,
  summaryOutputTokens:16384,maxBudgetUsd:'5',dispatchMinutes:10,breaker:{platformUsd:'2',noDeliveryCalls:10}};
const wallet = async (db,actor) => (await db.query('SELECT credits FROM profiles WHERE id=$1',[actor])).rows[0].credits;
const ledger = async (db,actor) => Number((await db.query('SELECT coalesce(sum(amount),0) v FROM credit_transactions WHERE user_id=$1',[actor])).rows[0].v);
async function service(db,name,...args) {
  await db.query('SET ROLE service_role');
  try { return await rpc(db,name,...args); } finally { await db.query('RESET ROLE'); }
}
async function member(db,credits) {
  const f = await seed(db);
  await db.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[f.actor]);
  const have = await wallet(db,f.actor);
  await db.query('UPDATE profiles SET credits=$2 WHERE id=$1',[f.actor,credits]);
  await db.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
    VALUES($1,$2::int,CASE WHEN $2::int>0 THEN 'addition' ELSE 'adjustment' END,CASE WHEN $2::int>0 THEN 'grant' ELSE 'adjustment' END,
      CASE WHEN $2::int>0 THEN 'opening_grant' ELSE 'admin_adjustment' END,CASE WHEN $2::int>0 THEN 'system' ELSE 'admin' END,$3,$4,$5)`,
    [f.actor,credits-have,'turn-grant:'+randomUUID(),have,credits]);
  return f;
}
const policy = {q:100,uTurnUsd:0.7,gCredits:FEE+HOLD,minCredits:FEE+HOLD,fixedCredits:FEE,uModelCredits:60,historyItems:0,inputBytes:0,
  limits:{model:7,paidTools:0,freeTools:0,decisions:0},stopLoss:{limitUsd:1000,p:8,poolSize:8,uFastUsd:1,uBigUsd:5}};
const config = {path:'turn',estimateUsd:'0.5',maxRounds:2,fixedPrice:{credits:FEE,holdCredits:HOLD}};
const NIL = '00000000-0000-0000-0000-000000000000';
const source = (db,f,request=randomUUID(),version=f.versionId) => service(db,'fusion_review_turn_source',f.actor,request,f.draft,version);
async function open(db,f,request=randomUUID(),cfg=config,pol=policy) {
  const {breaker,...fields} = await source(db,f,request);
  assert.ok(breaker && 'platformUsd' in breaker);
  return service(db,'turn_fusion_open',f.actor,NIL,request,'jury',JSON.stringify(pol),JSON.stringify({start:{...fields,config:cfg}}));
}

export async function runFusionTurn({db,report,Client,connectionString}) {
  const connect = async () => { const client = new Client({connectionString}); await client.connect(); return client; };
  await db.query(`INSERT INTO system_settings(key,value) VALUES('fusion_settings',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    [JSON.stringify({version:1,review,compare:{enabled:false}})]);
  await db.query(`INSERT INTO membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
    VALUES($1,'Local fixture','gold',true,true,500000000) ON CONFLICT(level) DO UPDATE SET allow_fusion_review=true`,[randomUUID()]);
  // 1. Start and open in one transaction: the review on the draft conversation, no fee row, the turn's freeze = price + hold.
  {
    const f = await member(db,3000), request = randomUUID();
    const opened = await open(db,f,request);
    assert.ok(opened.turnId && opened.reviewId);
    const rv = (await db.query('SELECT * FROM fusion_reviews WHERE id=$1',[opened.reviewId])).rows[0];
    assert.equal(Number(rv.turn_id),opened.turnId);assert.equal(rv.source_session_id,f.session);
    assert.equal((await db.query('SELECT count(*)::int n FROM fusion_review_fees WHERE review_id=$1',[rv.id])).rows[0].n,0,'no BILL2 fee');
    assert.equal(await wallet(db,f.actor),3000-FEE-HOLD);
    assert.equal((await db.query('SELECT session_id FROM turns WHERE id=$1',[opened.turnId])).rows[0].session_id,f.session);
    const again = await open(db,f,request);
    assert.deepEqual([again.turnId,again.reviewId,again.replay],[opened.turnId,opened.reviewId,true]);
    assert.equal(await wallet(db,f.actor),3000-FEE-HOLD,'a repeated start holds once');
    // The BILL2 review functions refuse or skip it: no group claim, no stop/end, no idle pause, no paused end.
    await assert.rejects(service(db,'fusion_review_claim',f.actor,rv.id,1,'review',1,randomUUID(),'[]'),/FUSION_REVIEW_DENIED/);
    await assert.rejects(service(db,'fusion_review_close',f.actor,rv.id,'stopped'),/FUSION_REVIEW_DENIED/);
    await db.query("UPDATE fusion_reviews SET updated_at=now()-interval '2 days' WHERE id=$1",[rv.id]);
    await service(db,'fusion_review_pause_idle','1 hour');
    assert.equal((await db.query('SELECT state FROM fusion_reviews WHERE id=$1',[rv.id])).rows[0].state,'running');
    // The frozen source reads; one group claimed with its first sequence, a seat recorded with its answer.
    const source = await service(db,'fusion_review_source',f.actor,rv.id);
    assert.ok(source.body && source.sections.length);
    await service(db,'fusion_review_turn_step',f.actor,rv.id,JSON.stringify({round:1,phase:'review',attempt:1}),JSON.stringify({state:'claim',fromSeq:1}));
    await service(db,'turn_fusion_begin',f.actor,opened.turnId,1,'model',randomUUID(),null,null,hash('r1'),0.1,6);
    await service(db,'turn_fusion_record',f.actor,opened.turnId,1,'ok',0.05,0.05,JSON.stringify({verdict:'usable'}),null,hash('p1'),null,
      JSON.stringify({phase:'fusion_review',body:'{"issues":[]}',verdict:'usable'}));
    const view = await service(db,'fusion_review_read',f.actor,rv.id);
    assert.deepEqual([view.turnId,view.calls.length,view.calls[0].verdict,view.fee.state],[opened.turnId,1,'usable','held']);
    assert.equal((await service(db,'fusion_call_output_read',f.actor,view.calls[0].callId)).body,'{"issues":[]}');
    // The summary delivers a revision: the price is charged once, the review completes.
    await service(db,'fusion_review_turn_step',f.actor,rv.id,JSON.stringify({round:1,phase:'review',attempt:1}),
      JSON.stringify({state:'running',round:1,phase:'summary',attempt:1}));
    await service(db,'fusion_review_turn_step',f.actor,rv.id,JSON.stringify({round:1,phase:'summary',attempt:1}),JSON.stringify({state:'claim',fromSeq:2}));
    await service(db,'turn_fusion_begin',f.actor,opened.turnId,2,'model',randomUUID(),null,null,hash('r2'),0.1,6);
    await service(db,'turn_fusion_record',f.actor,opened.turnId,2,'ok',0.05,0.05,JSON.stringify({verdict:'usable',deliverable:true}),null,hash('p2'),null,
      JSON.stringify({phase:'fusion_summary',body:'revised body',verdict:'usable'}));
    const closed = await service(db,'turn_fusion_close',f.actor,opened.turnId,'completed',true,false,null,
      JSON.stringify({state:'completed',outcome:{kind:'revised',awaitingChoice:true}}));
    assert.equal(closed.chargedCredits,FEE);
    assert.equal(await wallet(db,f.actor),3000-FEE);assert.equal(await ledger(db,f.actor),3000-FEE);
    const ended = await service(db,'fusion_review_read',f.actor,rv.id);
    assert.deepEqual([ended.state,ended.fee.state,ended.fee.chargedCredits],['completed','charged',FEE]);
    report.checks.push('turn path: start and open in one transaction (draft conversation, no BILL2 fee, freeze = price + hold, replay holds once); BILL2 claim/stop/idle pause refuse or skip it; read model, source and answers; a delivered revision charges the price once');
  }
  // 2. A refused open leaves no review (as a refused start never did): below price + hold, and for a non-Gold member.
  {
    const poor = await member(db,FEE+HOLD-1);
    await assert.rejects(open(db,poor),/TURN_INSUFFICIENT_CREDITS/);
    assert.equal((await db.query('SELECT count(*)::int n FROM fusion_reviews WHERE actor_id=$1',[poor.actor])).rows[0].n,0);
    assert.equal(await wallet(db,poor.actor),FEE+HOLD-1);
    const pro = await member(db,3000);
    await db.query("UPDATE profiles SET membership_level='pro' WHERE id=$1",[pro.actor]);
    await assert.rejects(open(db,pro),/TURN_MEMBERSHIP_REQUIRED|FUSION_MEMBERSHIP_REQUIRED/);
    assert.equal((await db.query('SELECT count(*)::int n FROM fusion_reviews WHERE actor_id=$1',[pro.actor])).rows[0].n,0);
    // A start on the turn path must say so: a config without path 'turn' is refused before anything is written.
    const other = await member(db,3000);
    await assert.rejects(open(db,other,randomUUID(),{...config,path:undefined}),/TURN_POLICY_INVALID/);
    assert.equal((await db.query('SELECT count(*)::int n FROM fusion_reviews WHERE actor_id=$1',[other.actor])).rows[0].n,0);
    // The read before the open refuses what fusion_review_start refused: a version that is not the current formal one.
    const stale = await member(db,3000);
    await assert.rejects(source(db,stale,randomUUID(),randomUUID()),/FUSION_REVIEW_STALE/);
    // #1522 review: the old permission chain locks and keeps a memo, so the reads before the open must not be STABLE (PostgREST
    // would run them in a read-only transaction, which refuses that). Run as the RPC runs them, in a business, with a source.
    for (const name of ['fusion_compare_turn_admit','fusion_review_turn_source'])
      assert.equal((await db.query('SELECT provolatile v FROM pg_proc WHERE proname=$1',[name])).rows[0].v,'v',name);
    const held = await member(db,3000), business = randomUUID();
    await db.query(`INSERT INTO opc_businesses(id,actor_id,name) VALUES($1,$2,'b')`,[business,held.actor]);
    await db.query('INSERT INTO opc_draft_businesses(draft_id,business_id) VALUES($1,$2)',[held.draft,business]);
    const admit = deps => service(db,'fusion_compare_turn_admit',held.actor,held.session,10,JSON.stringify(deps));
    assert.equal((await source(db,held)).draftId,held.draft);
    assert.ok(Array.isArray((await admit([{sourceVersionId:held.versionId}])).history));
    await db.query('UPDATE opc_businesses SET archived_at=now() WHERE id=$1',[business]);
    await assert.rejects(source(db,held),/OPC_BUSINESS_ARCHIVED/);
    await assert.rejects(admit([]),/OPC_BUSINESS_ARCHIVED/);
    // #1522 review: a source erased between the read before the open and the open is seen under the open's locks: no review,
    // no compare, no freeze (a copy of a deleted source is never made).
    const erased = await member(db,5000), request = randomUUID();
    const {breaker:_b,...fields} = await source(db,erased,request);
    const comparePolicy = {q:100,uTurnUsd:0.2,gCredits:120,minCredits:120,uModelCredits:60,historyItems:0,inputBytes:0,
      limits:{model:2,paidTools:0,freeTools:0,decisions:0},stopLoss:policy.stopLoss};
    const compareOn = deps => service(db,'turn_fusion_open',erased.actor,erased.session,randomUUID(),'compare',JSON.stringify(comparePolicy),
      JSON.stringify({question:'q',questionHash:hash('q'),requestHash:hash('r'),snapshotHash:hash('s'),workspaceDependencies:deps}));
    await db.query('UPDATE artifact_versions SET report=NULL,report_hash=NULL,erased_at=now() WHERE id=$1',[erased.versionId]);
    await assert.rejects(service(db,'turn_fusion_open',erased.actor,NIL,request,'jury',JSON.stringify(policy),
      JSON.stringify({start:{...fields,config}})),/FUSION_REVIEW_STALE/);
    await assert.rejects(compareOn([{sourceVersionId:erased.versionId}]),/FUSION_COMPARE_SOURCE_REVOKED/);
    assert.equal((await db.query('SELECT count(*)::int n FROM fusion_reviews WHERE actor_id=$1',[erased.actor])).rows[0].n,0);
    assert.equal((await db.query('SELECT count(*)::int n FROM turns WHERE actor_id=$1',[erased.actor])).rows[0].n,0);
    assert.equal(await wallet(db,erased.actor),5000);
    report.checks.push('turn path: a refused open (credits below price + hold, not Gold, no turn path) leaves no review and no freeze; the read before it refuses a stale version; a source erased after that read is refused by the open itself (jury and compare)');
  }
  // 3. #1522 review: a review and a compare started at the same time in two conversations of one account exclude each other.
  {
    const comparePolicy = {q:100,uTurnUsd:0.2,gCredits:120,minCredits:120,uModelCredits:60,historyItems:0,inputBytes:0,
      limits:{model:2,paidTools:0,freeTools:0,decisions:0},stopLoss:policy.stopLoss};
    const compareProduct = {question:'q',questionHash:hash('q'),requestHash:hash('r'),snapshotHash:hash('s'),workspaceDependencies:[]};
    for (const juryFirst of [true,false]) {
      const f = await member(db,5000), other = randomUUID();
      await db.query(`INSERT INTO runtime_sessions(id,actor_id,scope,start_request_id,start_payload) VALUES($1,$2,$3,$4,'{}')`,
        [other,f.actor,{kind:'positioning_draft',probe:randomUUID()},randomUUID()]);
      const first = await connect(), second = await connect();
      const jury = client => open(client,f);
      const compare = client => service(client,'turn_fusion_open',f.actor,other,randomUUID(),'compare',JSON.stringify(comparePolicy),
        JSON.stringify(compareProduct));
      try {
        await first.query('BEGIN');
        await (juryFirst ? jury(first) : compare(first));
        const racing = (juryFirst ? compare(second) : jury(second)).then(v=>({v}),e=>({e:e.message}));
        await new Promise(r=>setTimeout(r,300));
        await first.query('COMMIT');
        assert.match((await racing).e ?? '', /TURN_COMPARE_ACTIVE|FUSION_REVIEW_ACTIVE/);
      } finally { await first.end(); await second.end(); }
      assert.equal((await db.query('SELECT count(*)::int n FROM turns WHERE actor_id=$1',[f.actor])).rows[0].n,1);
    }
    report.checks.push('turn path: a review and a compare started at once in two conversations of one account: the second is refused, either order');
  }
}
