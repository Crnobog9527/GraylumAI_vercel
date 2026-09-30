-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- B1b fixtures are committed with replica enabled ONLY while seeding this disposable local DB.
-- Assertions use normal triggers in a separate transaction; no production bypass exists.
BEGIN;
SET LOCAL session_replication_role = replica;
CREATE TEMP TABLE b1b_ids(k text PRIMARY KEY, v uuid);
INSERT INTO b1b_ids SELECT k, gen_random_uuid() FROM unnest(ARRAY[
  'closed','open','c_session','busy_session','o_session','c_exec','c_exec2','busy_exec','unknown_exec','o_exec',
  'c_conv','skill_conv','busy_conv','artifact_busy_conv','o_conv','c_request','busy_request','done_busy_request',
  'o_request','project','round','generation','module','skill','revision']) k;
CREATE TEMP VIEW b1b_i AS
SELECT (SELECT v FROM b1b_ids WHERE k='closed') closed, (SELECT v FROM b1b_ids WHERE k='open') open;
INSERT INTO profiles(id,email,nickname,role,status,membership_level,credits,is_deleted)
SELECT v,k || '@example.test','b1b-' || k,'user',CASE k WHEN 'closed' THEN 'deleted' ELSE 'active' END,
  'free',10,CASE k WHEN 'closed' THEN 'true' ELSE 'false' END FROM b1b_ids WHERE k IN ('closed','open');
INSERT INTO account_erasure_requests(profile_id,request_id) SELECT closed,gen_random_uuid() FROM b1b_i;
INSERT INTO runtime_sessions(id,actor_id,scope,start_request_id,start_payload)
SELECT (SELECT v FROM b1b_ids WHERE k=s),(SELECT v FROM b1b_ids WHERE k=a),
  jsonb_build_object('privateScope',s),gen_random_uuid(),'{"privateStart":"secret"}'
FROM (VALUES ('c_session','closed'),('busy_session','closed'),('o_session','open')) x(s,a);
INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state,result,primary_result,match_result)
SELECT (SELECT v FROM b1b_ids WHERE k=e),(SELECT v FROM b1b_ids WHERE k=a),(SELECT v FROM b1b_ids WHERE k=s),
  gen_random_uuid(),'{"privateInput":"secret"}',0,st,'{"body":"answer"}','{"body":"primary"}','{"key":"candidate"}'
FROM (VALUES ('c_exec','closed','c_session','completed'),('c_exec2','closed','c_session','cancelled'),
  ('busy_exec','closed','busy_session','cost_pending'),('unknown_exec','closed','busy_session','completed'),
  ('o_exec','open','o_session','completed')) x(e,a,s,st);
INSERT INTO bill2_runs(id,actor_id,request_id,scope,payload,reserved,credits_per_usd,multiplier,budget_usd,max_calls,deadline,
  state,closed,session_ref,charged,provider_cost_usd)
SELECT e.id,e.actor_id,gen_random_uuid(),'{"fixture":true}','{"financialEvidence":"unchanged"}',10,1000,1,1,1,now(),
  CASE WHEN e.id IN ((SELECT v FROM b1b_ids WHERE k='busy_exec'),(SELECT v FROM b1b_ids WHERE k='unknown_exec'))
    THEN 'unknown' ELSE 'settled' END,true,e.session_id,3,0.003
FROM runtime_executions e WHERE e.id IN (SELECT v FROM b1b_ids);
UPDATE runtime_executions SET billing_run_id=id WHERE id IN (SELECT v FROM b1b_ids);
INSERT INTO runtime_history_dependencies(execution_id,dependency_id)
SELECT (SELECT v FROM b1b_ids WHERE k=e),(SELECT v FROM b1b_ids WHERE k=d)
FROM (VALUES ('c_exec','c_exec2'),('busy_exec','c_exec'),('c_exec','busy_exec')) x(e,d);
INSERT INTO runtime_session_batches(session_id,execution_id,batch,items,start_revision,end_revision)
SELECT session_id,id,0,'[{"role":"assistant","content":"private SDK batch"}]',0,1
FROM runtime_executions WHERE id IN (SELECT v FROM b1b_ids);
INSERT INTO runtime_session_history(session_id,revision,execution_id,item)
SELECT session_id,row_number() OVER (PARTITION BY session_id ORDER BY id),id,'{"content":"private SDK history"}'
FROM runtime_executions WHERE id IN (SELECT v FROM b1b_ids);
INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments,result)
SELECT id,'fixture-call','search','{"query":"private query"}','{"content":"private tool result"}'
FROM runtime_executions WHERE id IN (SELECT v FROM b1b_ids);
INSERT INTO runtime_scope_material(session_id,revision,request_id,request,content,content_hash)
SELECT id,1,gen_random_uuid(),'{"brief":"private request"}','{"brief":"private material"}','private-content-hash'
FROM runtime_sessions WHERE id IN (SELECT v FROM b1b_ids);
INSERT INTO conversations(id,user_id,title,summary,summary_metadata,skill_mode,is_deleted,deleted_at)
SELECT (SELECT v FROM b1b_ids WHERE k=c),(SELECT v FROM b1b_ids WHERE k=a),'b1b-' || c,'private summary',
  '{"private":"summary metadata"}',c='skill_conv',CASE WHEN c='c_conv' THEN 'true' ELSE 'false' END,
  CASE WHEN c='c_conv' THEN now() ELSE NULL END
