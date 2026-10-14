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
    report.checks.push('RT-2 balance cap: H=min(G,A), never negative; usage above the frozen bound is absorbed and blocks the route for new claims');
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
    report.checks.push('RT-2 crash after dispatch: the call waits for its result, then settles as unknown at the recovery deadline (user 0, cost pending)');
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
