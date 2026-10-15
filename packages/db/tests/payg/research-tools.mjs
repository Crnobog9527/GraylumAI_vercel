/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RESEARCH-TOOLS RT-2 (0255): search / social-data calls on the PAYG v2 run. Synthetic fixtures only.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';
import {conserved,financial} from './core.mjs';

// Each fixture gets its own route id: the start-threshold table must hold exactly one entry per route + purpose.
const newRoute = () => 'tikhub:/tiktok/app/v3/handler_user_profile#'+randomUUID().slice(0,8);
const pricing = (patch={}) => ({unit:'call',currency:'USD',price:'0.01',unitsPerPrice:'1',usdPerCurrency:null,
  entryHash:'e'.repeat(64),validUntil:new Date(Date.now()+7*86400000).toISOString(),maxUnitsPerCall:'1',...patch});
// Same fixed UUID as SQL bill2_tool_model_id and toolModelId (toolBilling.ts).
const toolModelId = route => createHash('md5').update('bill2-research-tool:'+route).digest('hex')
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5');
const toolPolicy = (route,multiplier,patch={}) => ({provider:'tikhub',account:'tikhub-main',model:route,protocol:'research-tool-v1',
  modelId:toolModelId(route),multiplier,lookupSupported:false,upperUsd:'0.01',purposes:['question'],toolPricing:pricing(),...patch});
const toolCall = (policy,patch={}) => ({provider:policy.provider,account:policy.account,model:policy.model,
  protocol:'research-tool-v1',phase:'question',requestHash:'d'.repeat(64),automaticRetry:false,hiddenTools:false,
  lookupSupported:false,upperUsd:policy.upperUsd,billingUnit:{modelId:policy.modelId,multiplier:policy.multiplier},
  toolPricing:policy.toolPricing,...patch});
const result = (c,outcome,units,cost,patch={}) => ({provider:'tikhub',account:'tikhub-main',protocol:'research-tool-v1',
  model:c.route,providerId:c.id,source:'response',sourceHash:'c'.repeat(64),observedAt:new Date().toISOString(),
  coverage:'request_total',final:true,currency:'USD',cost,usage:{unit:'call',units},evidenceKind:'tool_result',
  toolOutcome:outcome,...patch});

async function fixture(createFixture,options={}) {
  const multiplier = options.multiplier??'6';
  const policy = toolPolicy(options.route??newRoute(),multiplier,options.policy);
  const f = await createFixture(options.db,{credits:options.credits??100,q:'100',multiplier,threshold:1,
    extraPolicies:[policy],empirical:options.empirical});
  return {...f,policy};
}
// A run bound to a runtime execution claims with its epoch, exactly as fixture.mjs claim() does.
async function runtimeEpoch(db,f) {
  const linked=(await db.query(`SELECT e.id,r.runtime_epoch FROM runtime_executions e JOIN bill2_runs r ON r.id=e.billing_run_id
    WHERE r.id=$1 AND r.session_ref IS NOT NULL`,[f.run])).rows[0];
  if (!linked) return {};
  const initial=String(linked.runtime_epoch)==='0';
  if (initial) await db.query(`UPDATE runtime_executions SET state='prepared' WHERE id=$1 AND state='interrupted'
    AND NOT EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=$2)`,[linked.id,f.run]);
  return {runtimeEpoch:(await rpc(db,'runtime_execution',f.actor,linked.id,initial?'begin':'read',null)).epoch};
}
async function claimTool(db,f,sequence,patch={},dispatch=true) {
  const c = await rpc(db,'bill2_claim',f.actor,f.run,sequence,toolCall(f.policy,{...await runtimeEpoch(db,f),...patch}));
  if (dispatch) assert.equal((await rpc(db,'bill2_dispatch',f.actor,f.run,c.id,c.dispatchToken)).dispatch,true);
  return {...c,route:f.policy.model};
}
const call = async (db,id) => (await db.query(`SELECT call_kind,state,reserved_credits,charged_delta,nominal_source,
  selected_cost_usd::text cost,supplier_cost_state,supplier_cost_bound_usd::text bound,settled_at IS NOT NULL settled,
  budget_conflict FROM bill2_calls WHERE id=$1`,[id])).rows[0];
