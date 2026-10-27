-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Synthetic local-only workload. Keep every real constraint and trigger enabled.
BEGIN;
CREATE SCHEMA erasure_perf_test;
CREATE TABLE erasure_perf_test.target (fixture jsonb NOT NULL);
INSERT INTO erasure_perf_test.target SELECT runtime_perf_test.seed(26, true);
DO $$
DECLARE f jsonb; base jsonb; p uuid:=gen_random_uuid(); r uuid:=gen_random_uuid(); d opc_drafts; b record; c jsonb;
BEGIN
 SELECT fixture INTO f FROM erasure_perf_test.target;
 base:=d7_test.artifacts((f->>'actor')::uuid);
 SELECT * INTO d FROM opc_drafts WHERE actor_id=(f->>'actor')::uuid;
 INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,account,work_title,current_version)
 SELECT p,actor_id,module_id,skill_id,'perf-'||p,'Saved confirmed strategy',1 FROM artifact_projects WHERE id=d.project_id;
 INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,state,steps)
 SELECT r,p,revision_id,package_hash,workflow,workflow_hash,template_hash,'published',
  '{"s":{"valid":true,"body":"KEEP_CONFIRMED_STRATEGY","information":{}}}' FROM artifact_rounds WHERE id=d.round_id;
 INSERT INTO artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids)
 VALUES(gen_random_uuid(),p,r,1,'{"body":"KEEP_SAVED_REPORT"}',repeat('e',64),'[]');
 FOR b IN SELECT id,actor_id FROM bill2_runs WHERE session_ref=(f->>'session')::uuid LOOP
  c:=bill2_claim(b.actor_id,b.id,1,jsonb_build_object('provider','fixture','account','sandbox',
   'model','perf-'||(f->>'model'),'protocol','fixture-cost-v1','phase','reply','requestHash',repeat('b',64),
   'upperUsd','0.005','inputLimit',1000,'outputLimit',1000,'automaticRetry',false,'hiddenTools',false,'lookupSupported',true));
  PERFORM bill2_dispatch(b.actor_id,b.id,(c->>'id')::uuid,(c->>'dispatchToken')::uuid);
  PERFORM bill2_record(b.actor_id,b.id,(c->>'id')::uuid,jsonb_build_object('provider','fixture','account','sandbox',
   'model','perf-'||(f->>'model'),'protocol','fixture-cost-v1','providerId','fixture-'||(c->>'id'),
   'source','response','sourceHash',repeat('c',64),'observedAt','2026-10-26T00:00:00.000Z',
   'coverage','request_total','final',true,'cost','0.001','currency','USD','rawBody','ERASE_PRIVATE_RECEIPT',
   'usage',jsonb_build_object('inputTokens',10,'outputTokens',10)));
 END LOOP;
 PERFORM bill2_close(actor_id,id,'delivered',jsonb_build_object('kind','usable_result',
  'evidenceRef','local-performance-fixture','evidenceHash',repeat('a',64)))
  FROM bill2_runs WHERE session_ref=(f->>'session')::uuid;
 PERFORM bill2_finalize(actor_id,id) FROM bill2_runs WHERE session_ref=(f->>'session')::uuid;
 INSERT INTO opc_drafts(draft_id,actor_id,project_id,round_id,session_id,request_id,registration,mode)
 VALUES((f->>'draft')::uuid,d.actor_id,p,r,(f->>'session')::uuid,gen_random_uuid(),d.registration,'mentor');
END $$;
-- Most rows belong to other accounts; some belong to an independent conversation of the deleting account.
CREATE TABLE erasure_perf_test.actors AS
 SELECT n,CASE WHEN n=0 THEN (SELECT (fixture->>'actor')::uuid FROM erasure_perf_test.target)
  ELSE gen_random_uuid() END actor,gen_random_uuid() draft,gen_random_uuid() session FROM generate_series(0,29) n;
INSERT INTO profiles(id,credits) SELECT actor,100000 FROM erasure_perf_test.actors WHERE n>0;
INSERT INTO bill2_drafts(id,actor_id) SELECT draft,actor FROM erasure_perf_test.actors;
INSERT INTO runtime_sessions(id,actor_id,scope,start_request_id,start_payload)
 SELECT session,actor,jsonb_build_object('kind','positioning_draft','draftId',draft),gen_random_uuid(),'{}'
 FROM erasure_perf_test.actors;
CREATE TABLE erasure_perf_test.background AS
 SELECT a.*,i,gen_random_uuid() run,gen_random_uuid() execution,gen_random_uuid() call
 FROM erasure_perf_test.actors a CROSS JOIN LATERAL generate_series(1,CASE WHEN n=0 THEN 1000 ELSE 70 END) i;
