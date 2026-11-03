-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Real admission/pre-deduction in the disposable local database; no trigger bypass.
CREATE SCHEMA b2a_test;
CREATE FUNCTION b2a_test.fixture() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a uuid:=gen_random_uuid();m uuid:=gen_random_uuid();d uuid;
BEGIN
 INSERT INTO profiles(id,credits) VALUES(a,100);
 INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
 VALUES(a,100,'addition','grant','opening_grant','system','opening_grant:'||a,0,100);
 INSERT INTO ai_models(id,model_id,name,provider,is_active) VALUES(m,'b2a-fixture','Fixture','fixture','true');
 d:=bill2_create_draft(a);
 -- (V2-12 F: the old billing run and its payload are gone with bill2_prepare; the actor, a model and a draft are what the suites build on.)
 RETURN jsonb_build_object('actor',a,'draft',d,'model',m);
END $$;
