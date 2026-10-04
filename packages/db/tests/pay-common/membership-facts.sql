-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
BEGIN;
CREATE FUNCTION pg_temp.assert_true(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT_FAILED: %',label; END IF; END $$;
DO $$
DECLARE actor uuid:=gen_random_uuid(); other_actor uuid:=gen_random_uuid(); sub uuid:=gen_random_uuid(); plan uuid;
  contract jsonb; facts jsonb; denied boolean;
BEGIN
  INSERT INTO profiles(id,membership_level) VALUES(actor,'pro'),(other_actor,'free');
  SELECT id INTO plan FROM membership_plans WHERE level='pro';
  IF plan IS NULL THEN
    INSERT INTO membership_plans(name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
      VALUES('Fixture','pro',false,false,0) RETURNING id INTO plan;
  END IF;
  contract:=jsonb_build_object('version',1,'item_type','membership_plan','item_id',plan,
    'item_updated_at','2026-10-05T00:00:00Z','billing_cycle','monthly','currency','usd','unit','major',
    'price','19.99','discount','0.00','tax_behavior','unspecified','credits',100,'bonus_credits',0);
  INSERT INTO user_subscriptions(id,stripe_subscription_id,user_id,membership_plan_id,status,billing_cycle,payment_channel,merchant_namespace,payment_mode,contract_snapshot)
    VALUES(sub,'sub_facts_fixture',actor,plan,'active','monthly','stripe','acct_fixture','test',contract);
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  SET LOCAL ROLE authenticated;
  facts:=pay_common_membership_facts(actor);
  PERFORM pg_temp.assert_true(facts->'subscriptions'->0->>'mapping_state'='unknown','missing mapping is explicit uncertainty');
  PERFORM pg_temp.assert_true(NOT (facts->'subscriptions'->0 ?| ARRAY['merchant_namespace','payment_mode','contract_snapshot','stripe_subscription_id']),
    'projection exposes no private provider scope or external identity');
  RESET ROLE;
  INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,subscription_id)
    VALUES('stripe','acct_fixture','test','subscription','sub_facts_fixture',sub);
  SET LOCAL ROLE authenticated;
  facts:=pay_common_membership_facts(actor);
  PERFORM pg_temp.assert_true(facts->'subscriptions'->0->>'payment_channel'='stripe'
    AND facts->'subscriptions'->0->>'mapping_state'='mapped','mapping supplies provider classification');
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub',other_actor::text,true);
  SET LOCAL ROLE authenticated;
  denied:=false;
  BEGIN PERFORM pay_common_membership_facts(actor); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  PERFORM pg_temp.assert_true(denied,'other-user projection denied');
  SET LOCAL ROLE anon;
  denied:=false;
  BEGIN PERFORM pay_common_membership_facts(actor); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  PERFORM pg_temp.assert_true(denied,'anonymous projection denied');
  SET LOCAL ROLE service_role;
  facts:=pay_common_membership_facts(actor);
  PERFORM pg_temp.assert_true(facts->'subscriptions'->0->>'mapping_state'='mapped','server recovery can read original facts');
  RESET ROLE;
END $$;
ROLLBACK;
