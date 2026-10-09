/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const tables=['profiles','payment_orders','payment_provider_refs','user_subscriptions','subscription_credit_grants',
 'credit_transactions','billing_history','tickets','ticket_replies','account_erasure_requests','bill2_runs','bill2_calls',
 'runtime_sessions','runtime_executions'];
export function captureUpgrade(sql){
 return Object.fromEntries(tables.map(table=>[table,JSON.parse(sql(`SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM public.${table} t;`))]));
}
export function seedUpgrade({sql,read,snapshot,report}){
 assert.equal(JSON.parse(sql("SELECT to_json(to_regprocedure('public.account_erasure_progress_read(uuid,text)') IS NULL);")),true);
 assert.equal(JSON.parse(sql("SELECT to_json(to_regclass('public.ticket_upload_intents') IS NULL);")),true);
 const before=snapshot();
 // This replay starts at 0186; the current staging snapshot advances after later migrations.
 const saved=JSON.parse(read('packages/db/tests/pay-erasure-integration/staging-0186-fingerprint.json'));
 const allowed=JSON.parse(read('packages/db/tests/baseline/expected-differences.json')).platformOnlyOnStaging.keys;
 const groups=JSON.parse(sql(read('packages/db/tests/baseline/fingerprint.sql')));
 const differences=[];
 for(const group of new Set([...Object.keys(groups),...Object.keys(saved.groups)])){
  if(groups[group]?.startsWith(saved.groups[group]??'absent'))continue;
  if(!(group in groups)&&allowed.includes(group))continue;
  const keys=new Set([...Object.keys(before),...Object.keys(saved.objects)].filter(k=>k.split('.')[0]===group));
  for(const key of keys){
   const actual=before[key],expected=saved.objects[key];
   if(expected===undefined||actual===undefined||(/^(acl|defacl):/.test(key)?actual!==expected:
    !createHash('md5').update(actual??'<null>').digest('hex').startsWith(expected)))differences.push(key);
  }
 }
 assert.deepEqual(differences,[],'0186 matches saved staging catalog except existing declared platform-only objects');
 report.checks.push('0186 starting catalog matches saved 1341-group staging snapshot at recorded precision; only existing platform-only exclusions');
 report.upgrade={from:'0186',startObjects:Object.keys(before).length,source:'local canonical 0186; not remote data'};
 sql(read('packages/db/tests/monthly-refund/fixture.sql'));
 sql(read('packages/db/tests/erasure-b2a/fixture.sql'));
 sql(`CREATE TABLE monthly_test.upgrade_facts(kind text PRIMARY KEY,f jsonb);
 INSERT INTO monthly_test.upgrade_facts VALUES('open',monthly_test.fixture()),('closed',monthly_test.fixture()),
 ('pending',monthly_test.fixture()),('runtime',b2a_test.fixture());
 UPDATE tickets SET attachments=jsonb_build_array(user_id::text||'/legacy.png')
 WHERE id IN (SELECT (f->>'ticket')::uuid FROM monthly_test.upgrade_facts WHERE kind<>'runtime');
 INSERT INTO ticket_replies(ticket_id,user_id,content,attachments,is_deleted,deleted_at)
 SELECT (f->>'ticket')::uuid,(f->>'actor')::uuid,'Synthetic',
  jsonb_build_array((f->>'actor')||'/admin-legacy.png'),'true',clock_timestamp()-interval '40 days'
 FROM monthly_test.upgrade_facts WHERE kind='closed';
 UPDATE tickets SET is_deleted='true',deleted_at=clock_timestamp()-interval '40 days'
 WHERE id=(SELECT (f->>'ticket')::uuid FROM monthly_test.upgrade_facts WHERE kind='closed');
 DO $$ DECLARE f jsonb; c jsonb; BEGIN
  SELECT x.f INTO f FROM monthly_test.upgrade_facts x WHERE kind='pending';
  UPDATE payment_orders SET refund_approval=jsonb_build_object('kind','monthly_first_purchase','id',gen_random_uuid(),
   'status','review_required','terms',f->'terms','versionHash',repeat('b',64),'claimedAt',clock_timestamp(),
   'idempotencyKey','original-unresolved-monthly','unknownOriginalEvidence',true) WHERE id=(f->>'order')::uuid;
  FOR f IN SELECT x.f FROM monthly_test.upgrade_facts x WHERE kind IN ('closed','pending') LOOP
   UPDATE user_subscriptions SET cancel_at_period_end='true' WHERE id=(f->>'subscription')::uuid;
   PERFORM account_erasure_confirm((f->>'user')::uuid,gen_random_uuid());
  END LOOP;
  SELECT x.f INTO f FROM monthly_test.upgrade_facts x WHERE kind='runtime';
  PERFORM b2a_test.bind(f);
  c:=bill2_claim((f->>'actor')::uuid,(f->>'run')::uuid,1,
   jsonb_build_object('provider','fixture','account','sandbox','model','b2a-fixture','protocol','fixture-cost-v1',
   'phase','reply','requestHash',repeat('b',64),'upperUsd','0.005','inputLimit',1000,'outputLimit',1000,
   'automaticRetry',false,'hiddenTools',false,'lookupSupported',true));
  PERFORM bill2_dispatch((f->>'actor')::uuid,(f->>'run')::uuid,(c->>'id')::uuid,(c->>'dispatchToken')::uuid);
 END $$;`);
 return captureUpgrade(sql);
}
export async function verifyUpgrade({db,before,sql,snapshot,built,report}){
 const after=captureUpgrade(sql);
 for(const table of tables){
  const old=before[table];const current=after[table];assert.equal(current.length,old.length,table+' row count');
  for(const row of old){
   const key='id' in row?'id':'profile_id';const next=current.find(value=>value[key]===row[key]);assert.ok(next,table+' identity');
   assert.deepEqual(Object.fromEntries(Object.keys(row).map(k=>[k,next[k]])),row,table+' original fields preserved');
  }
 }
 const actual=Object.fromEntries(Object.entries(snapshot()).map(([k,v])=>[k,createHash('md5').update(v??'<null>').digest('hex').slice(0,12)]));
 assert.deepEqual(actual,built.objects,'0196 built catalog matches new migration');
 const pending=(await db.query("select f from monthly_test.upgrade_facts where kind='pending'")).rows[0].f;
 const proof=(await db.query('select account_erasure_financial_proof($1) p',[pending.user])).rows[0].p;
 assert.ok(proof.financialPending>0&&proof.manualReview>0,'pre-existing unresolved approval stays pending');
 for(const role of ['anon','authenticated']){
  await db.query('SET ROLE '+role);
  await assert.rejects(db.query('select pay_common_monthly_refund_claim($1,$2,$3,$4)',
   [pending.actor,pending.order,pending.order,pending.terms]),/permission denied/);
  await assert.rejects(db.query('select account_erasure_progress_read($1,$2)',[pending.order,'a'.repeat(64)]),/permission denied/);
  await db.query('RESET ROLE');
 }
 report.checks.push('0186 populated upgrade: original rows/money/approval/hash/Runtime dispatch and identities preserved through 0187–0196');
 report.checks.push('0196 catalog exactly matches updated built; unresolved inherited approval blocks financial completion; public roles denied');
}
