/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';

const fresh=async db=>{
 const actor=randomUUID();
 await db.query('INSERT INTO profiles(id,credits) VALUES($1,73)',[actor]);
 return {actor};
};
const request=async(db,f)=>(await db.query(
 'SELECT * FROM account_erasure_requests WHERE profile_id=$1',[f.actor])).rows[0];
const close=async(db,f)=>{await closeAccount(db,f);return (await request(db,f)).request_id;};
const cleanup=(db,f,verified=true)=>rpc(db,'account_erasure_local_cleanup',f.actor,verified);
const begin=(db,f,id)=>rpc(db,'account_erasure_auth_begin',f.actor,id);
const finish=(db,f,id,absent)=>rpc(db,'account_erasure_auth_result',f.actor,id,absent);
const role=async(db,name,run)=>{
 await db.query('SET ROLE '+name);
 try{return await run();}finally{await db.query('RESET ROLE');}
};
const order=async(db,f,metadata={},extra={})=>{
 const id=randomUUID();
 await db.query(`INSERT INTO payment_orders(id,user_id,item_type,item_id,mode,status,metadata,
  refund_approval,checkout_request,purchase_change_request,payment_channel,merchant_namespace,payment_mode,
  purchase_request_id,purchase_payload_hash,purchase_snapshot,amount_total,currency,payment_status,fulfilled_at,purchase_closed_at,purchase_close_reason)
  VALUES($1,$2,'credit_package',$3,'payment',$7,$4,$5,$6,$8,$9,$10,$11,$12,$13,$14,1799,'usd',
   CASE WHEN $7 IN ('completed','refunded','partially_refunded') THEN 'paid' ELSE 'unpaid' END,
   CASE WHEN $7 IN ('completed','refunded','partially_refunded') THEN clock_timestamp() ELSE NULL END,
   CASE WHEN $7 IN ('failed','expired') THEN clock_timestamp() ELSE NULL END,
   CASE WHEN $7 IN ('failed','expired') THEN 'stripe_checkout_expired' ELSE NULL END)`,
 [id,f.actor,extra.snapshot?.item_id??randomUUID(),metadata,extra.refund??null,extra.checkout??null,
  extra.status??'completed',extra.change??null,extra.snapshot?'stripe':null,extra.snapshot?'synthetic':null,
  extra.snapshot?'test':null,extra.snapshot?randomUUID():null,extra.snapshot?'a'.repeat(64):null,extra.snapshot??null]);
 return id;
};

