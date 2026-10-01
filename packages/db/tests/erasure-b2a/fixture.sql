-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Real admission/pre-deduction in the disposable local database; no trigger bypass.
CREATE SCHEMA b2a_test;
CREATE FUNCTION b2a_test.fixture() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a uuid:=gen_random_uuid();m uuid:=gen_random_uuid();d uuid;r jsonb;p jsonb;
BEGIN
 INSERT INTO profiles(id,credits) VALUES(a,100);
 INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
 VALUES(a,100,'addition','grant','opening_grant','system','opening_grant:'||a,0,100);
 INSERT INTO ai_models(id,model_id,name,provider,is_active) VALUES(m,'b2a-fixture','Fixture','fixture','true');
 d:=bill2_create_draft(a);
 p:=jsonb_build_object('contractVersion','bill2.v1','mode','isolated','scope',jsonb_build_object('kind','positioning_draft','draftId',d),
  'operation','question','modelId',m,'sourceHash',repeat('a',64),'input',jsonb_build_object('text','B2A_PRIVATE_CANARY'),
  'callPolicy',jsonb_build_array(jsonb_build_object('modelId',m,'provider','fixture','account','sandbox','model','b2a-fixture',
   'protocol','fixture-cost-v1','upperUsd','0.02','inputLimit',1000,'outputLimit',1000,'automaticRetry',false,'hiddenTools',false,'lookupSupported',true)),
  'rules','{"version":"v1","quoteVersion":"fixture-v1","creditsPerUsd":"1000","multiplier":"1.5","fx":{}}'::jsonb,
  'limits',jsonb_build_object('costUsd','0.02','credits',30,'maxPreDeduct',30,'maxCalls',4,'deadline',clock_timestamp()+interval '1 hour'));
 r:=bill2_prepare(a,gen_random_uuid(),p);
 RETURN jsonb_build_object('actor',a,'run',r->>'id','pre',r->>'preDeductId','draft',d,'payload',p);
END $$;
CREATE FUNCTION b2a_test.bind(f jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE sid uuid:=gen_random_uuid();eid uuid:=gen_random_uuid();
BEGIN
 INSERT INTO runtime_sessions(id,actor_id,scope,start_request_id,start_payload)
 VALUES(sid,(f->>'actor')::uuid,f->'payload'->'scope',gen_random_uuid(),'{}');
 INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state,billing_run_id)
 VALUES(eid,(f->>'actor')::uuid,sid,gen_random_uuid(),'{}',0,'interrupted',(f->>'run')::uuid);
 UPDATE bill2_runs SET session_ref=sid WHERE id=(f->>'run')::uuid;
 UPDATE runtime_sessions SET active_execution=eid WHERE id=sid;
 RETURN eid;
END $$;
