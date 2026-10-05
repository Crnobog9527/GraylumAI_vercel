-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
BEGIN;
CREATE FUNCTION pg_temp.expect_report_denied(actor uuid, expected text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 BEGIN PERFORM report_membership_check(actor);
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM=expected THEN RETURN; END IF; RAISE;
 END;
 RAISE EXCEPTION 'EXPECTED_REPORT_DENIAL: %',expected;
END $$;
DO $$
DECLARE actor uuid:=gen_random_uuid(); sub uuid:=gen_random_uuid(); plan uuid; contract jsonb;
BEGIN
 INSERT INTO profiles(id,membership_level,credits) VALUES(actor,'free',1000);
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 SET LOCAL ROLE service_role;
 PERFORM pg_temp.expect_report_denied(actor,'REPORT_MEMBERSHIP_REQUIRED');
 RESET ROLE;
 UPDATE profiles SET membership_level='pro' WHERE id=actor;
 -- Existing profile-backed entitlement (including grants from one-time fulfillment).
 SET LOCAL ROLE service_role; PERFORM report_membership_check(actor); RESET ROLE;
 SELECT id INTO plan FROM membership_plans WHERE level='pro';
 IF plan IS NULL THEN INSERT INTO membership_plans(name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
  VALUES('Report fixture','pro',true,true,1048576) RETURNING id INTO plan;END IF;
 contract:=jsonb_build_object('version',1,'item_type','membership_plan','item_id',plan,
  'item_updated_at','2026-10-05T00:00:00Z','billing_cycle','monthly','currency','usd','unit','major',
  'price','19.99','discount','0.00','tax_behavior','unspecified','credits',100,'bonus_credits',0);
 INSERT INTO user_subscriptions(id,user_id,membership_plan_id,stripe_subscription_id,status,billing_cycle,current_period_end,
  payment_channel,merchant_namespace,payment_mode,contract_snapshot)
  VALUES(sub,actor,plan,'report-local-fixture','active','monthly',now()+interval '1 month','stripe','report-local','test',contract);
 SET LOCAL ROLE service_role; PERFORM pg_temp.expect_report_denied(actor,'REPORT_ENTITLEMENTS_UNAVAILABLE'); RESET ROLE;
 INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,subscription_id)
  VALUES('stripe','report-local','test','subscription','report-local-fixture',sub);
 SET LOCAL ROLE service_role; PERFORM report_membership_check(actor); RESET ROLE;
 UPDATE user_subscriptions SET cancel_at_period_end='true' WHERE id=sub;
 SET LOCAL ROLE service_role; PERFORM report_membership_check(actor); RESET ROLE;
 UPDATE user_subscriptions SET status='past_due' WHERE id=sub;
 SET LOCAL ROLE service_role; PERFORM pg_temp.expect_report_denied(actor,'REPORT_MEMBERSHIP_REQUIRED'); RESET ROLE;
 UPDATE user_subscriptions SET status='active',current_period_end=now()-interval '1 second' WHERE id=sub;
 SET LOCAL ROLE service_role; PERFORM pg_temp.expect_report_denied(actor,'REPORT_MEMBERSHIP_REQUIRED'); RESET ROLE;
 IF has_function_privilege('authenticated','report_membership_check(uuid)','EXECUTE')
  OR has_function_privilege('anon','report_source(uuid,uuid,uuid,uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'REPORT_PRIVATE_RPC_EXPOSED';END IF;
END $$;
ROLLBACK;