FROM (VALUES ('c_conv','closed'),('skill_conv','closed'),('busy_conv','closed'),
  ('artifact_busy_conv','closed'),('o_conv','open')) x(c,a);
INSERT INTO messages(conversation_id,role,content)
SELECT id,'assistant','private message' FROM conversations WHERE id IN (SELECT v FROM b1b_ids);
INSERT INTO conversation_context_snapshots(conversation_id,snapshot_type,content,metadata)
SELECT id,'rolling_summary','private snapshot','{"private":"snapshot metadata"}'
FROM conversations WHERE id IN (SELECT v FROM b1b_ids);
INSERT INTO ordinary_chat_requests(request_id,user_id,conversation_id,writer_token,input,state,response_params,
  partial_content,failure_reason,reservation,billing_result)
SELECT (SELECT v FROM b1b_ids WHERE k=r),(SELECT v FROM b1b_ids WHERE k=a),(SELECT v FROM b1b_ids WHERE k=c),
  gen_random_uuid(),'{"message":"private request"}',st,'{"p_assistant_message":"private response"}',
  'private partial','private failure','{"balance_after":7,"private":"clear reservation extra"}',
  '{"balance_after":7,"refunded_credits":2,"private":"clear billing extra"}'
FROM (VALUES ('c_request','closed','c_conv','succeeded'),('busy_request','closed','busy_conv','unknown'),
  ('done_busy_request','closed','busy_conv','failed'),('o_request','open','o_conv','running')) x(r,a,c,st);
-- A second busy conversation exercises the other silent-delete guard.
INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,account,work_title)
SELECT (SELECT v FROM b1b_ids WHERE k='project'),closed,(SELECT v FROM b1b_ids WHERE k='module'),
  (SELECT v FROM b1b_ids WHERE k='skill'),'b1b-fixture','private project' FROM b1b_i;
INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,state,steps)
SELECT (SELECT v FROM b1b_ids WHERE k='round'),(SELECT v FROM b1b_ids WHERE k='project'),
  (SELECT v FROM b1b_ids WHERE k='revision'),'pkg','{}','wf','tpl','draft','{}';
INSERT INTO artifact_chats(conversation_id,project_id,round_id,step_id)
SELECT (SELECT v FROM b1b_ids WHERE k='artifact_busy_conv'),(SELECT v FROM b1b_ids WHERE k='project'),
  (SELECT v FROM b1b_ids WHERE k='round'),'s';
INSERT INTO artifact_generations(id,project_id,round_id,request_id,step_id,input,basis,evidence_ids,direct_ids,
  quote,pre_deduct_id,dispatch_token,state)
SELECT (SELECT v FROM b1b_ids WHERE k='generation'),(SELECT v FROM b1b_ids WHERE k='project'),
  (SELECT v FROM b1b_ids WHERE k='round'),gen_random_uuid(),'s','{}','{}','[]','[]','{}',
  gen_random_uuid(),gen_random_uuid(),'unknown';
CREATE TEMP TABLE b1b_bill_before AS SELECT id,to_jsonb(b) row FROM bill2_runs b WHERE id IN (SELECT v FROM b1b_ids);
CREATE TEMP TABLE b1b_conversation_before AS SELECT id,is_deleted,deleted_at FROM conversations WHERE id IN (SELECT v FROM b1b_ids);
COMMIT;