const rows = async (db,id) => (await db.query(`SELECT reason_code,description,amount FROM credit_transactions
  WHERE bill2_call_id=$1 ORDER BY created_at,id`,[id])).rows;

export async function researchToolCases({db,Client,connectionString,report,createFixture,claim,receipt}) {
  const make = options => fixture(createFixture,{db,...options});

  // Delivered with official usage: H = ceil(U·q·m), user pays usage × frozen price, the run rounds once.
  {
    const f = await make();
    const m = await claim(db,f,1,true);
    await receipt(db,f,m,'0.001',{inputTokens:1000,outputTokens:0});
    const c = await claimTool(db,f,2);
    assert.deepEqual(await call(db,c.id),{call_kind:'tool',state:'dispatched',reserved_credits:6,charged_delta:null,
      nominal_source:null,cost:null,supplier_cost_state:null,bound:null,settled:false,budget_conflict:false});
    await rpc(db,'bill2_record',f.actor,f.run,c.id,result(c,'delivered','1','0.01'));
    const settled = await call(db,c.id);
    assert.equal(settled.nominal_source,'tool_usage');
    assert.equal(settled.supplier_cost_state,'confirmed');
    assert.equal(Number(settled.cost),0.01);
    const v = await conserved(db,f);
    // (0.001 + 0.01) × 6 × 100 = 6.6 → 7 credits once, not ceil(0.6)+ceil(6) = 8.
    assert.equal(Number(v.charged_credits),7);
    const ledger = await rows(db,c.id);
    assert.ok(ledger.some(x=>x.reason_code==='bill2_spend'&&x.description==='Web search / social data lookup'));
    report.checks.push('RT-2 tool call: hold ceil(U·q·m); delivered usage charged at the frozen price; model+tool round once; lookup wording');
  }

  // Zero-charge outcomes settle at once, release the hold, write no spend row, and never block the run.
  for (const [outcome,units,cost,source,state] of [
    ['delivered',null,null,'tool_no_usage','pending'],
    ['unknown',null,null,'tool_unknown','pending'],
    ['failed_free',null,'0','tool_failed','confirmed'],
    ['failed_charged','1','0.01','tool_failed_charged','confirmed'],
  ]) {
    const f = await make();
    const c = await claimTool(db,f,1);
    await rpc(db,'bill2_record',f.actor,f.run,c.id,result(c,outcome,units,cost));
    const s = await call(db,c.id);
    assert.equal(s.settled,true,outcome);
    assert.equal(s.charged_delta,0,outcome);
    assert.equal(s.nominal_source,source);
    assert.equal(s.supplier_cost_state,state);
    if (state==='pending') { assert.equal(s.cost,null);assert.equal(Number(s.bound),0.01); }
    else assert.equal(Number(s.cost),Number(cost));
    const v = await conserved(db,f);
    assert.equal(v.credits,100,outcome+': hold released');
    assert.ok(!(await rows(db,c.id)).some(x=>x.reason_code==='bill2_spend'),outcome+': no spend row');
    const next = await claim(db,f,2,true);
    assert.ok(next.id,outcome+': the run continues');
    report.checks.push(`RT-2 ${outcome}${units?'':' without usage'}: user 0, hold released, supplier cost ${state}, run continues`);
  }

  // Receipts are validated against the frozen price; one result per call; identical replay is a no-op.
  {
    const f = await make();
    const c = await claimTool(db,f,1);
    await assert.rejects(rpc(db,'bill2_record',f.actor,f.run,c.id,result(c,'delivered','1','0.02')),/BILL2_UNTRUSTED_RECEIPT/);
    await assert.rejects(rpc(db,'bill2_record',f.actor,f.run,c.id,result(c,'delivered','1','0.01',{providerId:randomUUID()})),/BILL2_UNTRUSTED_RECEIPT/);
    await assert.rejects(rpc(db,'bill2_record',f.actor,f.run,c.id,result(c,'unknown',null,'0.01')),/BILL2_UNTRUSTED_RECEIPT/);
    await assert.rejects(rpc(db,'bill2_record',f.actor,f.run,c.id,result(c,'delivered','1','0.01',{text:'x'})),/BILL2_UNTRUSTED_RECEIPT/);
    await assert.rejects(rpc(db,'bill2_record',f.actor,f.run,c.id,{...result(c,'delivered','1','0.01'),usage:{unit:'credit',units:'1'}}),/BILL2_UNTRUSTED_RECEIPT/);
    const ok = result(c,'delivered','1','0.01');
    await rpc(db,'bill2_record',f.actor,f.run,c.id,ok);
    const before = await financial(db,f);
    await rpc(db,'bill2_record',f.actor,f.run,c.id,ok);
    assert.deepEqual(await financial(db,f),before,'identical replay changes nothing');
    await assert.rejects(rpc(db,'bill2_record',f.actor,f.run,c.id,result(c,'unknown',null,null)),/BILL2_TOOL_RECEIPT_CONFLICT/);
    report.checks.push('RT-2 receipts: cost must equal usage × frozen price, providerId is the call, strict keys; replay no-op; a second result refused');
  }

  // Quote: the frozen policy decides price, expiry, purpose and bound.
  {
    const f = await make();
    const reject = (patch,pattern) => assert.rejects(rpc(db,'bill2_claim',f.actor,f.run,1,toolCall(f.policy,patch)),pattern);
    await reject({toolPricing:pricing({price:'0.001'})},/BILL2_TOOL_QUOTE_INVALID/);
    await reject({upperUsd:'0.02'},/BILL2_PAYG_BOUND_MISMATCH/);
    await reject({phase:'report'},/BILL2_TOOL_QUOTE_INVALID|BILL2_START_THRESHOLD/);
    await reject({inputLimit:1000},/BILL2_TOOL_QUOTE_INVALID/);
    await reject({lookupSupported:true},/BILL2_TOOL_QUOTE_INVALID/);
    await reject({provider:'brightdata'},/BILL2_TOOL_QUOTE_INVALID/);
    assert.equal((await db.query('SELECT count(*)::int n FROM bill2_calls WHERE run_id=$1',[f.run])).rows[0].n,0);
    const expired = pricing({validUntil:new Date(Date.now()-1000).toISOString()});
    const g = await make({policy:{toolPricing:expired}});
    await assert.rejects(rpc(db,'bill2_claim',g.actor,g.run,1,toolCall(g.policy)),/BILL2_TOOL_PRICE_EXPIRED/);
    assert.equal((await financial(db,g)).credits,100);
    report.checks.push('RT-2 tool quote: price, bound, purpose, extra fields, lookup and supplier must match the frozen policy; expired price refused before any hold');
  }

  // A low balance caps the hold; overuse above the frozen bound charges at most the hold and blocks the route.
  {
    const f = await make({credits:3});
    const c = await claimTool(db,f,1);
    assert.equal((await call(db,c.id)).reserved_credits,3,'H=min(G,A)');
    await rpc(db,'bill2_record',f.actor,f.run,c.id,result(c,'delivered','2','0.02'));
    const v = await conserved(db,f);
    assert.equal(Number(v.charged_credits),3);
    assert.equal(v.credits,0);
    assert.equal((await call(db,c.id)).budget_conflict,true);
    const g = await make({route:f.policy.model});
    await assert.rejects(claimTool(db,g,1),/BILL2_PAYG_METERING_BLOCKED/);
    await db.query('UPDATE bill2_calls SET budget_conflict=false WHERE id=$1',[c.id]);
    // Usage above the unit limit blocks the route even when the rounded cost stays within the bound.
    const tiny = await make({policy:{upperUsd:'0.000000000001',toolPricing:pricing({price:'0.000000000001'})}});
    const t = await claimTool(db,tiny,1);
    await rpc(db,'bill2_record',tiny.actor,tiny.run,t.id,result(t,'delivered','1.01','0.000000000001'));
    assert.equal((await call(db,t.id)).budget_conflict,true);
    await db.query('UPDATE bill2_calls SET budget_conflict=false WHERE id=$1',[t.id]);
    report.checks.push('RT-2 balance cap: H=min(G,A), never negative; usage above the frozen bound or unit limit is absorbed and blocks the route for new claims');
  }

  // No host result after dispatch: wait, then settle as unknown at the recovery deadline.
  {
    const f = await make();
    const c = await claimTool(db,f,1);
    await rpc(db,'bill2_finalize',f.actor,f.run);
    assert.equal((await call(db,c.id)).settled,false,'waits for the host result');
    await db.query("UPDATE bill2_calls SET recovery_deadline=now()-interval '1 second' WHERE id=$1",[c.id]);
    await rpc(db,'bill2_finalize',f.actor,f.run);
    const s = await call(db,c.id);
    assert.deepEqual([s.settled,s.charged_delta,s.nominal_source,s.supplier_cost_state],[true,0,'tool_unknown','pending']);
    assert.equal((await financial(db,f)).credits,100);
    // A late result may confirm the pending supplier cost; the user settlement stays at 0.
    await rpc(db,'bill2_record',f.actor,f.run,c.id,result(c,'delivered','1','0.01'));
    const late = await call(db,c.id);
    assert.deepEqual([late.charged_delta,late.nominal_source,late.supplier_cost_state,Number(late.cost)],[0,'tool_unknown','confirmed',0.01]);
    assert.equal((await financial(db,f)).credits,100);
    // Once an admin has reconciled a call, a later result is refused and the reconciled cost stays.
    const g = await make();
    const d = await claimTool(db,g,1);
    await rpc(db,'bill2_cancel',g.actor,g.run);
    await rpc(db,'bill2_finalize',g.actor,g.run);
    const admin = randomUUID();
    await db.query("INSERT INTO profiles(id,credits,role) VALUES($1,0,'admin')",[admin]);
    await db.query("UPDATE bill2_calls SET recovery_deadline=now()-interval '11 minutes' WHERE id=$1",[d.id]);
    assert.ok(!(await rpc(db,'bill2_payg_stuck_calls',100)).calls.some(x=>x.callId===d.id));
    await assert.rejects(rpc(db,'bill2_payg_admin_settle_call',admin,randomUUID(),d.id,'0.005','tool crash'),
      /BILL2_ADMIN_SETTLE_NOT_READY/);
    assert.equal((await call(db,d.id)).cost,null,'generic settlement cannot overwrite tool supplier state');
    await rpc(db,'bill2_finalize',g.actor,g.run);
    assert.equal((await financial(db,g)).credits,100,'tool deadline settlement releases the full hold');
    assert.equal((await call(db,d.id)).nominal_source,'tool_unknown');
    assert.equal((await call(db,d.id)).supplier_cost_state,'pending');
    await rpc(db,'bill2_tool_cost_reconcile',admin,d.id,'0.005','a'.repeat(64));
    await assert.rejects(rpc(db,'bill2_record',g.actor,g.run,d.id,result(d,'delivered','1','0.01')),/BILL2_TOOL_RECEIPT_CONFLICT/);
    assert.equal(Number((await call(db,d.id)).cost),0.005);
    assert.equal((await financial(db,g)).credits,100,'supplier reconciliation never charges the user again');
    report.checks.push('RT-2 crash after dispatch: waits for its result, then settles as unknown at the recovery deadline (user 0, cost pending); a late result confirms the cost without charging; after reconciliation a late result is refused');
  }

  // The same crash on a runtime-bound run, finished only through the automatic recovery inventory.
  {
    const f = await make();
    const execution = (await db.query('SELECT b2a_test.bind($1) v',[f])).rows[0].v;
    const c = await claimTool(db,f,1);
    // The stalled execution is ended; the run closes but waits for the tool result.
    await db.query("UPDATE runtime_executions SET state='cancelled' WHERE id=$1",[execution]);
    assert.equal((await rpc(db,'runtime_financial_recovery',f.actor,execution,true)).state,'cost_pending');
    const listed = async () => (await rpc(db,'runtime_pending_financial_batch',f.actor,20)).filter(x=>x.runId===f.run);
    assert.equal((await listed()).length,0,'not listed before the recovery deadline');
    await db.query("UPDATE bill2_calls SET recovery_deadline=now()-interval '1 second' WHERE id=$1",[c.id]);
    const [item] = await listed();
    assert.equal(item?.finishAllowed,true,'listed once the deadline has passed');
    // What the recovery worker does for a finishable item (automaticRecovery.ts).
    assert.equal((await rpc(db,'runtime_financial_recovery',f.actor,item.executionId,true)).state,'cancelled');
    const s = await call(db,c.id);
    assert.deepEqual([s.settled,s.charged_delta,s.nominal_source,s.supplier_cost_state],[true,0,'tool_unknown','pending']);
    assert.equal((await financial(db,f)).credits,100);
    assert.equal((await listed()).length,0);
    report.checks.push('RT-2 recovery inventory: a closed run with a crashed tool call is listed after the recovery deadline and the worker releases the hold as unknown');
  }

  // A run closed as a confirmed failure while a tool call is in flight: the call keeps its supplier cost, the user pays 0.
  {
    const failure = {kind:'confirmed_delivery_failure',evidenceRef:'local-proof',evidenceHash:'d'.repeat(64),body:'local proof'};
    const f = await make();
    const used = await claimTool(db,f,1);
    await rpc(db,'bill2_close',f.actor,f.run,'confirmed_failure',failure);
    await rpc(db,'bill2_finalize',f.actor,f.run);
    assert.equal((await call(db,used.id)).settled,false,'a dispatched tool call waits for its result');
    await rpc(db,'bill2_record',f.actor,f.run,used.id,result(used,'delivered','1','0.01'));
    await rpc(db,'bill2_finalize',f.actor,f.run);
    const u = await call(db,used.id);
    assert.deepEqual([u.settled,u.charged_delta,u.nominal_source,u.supplier_cost_state,Number(u.cost)],
      [true,0,'tool_failed_charged','confirmed',0.01]);
    assert.equal((await financial(db,f)).credits,100);
    await conserved(db,f);
    const g = await make();
    const lost = await claimTool(db,g,1);
    await rpc(db,'bill2_close',g.actor,g.run,'confirmed_failure',failure);
    await db.query("UPDATE bill2_calls SET recovery_deadline=now()-interval '1 second' WHERE id=$1",[lost.id]);
    assert.equal((await rpc(db,'bill2_finalize',g.actor,g.run)).state,'refunded');
    const l = await call(db,lost.id);
    assert.deepEqual([l.settled,l.charged_delta,l.nominal_source,l.supplier_cost_state,Number(l.bound)],[true,0,'tool_unknown','pending',0.01]);
    assert.equal((await financial(db,g)).credits,100);
    await conserved(db,g);
    report.checks.push('RT-2 confirmed run failure: an in-flight tool call settles through tool settlement (user 0; a used lookup is confirmed and absorbed; a missing result is pending with its bound) instead of a generic refund');
  }

  // Reconciliation fills the pending supplier cost; admin only; replay-safe.
  {
    const f = await make();
    const c = await claimTool(db,f,1);
    await rpc(db,'bill2_record',f.actor,f.run,c.id,result(c,'unknown',null,null));
    const admin = randomUUID();
    await db.query("INSERT INTO profiles(id,credits,role) VALUES($1,0,'admin')",[admin]);
    await assert.rejects(rpc(db,'bill2_tool_cost_reconcile',f.actor,c.id,'0.01','a'.repeat(64)),/BILL2_TOOL_RECONCILE_DENIED/);
    const before = await financial(db,f);
    assert.equal((await rpc(db,'bill2_tool_cost_reconcile',admin,c.id,'0.01','a'.repeat(64))).replayed,false);
    assert.equal((await rpc(db,'bill2_tool_cost_reconcile',admin,c.id,'0.01','a'.repeat(64))).replayed,true);
    await assert.rejects(rpc(db,'bill2_tool_cost_reconcile',admin,c.id,'0.01','b'.repeat(64)),/BILL2_TOOL_RECONCILE_INVALID/,
      'a replay with other evidence is refused');
    await assert.rejects(rpc(db,'bill2_tool_cost_reconcile',admin,c.id,'0.02','a'.repeat(64)),/BILL2_TOOL_RECONCILE_INVALID/);
    assert.equal((await call(db,c.id)).supplier_cost_state,'confirmed');
    assert.deepEqual(await financial(db,f),before,'user settlement never changes');
    assert.equal((await db.query("SELECT count(*)::int n FROM user_activity_logs WHERE action='bill2_tool_cost_reconcile' AND details->>'callId'=$1",[c.id])).rows[0].n,1);
    await db.query('SET ROLE service_role');
    const reported = (await db.query(`SELECT call_kind,supplier_cost_state,supplier_cost_bound_usd,nominal_source
      FROM bill2_admin_call_report(now()-interval '1 day',now()+interval '1 day',5000) WHERE call_id=$1`,[c.id])).rows[0];
    await db.query('RESET ROLE');
    assert.deepEqual(reported,{call_kind:'tool',supplier_cost_state:'confirmed',supplier_cost_bound_usd:'0.01',nominal_source:'tool_unknown'});
    // A reconciled cost above the frozen bound blocks the route for new claims, like overuse at record time.
    const g = await make();
    const over = await claimTool(db,g,1);
    await rpc(db,'bill2_record',g.actor,g.run,over.id,result(over,'unknown',null,null));
    await rpc(db,'bill2_tool_cost_reconcile',admin,over.id,'0.03','a'.repeat(64));
    assert.equal((await call(db,over.id)).budget_conflict,true);
    await assert.rejects(claimTool(db,await make({route:g.policy.model}),1),/BILL2_PAYG_METERING_BLOCKED/);
    await db.query('UPDATE bill2_calls SET budget_conflict=false WHERE id=$1',[over.id]);
    report.checks.push('RT-2 reconciliation: admin fills pending supplier cost once (replay-safe, audited); user settlement unchanged; non-admin refused; above the bound blocks the route; finance report shows kind and cost state');
  }

  // staging test windows accept an approved tool route; model routes keep their rule.
  {
    const f = await make({empirical:true});
    const c = await claimTool(db,f,1);
    await rpc(db,'bill2_record',f.actor,f.run,c.id,result(c,'delivered','1','0.01'));
    assert.equal((await call(db,c.id)).nominal_source,'tool_usage');
    report.checks.push('RT-2 staging test window: an approved tool route in the window policy list can be claimed and settled');
  }

  // Duplicate submissions from two connections: one call, one hold, one dispatch authority, one result.
  {
    const writers = [new Client({connectionString}),new Client({connectionString})];
    await Promise.all(writers.map(w=>w.connect()));
    try {
      await Promise.all(writers.map(w=>w.query("SET statement_timeout='10s'")));
      const f = await make();
      const raced = await Promise.all(writers.map(w=>rpc(w,'bill2_claim',f.actor,f.run,1,toolCall(f.policy))));
      assert.equal(raced[0].id,raced[1].id);
      assert.equal(raced.filter(c=>c.dispatchToken).length,1,'one dispatch authority');
      assert.equal((await db.query('SELECT count(*)::int n FROM bill2_calls WHERE run_id=$1',[f.run])).rows[0].n,1);
      const c = {...raced.find(x=>x.dispatchToken),route:f.policy.model};
      assert.equal((await rpc(db,'bill2_dispatch',f.actor,f.run,c.id,c.dispatchToken)).dispatch,true);
      const outcomes = await Promise.allSettled([
        rpc(writers[0],'bill2_record',f.actor,f.run,c.id,result(c,'delivered','1','0.01')),
        rpc(writers[1],'bill2_record',f.actor,f.run,c.id,result(c,'unknown',null,null)),
      ]);
      assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1,'exactly one result wins');
      assert.match(String(outcomes.find(x=>x.status==='rejected').reason),/BILL2_TOOL_RECEIPT_CONFLICT/);
      assert.equal((await db.query('SELECT count(*)::int n FROM bill2_receipts WHERE call_id=$1',[c.id])).rows[0].n,1);
      await conserved(db,f);
      report.checks.push('RT-2 concurrency: two connections claiming the same tool call get one identity and one token; racing results keep exactly one');
    } finally { await Promise.all(writers.map(w=>w.end())); }
  }

  // Account erasure with a dispatched tool call and no result: released at once, cost pending (plan §3.6).
  {
    const f = await make();
    const execution = (await db.query('SELECT b2a_test.bind($1) v',[f])).rows[0].v;
    const c = await claimTool(db,f,1);
    assert.ok((await financial(db,f)).credits<100);
    await closeAccount(db,f);
    await rpc(db,'runtime_financial_recovery',f.actor,execution,true);
    const s = await call(db,c.id);
    assert.deepEqual([s.settled,s.charged_delta,s.nominal_source,s.supplier_cost_state],[true,0,'tool_unknown','pending']);
    assert.equal((await financial(db,f)).credits,100);
    report.checks.push('RT-2 account erasure: a dispatched tool call without a result settles at 0 immediately, hold released, supplier cost pending');
  }

  // Repeated pending-cost results stop the route; an admin metering review reopens it.
  {
    const f = await make();
    const ids = [];
    for (let i=1;i<=5;i++) {
      const c = await claimTool(db,f,i,{requestHash:String(i).repeat(64)});
      await rpc(db,'bill2_record',f.actor,f.run,c.id,result(c,i%2?'unknown':'delivered',null,null));
      ids.push(c.id);
    }
    assert.deepEqual((await db.query('SELECT metering_missing m FROM bill2_calls WHERE id=ANY($1::uuid[]) ORDER BY sequence',[ids])).rows.map(r=>r.m),
      [false,false,false,false,true],'the fifth pending result within an hour flags the route');
    assert.equal((await financial(db,f)).credits,100,'the user is never charged for these');
    await assert.rejects(claimTool(db,await make({route:f.policy.model}),1),/BILL2_PAYG_METERING_BLOCKED/);
    const admin = randomUUID();
    await db.query("INSERT INTO profiles(id,credits,role) VALUES($1,0,'admin')",[admin]);
    const flagged = ids[4];
    // Erasure strips toolPricing from the payload; the review still works from the stored price entry hash.
    await db.query("SET session_replication_role=replica");
    await db.query('UPDATE bill2_calls SET payload=bill2_erasure_call_payload(payload) WHERE id=$1',[flagged]);
    await db.query("RESET session_replication_role");
    assert.equal((await db.query("SELECT payload ? 'toolPricing' p FROM bill2_calls WHERE id=$1",[flagged])).rows[0].p,false);
    // Same steps as the admin page: read the snapshot, then review with what it returned.
    const snap = await rpc(db,'bill2_payg_metering_review_snapshot',admin,flagged);
    assert.deepEqual([snap.profileVersion,snap.evidenceVersion,snap.reviewable,snap.meteringMissing],
      ['research-tool-v1',f.policy.toolPricing.entryHash,true,true]);
    await rpc(db,'bill2_payg_review_metering',admin,flagged,randomUUID(),{expectedEvidenceHash:snap.evidenceHash,
      profileVersion:snap.profileVersion,evidenceVersion:snap.evidenceVersion,reviewReference:'RT-2 local review',humanReviewed:true});
    const reopened = await make({route:f.policy.model});
    // Each fixture appends its route threshold; keep exactly one entry for this reused route.
    await db.query(`UPDATE system_settings SET value=jsonb_set(value,'{thresholds}',(
      SELECT jsonb_agg(x) FROM jsonb_array_elements(value->'thresholds') x WHERE x->>'model'<>$1)
      ||jsonb_build_array(jsonb_build_object('model',$1::text,'purpose','question','credits',1)))
      WHERE key='billing_payg_start_thresholds'`,[f.policy.model]);
    const next = await claimTool(db,reopened,1);
    await rpc(db,'bill2_record',reopened.actor,reopened.run,next.id,result(next,'unknown',null,null));
    assert.equal((await call(db,next.id)).settled,true,'the reviewed route is usable again and earlier pending results no longer count');
    assert.equal((await db.query('SELECT metering_missing m FROM bill2_calls WHERE id=$1',[next.id])).rows[0].m,false);
    // Calls settled as unknown at their recovery deadline count from that moment, however old they are.
    const old = await make();
    const stale = [];
    for (let i=1;i<=5;i++) {
      const c = await claimTool(db,old,i,{requestHash:String(i).repeat(64)});
      await db.query("UPDATE bill2_calls SET created_at=now()-interval '23 hours',recovery_deadline=now()-interval '1 second' WHERE id=$1",[c.id]);
      await rpc(db,'bill2_finalize',old.actor,old.run);
      stale.push(c.id);
    }
    assert.equal((await db.query('SELECT bool_or(metering_missing) m FROM bill2_calls WHERE id=ANY($1::uuid[])',[stale])).rows[0].m,true,
      'five calls settled as unknown now stop the route even though they were created long ago');
    report.checks.push('RT-2 repeated pending costs: the fifth pending result on a route within an hour (by settlement time) stops the route; an admin metering review reopens it and resets the count');
  }

  // Erasure projections keep the financial shape of runs and calls with tool policies (DATA-ERASURE).
  {
    const f = await make();
    const c = await claimTool(db,f,1);
    await rpc(db,'bill2_record',f.actor,f.run,c.id,result(c,'delivered','1','0.01'));
    const run = (await db.query('SELECT bill2_erasure_run_payload(payload) v FROM bill2_runs WHERE id=$1',[f.run])).rows[0].v;
    const tool = run.callPolicy.find(x=>x.protocol==='research-tool-v1');
    assert.deepEqual(Object.keys(tool).sort(),['account','lookupSupported','model','modelId','multiplier','protocol','provider','upperUsd']);
    assert.equal(tool.modelId,f.policy.modelId);
    const projected = (await db.query('SELECT bill2_erasure_call_payload(payload) v FROM bill2_calls WHERE id=$1',[c.id])).rows[0].v;
    assert.deepEqual(projected.billingUnit,{modelId:f.policy.modelId,multiplier:'6'});
    assert.equal(projected.protocol,'research-tool-v1');
    assert.ok(!('toolPricing' in projected));
    await assert.rejects(make({policy:{modelId:randomUUID()}}),/BILL2_CALL_POLICY_DENIED/);
    report.checks.push('RT-2 erasure projections accept tool runs and calls (route modelId is a fixed UUID); a policy with another modelId is refused');
  }

  // Private helpers stay private; the reconcile entry point is service_role only.
  for (const role of ['anon','authenticated','service_role']) {
    await db.query('SET ROLE '+role);
    await assert.rejects(db.query(`SELECT bill2_tool_cost('{}'::jsonb,'1',true)`),/permission denied/);
    if (role!=='service_role') await assert.rejects(db.query(`SELECT bill2_tool_cost_reconcile($1,$1,'0','${'a'.repeat(64)}')`,[randomUUID()]),/permission denied/);
    await db.query('RESET ROLE');
  }
  report.checks.push('RT-2 grants: tool helpers private; reconcile callable by service_role only');
}
