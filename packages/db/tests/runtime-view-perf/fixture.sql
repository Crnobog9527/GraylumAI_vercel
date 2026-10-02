-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Synthetic local-only data, no triggers disabled and no model/provider requests.
CREATE SCHEMA runtime_perf_test;
CREATE FUNCTION runtime_perf_test.seed(n integer, with_material boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a uuid:=gen_random_uuid();m uuid:=gen_random_uuid();d uuid;s uuid:=gen_random_uuid();e uuid;r uuid;
 p jsonb;b jsonb;scope jsonb;material jsonb;material_hash text;ids uuid[]:=ARRAY[]::uuid[];i integer;
BEGIN
 INSERT INTO profiles(id,credits) VALUES(a,100000);
 INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
 VALUES(a,100000,'addition','grant','opening_grant','system','opening_grant:'||a,0,100000);
 INSERT INTO ai_models(id,model_id,name,provider,is_active) VALUES(m,'perf-'||m,'Performance fixture','fixture','true');
 d:=bill2_create_draft(a);scope:=jsonb_build_object('kind','positioning_draft','draftId',d);
 INSERT INTO runtime_sessions(id,actor_id,scope,start_request_id,start_payload) VALUES(s,a,scope,gen_random_uuid(),'{}');
 p:=jsonb_build_object('version','runtime.v1','input','Synthetic input','request',jsonb_build_object('input','Synthetic input'),
  'historyItems',1000,'sources','[]'::jsonb);
 IF with_material THEN
  material:=jsonb_build_object('brief','Fixture','material','Private synthetic material','roundId',NULL,'work',NULL);
  material_hash:=encode(sha256(convert_to(material::text,'UTF8')),'hex');
  INSERT INTO runtime_scope_material(session_id,revision,request_id,request,content,content_hash)
   VALUES(s,1,gen_random_uuid(),'{}',material,material_hash);
  p:=p||jsonb_build_object('scopeMaterial',jsonb_build_object('sessionId',s,'revision',1,'hash',material_hash,'content',material));
 END IF;
 b:=jsonb_build_object('contractVersion','bill2.v1','mode','isolated','scope',scope,'operation','question','modelId',m,
  'sourceHash',repeat('a',64),'input',p,'callPolicy',jsonb_build_array(jsonb_build_object('modelId',m,
  'provider','fixture','account','sandbox','model','perf-'||m,'protocol','fixture-cost-v1','upperUsd','0.01',
  'inputLimit',10000,'outputLimit',1000,'automaticRetry',false,'hiddenTools',false,'lookupSupported',true)),
  'rules',jsonb_build_object('version','v1','quoteVersion','fixture','creditsPerUsd','100','multiplier','1','fx','{}'::jsonb),
  'limits',jsonb_build_object('costUsd','0.01','credits',1,'maxPreDeduct',1,'maxCalls',1,'deadline',clock_timestamp()+interval '2 hours'));
 FOR i IN 1..n LOOP
  r:=(bill2_prepare(a,gen_random_uuid(),b)->>'id')::uuid;e:=gen_random_uuid();
  INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,billing_run_id,history_revision,state,result,created_at,
    candidate_history,selected_history)
   VALUES(e,a,s,gen_random_uuid(),p,r,(i-1)*5,'completed',jsonb_build_object('body',repeat('中文 fixture ',300),'summary','Summary'),
    '2026-01-01'::timestamptz+i*interval '1 second',ARRAY(SELECT generate_series(greatest(1,(i-1)*5-999),(i-1)*5)),
    ARRAY(SELECT generate_series(greatest(1,(i-1)*5-999),(i-1)*5)));
  UPDATE bill2_runs SET session_ref=s WHERE id=r;
  INSERT INTO runtime_session_history SELECT s,(i-1)*5+j,e,jsonb_build_object('role','assistant','content','Synthetic history '||j),false
   FROM generate_series(1,5) j;
  INSERT INTO runtime_history_dependencies SELECT e,x FROM unnest(ids[greatest(1,i-200):i-1]) x;
  ids:=array_append(ids,e);
 END LOOP;
 UPDATE runtime_sessions SET revision=n*5 WHERE id=s;
 RETURN jsonb_build_object('actor',a,'session',s,'execution',e,'run',r,'model',m,'draft',d,'payload',p,'billing',b);
END $$;
