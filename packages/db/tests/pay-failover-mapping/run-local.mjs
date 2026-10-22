/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
// Standalone data-script verification on disposable local PostgreSQL; no remote credentials/API.
import assert from 'node:assert/strict';
import {localDb,read} from '../runtime-view-perf/local-db.mjs';
const manifest=JSON.parse(read('docs/launch/evidence/pay-failover-products-20261022/products.json'));
const script=read('docs/launch/implementation/PAY_FAILOVER_TEST_MAPPING.sql');
const pro='10000000-0000-4000-8000-000000000002',gold='10000000-0000-4000-8000-000000000003';
const packs=['1','2','3'].map(n=>`30000000-0000-4000-8000-00000000000${n}`);
const old=[
 ['PROD_3JKZPZdJtcSdu9dXdNuJQT',pro,'monthly','standard'],
 ['PROD_2qOnkXjXAGhsxLrbTGsUSb',pro,'yearly','standard'],
 ['PROD_3FNIDuKdkVgvIfd0O4vUzZ',gold,'monthly','standard'],
 ['PROD_0ZleshD5LEYuTruuiVEBNs',gold,'yearly','standard'],
 ['PROD_6bacQZwfKBSKqsuRzGmYaN',gold,'monthly','gold_first30'],
 ['PROD_25Zmm7PVC68mtzM2XkZZAC',gold,'yearly','founder'],
];
const target=p=>p.sku.startsWith('pack')?{membership_plan_id:null,
 credit_package_id:packs[p.sku.startsWith('pack990-')?0:p.sku.startsWith('pack2990-')?1:2]}:
 {membership_plan_id:p.sku.startsWith('pro-')?pro:gold,credit_package_id:null};
