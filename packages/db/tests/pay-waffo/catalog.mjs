/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';

export async function catalogCases({admin,service}) {
  const plan=(await admin.query("SELECT id,monthly_price FROM membership_plans WHERE level='gold'")).rows[0];
  for(const offer of ['standard','gold_first30','founder']) {
    await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
      membership_plan_id,billing_cycle,is_current,offer_kind) VALUES('stripe','catalog_fixture','test','price',$1,$2,'monthly',true,$3)`,
    [`price_catalog_${offer}`,plan.id,offer]);
  }
  const save=external=>service.query(`SELECT pay_common_save_catalog('membership_plan',$1,'{}',$2,'catalog_fixture','test','gold')`,
    [plan.id,{monthly:external===null?null:{external_id:external,unit_amount:plan.monthly_price,
      currency:'usd',mode:'test',billing_cycle:'monthly'}}]);
  const current=async()=> (await admin.query(`SELECT external_id FROM payment_provider_refs
    WHERE merchant_namespace='catalog_fixture' AND is_current ORDER BY external_id`)).rows.map(r=>r.external_id);
  await assert.rejects(()=>save('price_catalog_founder'),/PRICE_MAPPING_CONFLICT/);
  assert.equal((await current()).length,3,'rejected offer adoption leaves all mappings intact');
  await save('price_catalog_replacement');
  assert.deepEqual(await current(),['price_catalog_founder','price_catalog_gold_first30','price_catalog_replacement']);
  await save(null);
  assert.deepEqual(await current(),['price_catalog_founder','price_catalog_gold_first30']);
  return ['catalog-rejects-offer-adoption','catalog-replacement-preserves-offers','catalog-clear-preserves-offers'];
}
