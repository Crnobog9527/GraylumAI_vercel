/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
export function provider(f) {
 const t=f.terms,stamp=Date.parse(t.paidAt)/1000,end=Date.parse(t.periodEnd)/1000;
 const writes=[],events=[],refunds=[];
 const sub={id:t.providerSubscriptionId,object:'subscription',livemode:false,status:'active',customer:'cus_'+f.user,
  metadata:{userId:f.user},cancel_at_period_end:false,cancel_at:null,pending_update:null,schedule:null,pause_collection:null,
  collection_method:'charge_automatically',items:{has_more:false,data:[{quantity:1,current_period_end:end,
   price:{recurring:{interval:'month',interval_count:1,usage_type:'licensed'}}}]}};
 const invoice={id:t.invoiceId,object:'invoice',livemode:false,status:'paid',amount_paid:6900,currency:'usd',
  parent:{subscription_details:{subscription:sub.id}},status_transitions:{paid_at:stamp},billing_reason:'subscription_create'};
 const intent={id:t.paymentIntentId,livemode:false,status:'succeeded',amount_received:6900,currency:'usd',
  latest_charge:t.chargeId,customer:sub.customer};
 const charge={id:t.chargeId,livemode:false,paid:true,captured:true,payment_intent:t.paymentIntentId,amount:6900,
  amount_captured:6900,amount_refunded:0,currency:'usd',disputed:false,customer:sub.customer,balance_transaction:{created:stamp}};
 const snapshot=x=>structuredClone(x),page=data=>({data:snapshot(data),has_more:false});
 let failStage=null;
 const stripe={
  accounts:{retrieveCurrent:async()=>({id:t.merchant})},balance:{retrieve:async()=>({livemode:false})},
  invoices:{list:async()=>page([invoice])},invoiceItems:{list:async()=>page([])},
  invoicePayments:{list:async()=>page([{id:'ip_'+f.order,object:'invoice_payment',livemode:false,status:'paid',
   invoice:t.invoiceId,amount_paid:6900,currency:'usd',payment:{type:'payment_intent',payment_intent:t.paymentIntentId},status_transitions:{paid_at:stamp}}])},
  paymentIntents:{retrieve:async()=>snapshot(intent)},charges:{retrieve:async()=>snapshot(charge)},
  events:{list:async()=>page(events)},
  subscriptions:{retrieve:async()=>snapshot(sub),
   update:async(id,params,options)=>{
    assert.equal(id,sub.id);writes.push({stage:params.cancel_at_period_end?'stop':'restore',params:snapshot(params),key:options.idempotencyKey});
    const previous=sub.cancel_at_period_end;sub.cancel_at_period_end=params.cancel_at_period_end;
    sub.metadata={...sub.metadata,...params.metadata};
    events.push({id:'evt_'+events.length,type:'customer.subscription.updated',livemode:false,created:Math.floor(Date.now()/1000),
     request:{idempotency_key:options.idempotencyKey},data:{object:snapshot(sub),previous_attributes:{cancel_at_period_end:previous}}});
    if(failStage==='stop')throw new Error('Synthetic timeout after acceptance');return snapshot(sub);
   },
   cancel:async(id,params)=>{
    assert.equal(id,sub.id);assert.deepEqual(params,{invoice_now:false,prorate:false});writes.push({stage:'cancel',params});
    if(failStage==='cancel')throw new Error('Synthetic cancellation timeout');sub.status='canceled';return snapshot(sub);
   }},
  refunds:{list:async()=>page(refunds),retrieve:async id=>snapshot(refunds.find(r=>r.id===id)),
   create:async(params,options)=>{
    writes.push({stage:'refund',params:snapshot(params),key:options.idempotencyKey});
    assert.equal(params.charge,t.chargeId);assert.equal(params.amount,6486);
    if(!refunds.length)refunds.push({id:'re_'+f.order,object:'refund',amount:6486,currency:'usd',charge:t.chargeId,
     payment_intent:t.paymentIntentId,metadata:params.metadata,status:failStage==='failed'?'failed':'succeeded'});
    charge.amount_refunded=refunds[0].status==='succeeded'?6486:0;
    if(failStage==='refund')throw new Error('Synthetic timeout after cash acceptance');return snapshot(refunds[0]);
   }},
 };
 return {stripe,writes,refunds,sub,events,invoice,charge,intent,setFailure(value){failStage=value;}};
}