INSERT INTO bill2_runs(id,actor_id,request_id,scope,session_ref,payload,reserved,budget_usd,credits_per_usd,
 multiplier,max_calls,deadline,state,closed,outcome,charged,actual_restore)
 SELECT run,actor,gen_random_uuid(),jsonb_build_object('kind','positioning_draft','draftId',draft),session,
 '{"contractVersion":"bill2.v1","input":{"text":"OTHER_CONVERSATION_PRIVATE"}}',1,0.01,100,1,2,
 now()+interval '1 hour','settled',true,'delivered',1,0 FROM erasure_perf_test.background;
INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,billing_run_id,history_revision,state,result)
 SELECT execution,actor,session,gen_random_uuid(),'{"input":"OTHER_CONVERSATION_PRIVATE"}',run,(i-1)*3,'completed',
 '{"body":"OTHER_REPLY"}' FROM erasure_perf_test.background;
INSERT INTO runtime_session_history(session_id,revision,execution_id,item)
 SELECT session,(i-1)*3+j,execution,jsonb_build_object('role','assistant','content','OTHER_HISTORY')
 FROM erasure_perf_test.background CROSS JOIN generate_series(1,3) j;
INSERT INTO bill2_calls(id,run_id,sequence,payload,provider,account_namespace,model,upper_usd,state)
 SELECT call,run,1,'{}','fixture','sandbox','fixture',0.01,'responded' FROM erasure_perf_test.background;
INSERT INTO bill2_calls(run_id,sequence,payload,provider,account_namespace,model,upper_usd,state)
 SELECT run,2,'{}','fixture','sandbox','fixture',0.01,'responded' FROM erasure_perf_test.background WHERE i<=70;
INSERT INTO bill2_receipts(call_id,payload,payload_hash)
 SELECT call,jsonb_build_object('fixture',j),md5(j::text) FROM erasure_perf_test.background CROSS JOIN generate_series(1,3) j;
INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after,
 description,metadata)
 SELECT actor,1,'addition','grant','opening_grant','system','performance:'||execution||':'||j,0,1,
 'OTHER_LEDGER_PRIVATE',jsonb_build_object('fixture','OTHER_LEDGER_PRIVATE')
 FROM erasure_perf_test.background CROSS JOIN generate_series(1,5) j;
INSERT INTO billing_history(user_id,operation_type,amount,reason,metadata)
 SELECT actor,'settle',1,'OTHER_BILLING_PRIVATE',jsonb_build_object('fixture',execution)
 FROM erasure_perf_test.background CROSS JOIN generate_series(1,3) j;
-- DATA-ERASURE 0404: the deleted session's 26 runs also hold the ledger volume of a long PAYG conversation. Staging batch 18
-- step A1 (8 s, 57014): 692 credit_transactions, 228 billing_history, 231 token_stats and 231 ai_usage_logs rows owned by
-- the session's own runs, about 27/9/9/9 per run. Every ledger row of a session run is cloned until the run holds that
-- many (token_stats and ai_usage_logs keep their one row per run: both tables constrain the scope of a row; clones carry the run identity in metadata, like the metered rows; they keep all real constraints and triggers).
DO $$
DECLARE f jsonb; a uuid; sid uuid; own text;
BEGIN
 SELECT fixture INTO f FROM erasure_perf_test.target;
 a:=(f->>'actor')::uuid; sid:=(f->>'session')::uuid;
 own:='x.user_id=$1 AND EXISTS(SELECT 1 FROM bill2_runs r WHERE r.session_ref=$2 AND (r.id::text IN (x.metadata->>''runId'',x.metadata#>>''{usage,runId}'')
  OR r.pre_deduct_id::text IN (x.id::text,x.metadata->>''preDeductId'')))';
 EXECUTE format($q$INSERT INTO credit_transactions SELECT (jsonb_populate_record(NULL::credit_transactions,to_jsonb(x)
   ||jsonb_build_object('id',gen_random_uuid(),'idempotency_key',x.idempotency_key||':clone'||k,'bill2_run_id',NULL))).* FROM credit_transactions x
   CROSS JOIN generate_series(1,12) k WHERE %s$q$,own) USING a,sid;
 -- Terminal billing_history rows are unique per pre-deduction: clones name their run through metadata.runId instead.
 INSERT INTO billing_history SELECT (jsonb_populate_record(NULL::billing_history,to_jsonb(x)||jsonb_build_object('id',gen_random_uuid(),
   'metadata',(x.metadata-'preDeductId')||jsonb_build_object('runId',r.id,'requestId',gen_random_uuid())))).*
   FROM billing_history x JOIN bill2_runs r ON r.session_ref=sid AND r.pre_deduct_id::text IN (x.id::text,x.metadata->>'preDeductId')
   CROSS JOIN generate_series(1,9) k WHERE x.user_id=a;
END $$;
ANALYZE;
COMMIT;
