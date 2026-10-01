-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Real admission/pre-deduction through bill2_prepare in the disposable local database; no trigger bypass.
CREATE SCHEMA bill_unit_test;
-- One actor, models with the given multipliers, and a prepared run. rules.billingUnit is present only
-- for the new contract; the old contract keeps one run-level multiplier.
CREATE FUNCTION bill_unit_test.fixture(weighted boolean, q text, run_m text, model_m text[], upper text, max_calls integer)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a uuid:=gen_random_uuid();d uuid;r jsonb;p jsonb;models jsonb:='[]';policy jsonb:='[]';m uuid;i integer;
 cost numeric;credits integer;rules jsonb;
BEGIN
 INSERT INTO profiles(id,credits) VALUES(a,1000);
 INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
 VALUES(a,1000,'addition','grant','opening_grant','system','opening_grant:'||a,0,1000);
 FOR i IN 1..array_length(model_m,1) LOOP
  m:=gen_random_uuid();
  INSERT INTO ai_models(id,model_id,name,provider,is_active) VALUES(m,'bill-unit-'||i||'-'||left(a::text,8),'Fixture '||i,'fixture','true');
  models:=models||jsonb_build_array(jsonb_build_object('id',m,'model','bill-unit-'||i||'-'||left(a::text,8),'multiplier',model_m[i]));
  policy:=policy||jsonb_build_array(jsonb_build_object('modelId',m,'provider','fixture','account','sandbox',
   'model','bill-unit-'||i||'-'||left(a::text,8),'protocol','fixture-cost-v1','upperUsd',upper,'inputLimit',1000,'outputLimit',1000,
   'automaticRetry',false,'hiddenTools',false,'lookupSupported',true)
   ||CASE WHEN weighted THEN jsonb_build_object('multiplier',model_m[i]) ELSE '{}'::jsonb END);
 END LOOP;
 d:=bill2_create_draft(a);
 cost:=upper::numeric*max_calls;
 credits:=ceil(cost*q::numeric*run_m::numeric);
 rules:=jsonb_build_object('version','v1','quoteVersion','fixture-v1','creditsPerUsd',q,'multiplier',run_m,'fx','{}'::jsonb)
  ||CASE WHEN weighted THEN jsonb_build_object('billingUnit',jsonb_build_object('version','bill-unit-v2','creditsPerUsd',q,
   'defaultMultiplier','3','hash',repeat('f',64))) ELSE '{}'::jsonb END;
 p:=jsonb_build_object('contractVersion','bill2.v1','mode','isolated','scope',jsonb_build_object('kind','positioning_draft','draftId',d),
  'operation','question','modelId',models->0->>'id','sourceHash',repeat('a',64),'input',jsonb_build_object('text','fixture'),
  'callPolicy',policy,'rules',rules,
  'limits',jsonb_build_object('costUsd',cost::text,'credits',credits,'maxPreDeduct',credits,'maxCalls',max_calls,
   'deadline',clock_timestamp()+interval '1 hour'));
 r:=bill2_prepare(a,gen_random_uuid(),p);
 RETURN jsonb_build_object('actor',a,'run',r->>'id','models',models,'reserved',credits);
END $$;