assert.equal(manifest.products.length,12);
assert.equal(manifest.mode,'test');assert.equal(manifest.channel,'waffo');
const ids=manifest.products.map(p=>p.product_id),cases=[];
const db=await localDb(),c=db.client;
try {
 // This fixture reproduces the public staging catalog, never staging users or financial records.
 await c.query("DELETE FROM membership_plans WHERE level IN ('pro','gold')");
 await c.query(`INSERT INTO membership_plans(id,name,level,monthly_price,yearly_price,monthly_credits,yearly_credits,
  allow_fusion_review,allow_fusion_compare,library_storage_bytes) VALUES
  ($1,'Pro','pro',2900,27900,3480,41760,false,false,0),($2,'Gold','gold',6900,62100,8970,107640,false,false,0)`,[pro,gold]);
 await c.query(`INSERT INTO credit_packages(id,name,price,credits_amount,bonus_credits) VALUES
  ($1,'990',990,990,0),($2,'2990',2990,2990,0),($3,'10990',9990,9990,1000)`,packs);
 const ref=async({id,plan=pro,pack=null,cycle='monthly',offer='standard',usage='one_time',tier='legacy',
  channel='waffo',mode='test',merchant='waffo_test',current=true})=>{
  const r=await c.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
   membership_plan_id,credit_package_id,billing_cycle,is_current,offer_kind,price_usage,package_tier)
   VALUES($1,$2,$3,'price',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
   [channel,merchant,mode,id,plan,pack,cycle,current,offer,usage,tier]);return r.rows[0].id;
 };
 for(const [id,plan,cycle,offer] of old)await ref({id,plan,cycle,offer,usage:'subscription'});
 await ref({id:'price_stripe_sentinel',channel:'stripe',merchant:'stripe_test'});
 await ref({id:'PROD_live_sentinel',mode:'live',merchant:'waffo_live'});
 const settingsBefore=(await c.query('SELECT * FROM system_settings ORDER BY key')).rows;
 const snapshot=async()=>(await c.query('SELECT * FROM payment_provider_refs ORDER BY id')).rows;
 const original=await snapshot();
 const mapped=async()=>(await c.query('SELECT * FROM payment_provider_refs WHERE external_id=ANY($1) ORDER BY external_id',[ids])).rows;
 const reset=()=>c.query('DELETE FROM payment_provider_refs WHERE external_id=ANY($1)',[ids]);
 const applied=await c.query(script);
 const output=applied.find(result=>result.fields.some(field=>field.name==='expected_usd_minor')).rows;
 for(const p of manifest.products)assert.equal(output.find(row=>row.sku===p.sku)?.expected_usd_minor,
  Number(p.amount.replace('.','')),`${p.sku}: exact manifest USD minor amount`);
 const first=await mapped();assert.equal(first.length,12);
 for(const p of manifest.products){
  const r=first.find(row=>row.external_id===p.product_id);
  for(const [key,value] of Object.entries({...target(p),channel:'waffo',mode:'test',object_type:'price',
   merchant_namespace:manifest.merchant_namespace,billing_cycle:p.billing_cycle,offer_kind:p.offer_kind,
   price_usage:p.price_usage,package_tier:p.package_tier,is_current:true}))assert.equal(r[key],value,`${p.sku}: ${key}`);
 }
 cases.push('12-exact-public-manifest-associations');
 await c.query(script);assert.deepEqual(await mapped(),first);cases.push('same-ID-current-replay-noop');
 const preserved=(await snapshot()).filter(r=>!ids.includes(r.external_id));assert.deepEqual(preserved,original);
 assert.deepEqual((await c.query('SELECT * FROM system_settings ORDER BY key')).rows,settingsBefore);
 cases.push('legacy-six-live-stripe-and-settings-unchanged');
 await reset();
 const reject=async({name,setup,cleanup,pattern})=>{
  const context=await setup(),before=await snapshot();
  await assert.rejects(()=>c.query(script),pattern);await c.query('ROLLBACK');
  assert.deepEqual(await snapshot(),before,'rejected batch must not alter even one mapping');
  if(cleanup)await cleanup(context);cases.push(name);
 };
 await reject({name:'different-current-final-SKU-rejects-all-12',
  setup:()=>ref({id:'PROD_conflicting_current',plan:null,pack:packs[2],cycle:'one_time',usage:'package',tier:'gold'}),
  cleanup:id=>c.query('DELETE FROM payment_provider_refs WHERE id=$1',[id]),pattern:/CURRENT_CONFLICT/});
 await reject({name:'inactive-identical-ID-not-silently-reactivated',
  setup:()=>ref({id:ids[0],current:false}),cleanup:reset,pattern:/EXISTING_ID_CONFLICT/});
 await reject({name:'same-product-wrong-namespace-refuses-entire-batch',
  setup:()=>ref({id:ids[0],merchant:'other_test'}),cleanup:reset,pattern:/EXISTING_ID_CONFLICT/});
 await reject({name:'manifest-product-live-collision-is-read-only',
  setup:()=>ref({id:ids[0],mode:'live',merchant:'other_live'}),cleanup:reset,pattern:/PRODUCT_ALREADY_LEGACY_OR_LIVE/});
 await reject({name:'manifest-product-subscription-collision-is-read-only',
  setup:()=>ref({id:ids[0],usage:'subscription',merchant:'other_test'}),cleanup:reset,pattern:/PRODUCT_ALREADY_LEGACY_OR_LIVE/});
 await reject({name:'missing-original-test-binding-refuses-entire-batch',setup:async()=>{
  await c.query('DELETE FROM payment_provider_refs WHERE external_id=$1',[old[0][0]]);
 },cleanup:()=>ref({id:old[0][0],plan:pro,usage:'subscription'}),pattern:/TEST_BINDING_CHANGED/});
 await reject({name:'changed-catalog-price-refuses-entire-batch',setup:()=>c.query('UPDATE credit_packages SET price=1000 WHERE id=$1',[packs[0]]),
  cleanup:()=>c.query('UPDATE credit_packages SET price=990 WHERE id=$1',[packs[0]]),pattern:/CATALOG_CHANGED/});
 await c.query(script);assert.equal((await mapped()).length,12);cases.push('valid-batch-remains-applicable-after-rejections');
 console.log(JSON.stringify({result:'PASS',cases:cases.length,checks:cases,replay:db.build}));
} finally {await c.query('ROLLBACK').catch(()=>{});await db.close();}
