/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
const hash=v=>createHash('sha256').update(v).digest('hex');
export async function sourceCases({admin}) {
  const rpc=async(name,args)=>(await admin.query(`SELECT public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS v`,args)).rows[0].v;
  const plan=(await admin.query("SELECT id FROM membership_plans WHERE level='gold'")).rows[0].id;
  const model=randomUUID();
  await admin.query("INSERT INTO ai_models(id,model_id,name,provider,is_active) VALUES($1,'m','Fixture','fixture','true')",[model]);
  for(const [channel,cycle] of [['waffo','monthly'],['waffo','yearly'],['stripe','yearly']]) {
    const user=randomUUID(),sub=randomUUID(),order=randomUUID(),grant=randomUUID(),tx=randomUUID();
    const start=new Date(Math.floor(Date.now()/1000)*1000-86400000);
    const monthEnd=new Date(start); monthEnd.setUTCMonth(monthEnd.getUTCMonth()+1);
    const termEnd=new Date(start); termEnd.setUTCMonth(termEnd.getUTCMonth()+(cycle==='yearly'?12:1));
    const snap={version:1,item_type:'membership_plan',item_id:plan,item_updated_at:'2026-10-01T00:00:00Z',
      billing_cycle:cycle,currency:'usd',unit:'major',price:'69.00',discount:'0.00',tax_behavior:'inclusive',credits:cycle==='yearly'?1200:100,bonus_credits:0};
    await admin.query('INSERT INTO profiles(id,credits) VALUES($1,100)',[user]);
    await admin.query(`INSERT INTO user_subscriptions(id,user_id,membership_plan_id,billing_cycle,status,
      current_period_start,current_period_end,payment_channel,merchant_namespace,payment_mode,contract_snapshot)
      VALUES($1,$2,$3,$4,'active',$7,$8,$5,'fixture','test',$6)`,
    [sub,user,plan,cycle,channel,snap,start,termEnd]);
    await admin.query(`INSERT INTO payment_orders(id,user_id,item_type,item_id,billing_cycle,mode,status,payment_status,
      payment_channel,merchant_namespace,payment_mode,purchase_request_id,purchase_payload_hash,purchase_membership_level,
      purchase_snapshot,amount_total,currency,fulfilled_at,subscription_id,qualification_state,entitlement_start,entitlement_end)
      VALUES($1,$2,'membership_plan',$3,$4,$5,'completed','paid',$6,'fixture','test',$7,$8,'gold',$9,6900,'usd',now(),$10,'sold',$11,$12)`,
    [order,user,plan,cycle,channel==='waffo'?'subscription':'payment',channel,randomUUID(),'a'.repeat(64),snap,sub,start,termEnd]);
    await admin.query(`INSERT INTO credit_transactions(id,user_id,amount,type,ledger_type,source_type,source_order_id,
      idempotency_key,balance_before,balance_after) VALUES($1,$2,100,'purchase','grant','payment_order',$3,$4,0,100)`,
    [tx,user,order,`grant:${order}`]);
    await admin.query(`INSERT INTO subscription_credit_grants(id,user_id,membership_plan_id,billing_cycle,grant_type,
      grant_period_key,period_start,period_end,credits_granted,idempotency_key,credit_transaction_id,subscription_id,
      source_order_id,grant_snapshot,accounting_state,accounting_review_reason,period_index,total_periods)
      VALUES($1,$2,$3,$4,$5,$6,$11,$12,100,$6,$7,$8,$9,$10,'trusted',NULL,$13,$14)`,
    [grant,user,plan,cycle,cycle==='yearly'?'annual_monthly_release':'monthly_invoice',`payment:${order}:01`,tx,sub,order,snap,start,monthEnd,cycle==='yearly'?1:null,cycle==='yearly'?12:1]);
    await assert.rejects(()=>admin.query('UPDATE subscription_credit_grants SET credits_granted=101 WHERE id=$1',[grant]),
      /INTERNAL_SOURCE_MISMATCH/);
    const draft=await rpc('bill2_create_draft',[user]);
    const payload={contractVersion:'bill2.v1',mode:'isolated',scope:{kind:'positioning_draft',draftId:draft},
      operation:'question',modelId:model,sourceHash:hash('source'),input:{text:'synthetic'},
      callPolicy:[{modelId:model,provider:'fixture',account:'sandbox',model:'m',protocol:'fixture-cost-v1',upperUsd:'0.08',
        inputLimit:1000,outputLimit:1000,automaticRetry:false,hiddenTools:false,lookupSupported:true}],
      rules:{version:'v1',quoteVersion:'fixture-v1',creditsPerUsd:'1000',multiplier:'1',fx:{}},
      limits:{costUsd:'0.02',credits:20,maxPreDeduct:20,maxCalls:4,deadline:new Date(Date.now()+3600000).toISOString()}};
    const run=await rpc('bill2_prepare',[user,randomUUID(),payload]);
    const consumed=async()=>(await admin.query('SELECT consumed_amount FROM subscription_credit_grants WHERE id=$1',[grant])).rows[0].consumed_amount;
    assert.equal(await consumed(),20);
    const call=await rpc('bill2_claim',[user,run.id,1,{provider:'fixture',account:'sandbox',model:'m',protocol:'fixture-cost-v1',
      phase:'reply1',requestHash:hash('hello'),upperUsd:'0.01',inputLimit:1000,outputLimit:1000,
      automaticRetry:false,hiddenTools:false,lookupSupported:true}]);
    await rpc('bill2_dispatch',[user,run.id,call.id,call.dispatchToken]);
    await rpc('bill2_record',[user,run.id,call.id,{provider:'fixture',account:'sandbox',model:'m',protocol:'fixture-cost-v1',
      providerId:`generation-${call.id}`,source:'response',sourceHash:hash(call.id),observedAt:new Date().toISOString(),
      coverage:'request_total',final:true,cost:'0.007',currency:'USD'}]);
    await rpc('bill2_close',[user,run.id,'delivered',{kind:'usable_result',evidenceRef:'fixture',evidenceHash:hash('result'),body:'Synthetic'}]);
    assert.equal((await rpc('bill2_finalize',[user,run.id])).chargedCredits,7);
    assert.equal(await consumed(),7);
    const released=await rpc('bill2_prepare',[user,randomUUID(),payload]);
    assert.equal(await consumed(),27);
    await rpc('bill2_close',[user,released.id,'confirmed_failure',
      {kind:'confirmed_delivery_failure',evidenceRef:'fixture-failure',evidenceHash:hash('failure'),body:null}]);
    await rpc('bill2_finalize',[user,released.id]);
    assert.equal(await consumed(),7);
    assert.equal((await admin.query('SELECT credits FROM profiles WHERE id=$1',[user])).rows[0].credits,93);
    await admin.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[user]);
    const pack=(await admin.query(`INSERT INTO credit_packages(name,price,credits_amount,bonus_credits,active)
      VALUES('Fixture',990,990,0,'true') RETURNING id`)).rows[0].id;
    await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
      credit_package_id,billing_cycle,is_current) VALUES('stripe','fixture','test','price',$1,$2,'one_time',true)`,
      [`price_${pack}`,pack]);
    const quoted=(await admin.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'credit_package',$2,'one_time',
      'alipay','standard','fixture','test',3,'terms-v1',NULL) o`,[user,pack])).rows[0];
    assert.equal(quoted.amount_total,890);
    if(channel==='waffo' && cycle==='monthly') for(const [externalMode,staleStatus] of [
      ['test','canceled'],['test','active'],['test','trialing'],['test','active-current'],['live','active'],[null,'trialing'],
    ]) {
      const returning=randomUUID(),stale=randomUUID(),external=randomUUID();
      await admin.query("INSERT INTO profiles(id,membership_level) VALUES($1,'gold')",[returning]);
      await admin.query(`INSERT INTO user_subscriptions(id,user_id,membership_plan_id,billing_cycle,status,
        current_period_start,current_period_end,payment_channel,merchant_namespace,payment_mode,contract_snapshot)
        VALUES($1,$2,$3,'monthly',$5,now()-interval '2 months',now()-interval '1 month','waffo','fixture','test',$4)`,
        [stale,returning,plan,snap,staleStatus==='active-current'?'active':staleStatus]);
      if(staleStatus==='active-current') await admin.query("UPDATE user_subscriptions SET current_period_end=now()+interval '1 month' WHERE id=$1",[stale]);
      if(externalMode) {
        await admin.query(`INSERT INTO user_subscriptions(id,user_id,membership_plan_id,stripe_subscription_id,status,
          current_period_start,current_period_end,payment_channel,merchant_namespace,payment_mode,contract_snapshot)
          VALUES($1,$2,$3,$4,'active',now()-interval '1 day',now()+interval '1 month','stripe','fixture',$5,$6)`,
          [external,returning,plan,`sub_${external}`,externalMode,snap]);
        await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,subscription_id)
          VALUES('stripe','fixture',$1,'subscription',$2,$3)`,[externalMode,`sub_${external}`,external]);
      }
      const purchase=()=>admin.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'credit_package',$2,'one_time',
        'alipay','standard','fixture','test',3,'terms-v1',NULL) o`,[returning,pack]);
      if(externalMode==='test' && staleStatus!=='active-current') assert.equal((await purchase()).rows[0].amount_total,890);
      else await assert.rejects(purchase,staleStatus==='active-current'?/MEMBERSHIP_FACTS_UNKNOWN/:/MEMBERSHIP_REQUIRED/);
      if(externalMode==='test' && staleStatus==='active') await assert.rejects(()=>admin.query(
        "SELECT pay_common_assert_purchase_facts($1,'membership_plan','gold')",[returning]),/MEMBERSHIP_FACTS_UNKNOWN/);
    }
    await admin.query("UPDATE subscription_credit_grants SET accounting_state='review_required',accounting_review_reason='refund review' WHERE id=$1",[grant]);
    await assert.rejects(()=>rpc('bill2_prepare',[user,randomUUID(),payload]));
  }
  return ['waffo-month-bill2-reserve-settle-release','waffo-year-bill2-reserve-settle-release',
    'wallet-year-bill2-reserve-settle-release','source-refund-review-isolation','internal-member-wallet-pack-eligibility','frozen-source-amount-guard',
    'external-member-after-internal-expiry','stale-internal-only-denied','cross-mode-membership-denied','expired-active-internal-history','expired-trialing-internal-history',
    'effective-membership-ambiguity-still-denied','legacy-duplicate-renewal-guard-preserved'];
}