// The canonical runner supplies a disposable database. Do not wrap these cases in one
// transaction: closure's committed barrier must precede the cleanup transaction.
export async function runCases(db,report){
 const active=await fresh(db),other=await fresh(db),upload=randomUUID();
 for(const name of ['anon','authenticated'])await role(db,name,async()=>{
  await assert.rejects(rpc(db,'ticket_upload_begin',active.actor,upload),/permission denied/);
  await assert.rejects(rpc(db,'ticket_upload_finish',active.actor,upload,true),/permission denied/);
  await assert.rejects(begin(db,active,randomUUID()),/permission denied/);
  await assert.rejects(finish(db,active,randomUUID(),true),/permission denied/);
 });
 await role(db,'service_role',async()=>{
  assert.deepEqual(await rpc(db,'ticket_upload_begin',active.actor,upload),{admitted:true});
  await assert.rejects(rpc(db,'ticket_upload_begin',active.actor,upload),/duplicate key/);
  await assert.rejects(rpc(db,'ticket_upload_begin',other.actor,upload),/duplicate key/);
  await assert.rejects(rpc(db,'ticket_upload_finish',other.actor,upload,true),/UPLOAD_IDENTITY_MISMATCH/);
  assert.deepEqual(await rpc(db,'ticket_upload_finish',active.actor,upload,false),{released:true,closed:false});
 });
 assert.equal((await db.query('SELECT count(*)::int n FROM ticket_upload_intents WHERE upload_id=$1',[upload])).rows[0].n,0);
 await close(db,active); // Successful upload finished before closure; Storage still needs its own proof.
 await assert.rejects(rpc(db,'ticket_upload_begin',active.actor,randomUUID()),/UPLOAD_ACCOUNT_CLOSED/);
 const suspended=await fresh(db);
 await db.query("UPDATE profiles SET status='suspended' WHERE id=$1",[suspended.actor]);
 await assert.rejects(rpc(db,'ticket_upload_begin',suspended.actor,randomUUID()),/UPLOAD_ACCOUNT_CLOSED/);
 await assert.rejects(rpc(db,'ticket_upload_begin',randomUUID(),randomUUID()),/UPLOAD_ACCOUNT_CLOSED/);
 await assert.rejects(rpc(db,'ticket_upload_begin',other.actor,null),/UPLOAD_INVALID/);
 report.checks.push('upload admission: active allowed; suspended/closed/missing denied; duplicate and cross-subject denied; RPC roles');

 const drain=await fresh(db),pending=randomUUID();
 await db.query(`UPDATE profiles SET email=$2,nickname='PRIVATE',avatar_url='https://example.test/private',
  last_ip='192.0.2.1',last_login_at=now() WHERE id=$1`,[drain.actor,drain.actor+'@example.test']);
 const ticket=(await db.query("INSERT INTO tickets(user_id,title) VALUES($1,'PRIVATE') RETURNING id",[drain.actor])).rows[0].id;
 await db.query("INSERT INTO ticket_replies(ticket_id,user_id,content,is_admin) VALUES($1,$2,'PRIVATE','true')",[ticket,other.actor]);
 await rpc(db,'ticket_upload_begin',drain.actor,pending);
 const drainId=await close(db,drain);
 assert.equal((await rpc(db,'account_erasure_storage_ready',drain.actor)).ready,false);
 assert.deepEqual(await rpc(db,'ticket_upload_finish',drain.actor,pending,false),{released:false,closed:true});
 await assert.rejects(rpc(db,'ticket_upload_finish',drain.actor,pending,null),/UPLOAD_INVALID/);
 let cleaned=await cleanup(db,drain);
 assert.ok(cleaned.remaining>0);assert.ok(cleaned.errors.includes('ERASURE_STORAGE_PENDING'));
 assert.equal((await begin(db,drain,drainId)).ready,false);
 assert.equal((await db.query('SELECT count(*)::int n FROM tickets WHERE id=$1',[ticket])).rows[0].n,1);
 assert.equal((await request(db,drain)).storage_verified_at,null);
 const profile=(await db.query('SELECT * FROM profiles WHERE id=$1',[drain.actor])).rows[0];
 assert.equal(profile.id,drain.actor);assert.equal(profile.credits,73);
 assert.equal(profile.status,'deleted');assert.equal(String(profile.is_deleted),'true');
 for(const key of ['email','nickname','avatar_url','last_ip','last_login_at']){
  assert.equal(profile[key],null);
  const value=key==='last_login_at'?'2026-10-07T00:00:00Z':'PRIVATE';
  await assert.rejects(db.query(`UPDATE profiles SET ${key}=$2 WHERE id=$1`,[drain.actor,value]),/ACCOUNT_ERASURE_IDENTITY_REFILL/);
 }
 await assert.rejects(db.query("INSERT INTO ticket_replies(ticket_id,user_id,content) VALUES($1,$2,'late')",[ticket,other.actor]),
  /ACCOUNT_ERASURE_TICKET_CLOSED/);
 assert.deepEqual(await rpc(db,'ticket_upload_finish',drain.actor,pending,true),{released:true,closed:true});
 assert.equal((await rpc(db,'account_erasure_storage_ready',drain.actor)).ready,true);
 cleaned=await cleanup(db,drain,false);
 assert.ok(cleaned.errors.includes('ERASURE_STORAGE_PENDING'));
 assert.equal((await begin(db,drain,drainId)).ready,false);
 assert.equal((await request(db,drain)).auth_delete_started_at,null);
 await assert.rejects(cleanup(db,drain,null),/ERASURE_INVALID_STORAGE_PROOF/);
 cleaned=await cleanup(db,drain);
 assert.deepEqual(cleaned,{remaining:0,manualReview:0,errors:[]});
 assert.equal((await db.query('SELECT count(*)::int n FROM ticket_replies WHERE ticket_id=$1',[ticket])).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int n FROM tickets WHERE id=$1',[ticket])).rows[0].n,0);
 report.checks.push('close-before-finish drains only confirmed absence; storage false blocks Auth; profile identity scrub preserves credits and rejects refill');

 // Original evidence remains byte-for-byte JSON-identical. Scrubbing metadata never
 // authorizes changing or replacing a refund approval or frozen checkout request.
 const refund={status:'review_required',idempotencyKey:'synthetic-original-refund',feeEvidence:{body:'PRIVATE'}};
 const checkout={legacy:'PRIVATE',idempotencyKey:'synthetic-original-checkout'};
 for(const test of [
  {name:'pending original refund',metadata:{},extra:{refund},pending:true},
  {name:'pending frozen checkout evidence',metadata:{},extra:{checkout,status:'pending'},pending:true},
  {name:'malformed financial metadata',metadata:{grantedCredits:{body:'PRIVATE'},body:'PRIVATE'},extra:{},pending:false},
 ]){
  const f=await fresh(db),id=await order(db,f,test.metadata,test.extra),rid=await close(db,f);
  await rpc(db,'account_erasure_scrub_payment',f.actor,'payment_orders',100,null);
  const result=await cleanup(db,f);
  assert.ok(result.manualReview>0,test.name);
  const proof=await rpc(db,'account_erasure_work_batch',f.actor,20,null);
  assert.ok(proof.manualReview>0,test.name);
  if(test.pending)assert.ok(proof.financialPending>0,test.name);
  const state=await request(db,f);
  assert.equal(state.stage,'billing_pending');assert.ok(state.review_codes.length>0);
  assert.equal((await begin(db,f,rid)).ready,false);assert.equal((await request(db,f)).auth_delete_started_at,null);
  await assert.rejects(finish(db,f,rid,true),/ERASURE_IDENTITY_MISMATCH/);
  const saved=(await db.query('SELECT refund_approval,checkout_request,metadata FROM payment_orders WHERE id=$1',[id])).rows[0];
  assert.deepEqual(saved.refund_approval,test.extra.refund??null);
  assert.deepEqual(saved.checkout_request,test.extra.checkout??null);
  if(test.name==='malformed financial metadata'){
   assert.deepEqual(saved.metadata.grantedCredits,{body:'PRIVATE'});assert.equal(saved.metadata.body,undefined);
  }
  report.checks.push(test.name+': manual review blocks Auth; original evidence retained');
 }

 const snapshot={version:1,item_type:'credit_package',item_id:randomUUID(),item_updated_at:'2026-10-07T00:00:00Z',
  billing_cycle:'one_time',currency:'usd',unit:'major',price:'19.99',discount:'2.00',tax_behavior:'unspecified',
  credits:100,bonus_credits:20};
 const checkoutSafe={mode:'payment',payment_method_types:['card','alipay'],customer_creation:'always',
  client_reference_id:'synthetic-subject',expires_at:1791331200,
  line_items:[{quantity:1,price_data:{currency:'usd',unit_amount:1799}}],
  metadata:{itemType:'credit_package'},payment_intent_data:{metadata:{itemType:'credit_package'}}};
 const checkoutDirty={...checkoutSafe,success_url:'https://example.test/PRIVATE',cancel_url:'https://example.test/PRIVATE',
  body:'PRIVATE',line_items:[{...checkoutSafe.line_items[0],price_data:{...checkoutSafe.line_items[0].price_data,
   product_data:{name:'PRIVATE'}}}]};
 const changeSafe={originalPrice:'price_original',itemId:snapshot.item_id,createdAt:1791331200,
  quote:{amountDue:1799,currency:'usd',quotedAt:1791331200,fingerprint:'synthetic',freshnessProof:'synthetic'},
  stripeMetadata:{itemId:snapshot.item_id}};
 const changeDirty={...changeSafe,body:'PRIVATE',quote:{...changeSafe.quote,body:'PRIVATE'}};
 for(const status of ['completed','expired']){
  const f=await fresh(db),id=await order(db,f,{}, {status,snapshot,checkout:checkoutDirty,change:changeDirty});
  const row=async()=>(await db.query('SELECT * FROM payment_orders WHERE id=$1',[id])).rows[0];
  await close(db,f);
  await rpc(db,'account_erasure_scrub_payment',f.actor,'payment_orders',100,null);
  const before=await row();
  await assert.rejects(db.query(`UPDATE payment_orders SET checkout_request=$2,purchase_change_request=$3,
   request_erased_at=clock_timestamp(),amount_total=99999 WHERE id=$1`,[id,checkoutSafe,changeSafe]),/ERASURE_ENVELOPE_DENIED/);
  assert.equal((await row()).request_erased_at,null);
  assert.deepEqual(await cleanup(db,f),{remaining:0,manualReview:0,errors:[]});
  const after=await row();
  assert.deepEqual(after.checkout_request,checkoutSafe);assert.deepEqual(after.purchase_change_request,changeSafe);
  assert.ok(after.request_erased_at);
  const finance=r=>Object.fromEntries(Object.entries(r).filter(([k])=>
   !['checkout_request','purchase_change_request','request_erased_at'].includes(k)));
  assert.deepEqual(finance(after),finance(before));
  assert.deepEqual(after.purchase_snapshot,snapshot);assert.equal(after.purchase_payload_hash,'a'.repeat(64));
  await assert.rejects(db.query('UPDATE payment_orders SET request_erased_at=NULL WHERE id=$1',[id]),/ERASURE_ENVELOPE_REFILL/);
  await assert.rejects(db.query('UPDATE payment_orders SET checkout_request=$2 WHERE id=$1',[id,checkoutDirty]),/ERASURE_ENVELOPE_REFILL/);
 }
 for(const extra of [
  {checkout:{...checkoutDirty,line_items:[{quantity:1,price_data:{currency:'usd',unit_amount:'1799'}}]}},
  {change:{...changeDirty,quote:{...changeDirty.quote,amountDue:'1799'}}},
 ]){
  const f=await fresh(db),id=await order(db,f,{},extra),rid=await close(db,f);
  await rpc(db,'account_erasure_scrub_payment',f.actor,'payment_orders',100,null);
  const result=await cleanup(db,f);
  assert.ok(result.manualReview>0);assert.ok(result.errors.includes('ERASURE_PAYMENT_REQUEST_REVIEW'));
  const saved=(await db.query('SELECT checkout_request,purchase_change_request,request_erased_at FROM payment_orders WHERE id=$1',[id])).rows[0];
  assert.deepEqual(saved.checkout_request,extra.checkout??null);
  assert.deepEqual(saved.purchase_change_request,extra.change??null);assert.equal(saved.request_erased_at,null);
  assert.equal((await begin(db,f,rid)).ready,false);
 }
 report.checks.push('terminal envelopes: fixed projection, price/tax/hash unchanged, first-marker finance tamper/refill denied; malformed numbers retained/manual');

 const minimal=await fresh(db),rid=await close(db,minimal);
 for(const name of ['anon','authenticated'])await role(db,name,async()=>{
  await assert.rejects(rpc(db,'account_erasure_progress_issue',minimal.actor,rid,'b'.repeat(64)),/permission denied/);
  await assert.rejects(rpc(db,'account_erasure_progress_read',rid,'b'.repeat(64)),/permission denied/);
 });
 await role(db,'service_role',async()=>{
  assert.deepEqual(await rpc(db,'account_erasure_progress_issue',minimal.actor,randomUUID(),'b'.repeat(64)),{issued:false});
  assert.deepEqual(await rpc(db,'account_erasure_progress_issue',minimal.actor,rid,'b'.repeat(64)),{issued:true});
  assert.deepEqual(await rpc(db,'account_erasure_progress_issue',minimal.actor,rid,'c'.repeat(64)),{issued:false});
  assert.equal(await rpc(db,'account_erasure_progress_read',rid,'c'.repeat(64)),null);
  assert.equal(await rpc(db,'account_erasure_progress_read',randomUUID(),'b'.repeat(64)),null);
  const progress=await rpc(db,'account_erasure_progress_read',rid,'b'.repeat(64));
  assert.equal(typeof progress.stage,'string');
  assert.deepEqual(Object.keys(progress).sort(),['confirmedAt','needsReview','stage','updatedAt']);
 });
 await db.query("UPDATE account_erasure_requests SET progress_expires_at=clock_timestamp()-interval '1 second' WHERE profile_id=$1",
  [minimal.actor]); // Test-owner fixture adjustment; no expiry is used to bypass deletion proof.
 assert.equal(await role(db,'service_role',()=>rpc(db,'account_erasure_progress_read',rid,'b'.repeat(64))),null);
 report.checks.push('progress capability: service-only issue/read, immutable token, wrong token/request and expired token denied');
 await assert.rejects(begin(db,minimal,randomUUID()),/ERASURE_IDENTITY_MISMATCH/);
 await assert.rejects(finish(db,minimal,rid,true),/ERASURE_IDENTITY_MISMATCH/);
 assert.deepEqual(await cleanup(db,minimal),{remaining:0,manualReview:0,errors:[]});
 const claim=await role(db,'service_role',()=>begin(db,minimal,rid));
 assert.deepEqual(claim,{ready:true,alreadyDeleted:false,started:true,claimed:true,requestId:rid});
 const started=(await request(db,minimal)).auth_delete_started_at;
 const resumed=await begin(db,minimal,rid);
 assert.deepEqual(resumed,{...claim,claimed:false});
 assert.deepEqual((await request(db,minimal)).auth_delete_started_at,started);
 await assert.rejects(finish(db,minimal,randomUUID(),true),/ERASURE_IDENTITY_MISMATCH/);
 for(const absent of [false,null]){
  assert.notEqual((await finish(db,minimal,rid,absent)).stage,'completed');
  assert.equal((await request(db,minimal)).auth_deleted_at,null);
 }
 assert.deepEqual(await role(db,'service_role',()=>finish(db,minimal,rid,true)),{stage:'completed'});
 const completed=await request(db,minimal);
 assert.ok(completed.auth_deleted_at);assert.ok(completed.local_cleaned_at);assert.ok(completed.storage_verified_at);
 assert.deepEqual(await finish(db,minimal,rid,true),{stage:'completed'});
 assert.deepEqual((await request(db,minimal)).auth_deleted_at,completed.auth_deleted_at);
 assert.deepEqual(await begin(db,minimal,rid),{...claim,claimed:false,alreadyDeleted:true});
 assert.equal((await db.query('SELECT credits FROM profiles WHERE id=$1',[minimal.actor])).rows[0].credits,73);
 report.checks.push('minimal subject completes only after absence proof; Auth claim once; original request resumes; wrong request/false/null never complete');
}
