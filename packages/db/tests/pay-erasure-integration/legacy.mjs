/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {transport} from '../monthly-refund/adapter.mjs';
const sourceRef='0752f863d9c7be21c9104df30d2419a6da22c482';
export async function checkLegacy({db,ts,run,report}){
 const result=run('git',['show',sourceRef+':apps/web/src/app/api/upload/route.ts']);
 assert.equal(result.status,0);const source=result.stdout;
 assert.ok(source.includes('.upload(fileName, buffer'));assert.ok(!source.includes('ticket_upload_begin'));
 await db.query('BEGIN');
 try{
 await db.query("update system_settings set value='false'::jsonb where key='maintenance_mode'");
 const f=(await db.query("select f from monthly_test.upgrade_facts where kind='open'")).rows[0].f;
 const closed=(await db.query("select f from monthly_test.upgrade_facts where kind='closed'")).rows[0].f;
 const data=transport(db);let actor=f.user;let uploads=0;
 const client={...data,auth:{getUser:async()=>({data:{user:{id:actor}},error:null})},
  storage:{from(bucket){assert.equal(bucket,'ticket-attachments');return {upload:async(path)=>{
   uploads++;assert.ok(path.startsWith(actor+'/'));return {data:{path},error:null};
  }};}}};
 const exports={};
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 // Evaluate the exact old business code; inject only framework/Auth/Storage transports and synthetic env.
 new Function('require','exports','process',code)(name=>{
  if(name==='next/server')return {NextResponse:{json:(data,init)=>new Response(JSON.stringify(data),init)}};
  if(name==='@supabase/supabase-js')return {createClient:()=>client};
  if(name==='@/lib/server-log')return {logServerError:()=>{}};
  throw new Error('Unexpected legacy import: '+name);
 },exports,{env:{NEXT_PUBLIC_SUPABASE_URL:'https://erasure.invalid',NEXT_PUBLIC_SUPABASE_ANON_KEY:'synthetic',SUPABASE_SERVICE_ROLE_KEY:'synthetic'}});
 const request=()=>({headers:new Headers({Authorization:'Bearer synthetic'}),formData:async()=>{
  const form=new FormData();form.set('file',new File(['synthetic'],'tiny.png',{type:'image/png'}));return form;
 }});
 const allowed=await exports.POST(request());assert.equal(allowed.status,200,await allowed.text());assert.equal(uploads,1);
 assert.equal((await db.query('select count(*)::int n from ticket_upload_intents')).rows[0].n,0,'old upload leaves no intent: never drain evidence');
 actor=closed.user;assert.equal((await exports.POST(request())).status,403);assert.equal(uploads,1);
 const grant=(await db.query('select * from subscription_credit_grants where id=$1',[f.grant])).rows[0];
 const invoice=(invoiceId,key,period,start,end)=>db.query(`select * from atomic_grant_subscription_invoice_credits(
  p_user_id=>$1,p_membership_plan_id=>$2,p_stripe_subscription_id=>$3,p_stripe_invoice_id=>$4,p_source_order_id=>$5,
  p_amount_total=>6900,p_currency=>'usd',p_stripe_customer_id=>$6,p_grant_period_key=>$7,p_period_start=>$8,p_period_end=>$9,
  p_total_periods=>null,p_credits_granted=>1100,p_membership_level=>'pro',p_idempotency_key=>$10,p_metadata=>$11)`,
 [f.user,f.terms.snapshot.item_id,f.terms.providerSubscriptionId,invoiceId,f.order,'cus_'+f.user,period,start,end,key,
  {stripeSubscriptionStatus:'active',stripeSubscriptionUserId:f.user}]);
 await invoice(f.terms.invoiceId,grant.idempotency_key,grant.grant_period_key,grant.period_start,grant.period_end);
 assert.equal((await db.query('select credits from profiles where id=$1',[f.user])).rows[0].credits,1500);
 const end=(await db.query("select ($1::timestamptz+interval '1 month') next_end",[f.terms.periodEnd])).rows[0].next_end;
 await invoice('in_legacy_renewal_'+f.order,'legacy-renewal:'+f.order,'monthly:legacy-renewal',f.terms.periodEnd,end);
 assert.equal((await db.query('select credits from profiles where id=$1',[f.user])).rows[0].credits,2600);
 report.checks.push('exact old 0752f863 upload handler + upgraded SQL: open allowed, closed denied, no intent falsely claimed; old invoice RPC replay/new renewal correct');
 }finally{await db.query('ROLLBACK');}
}
