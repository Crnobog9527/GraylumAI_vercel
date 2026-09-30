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

-- New transaction with all guards and foreign keys enabled for assertions.
BEGIN;
CREATE FUNCTION pg_temp.b1b_refuses(stmt text, message text, state text DEFAULT '42501') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> state OR SQLERRM <> message THEN RAISE; END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'B1b expected refusal: %', message;
END $$;
SELECT pg_temp.b1b_refuses(format('SELECT account_erasure_scrub_runtime(%L)',(SELECT open FROM b1b_i)),
  'ACCOUNT_ERASURE_NOT_CLOSED');
SELECT 'PASS B1b C1 open account scrub refused';
CREATE TEMP TABLE b1b_first_scrub ON COMMIT DROP AS SELECT account_erasure_scrub_runtime((SELECT closed FROM b1b_i)) r;
DO $$
DECLARE r jsonb := (SELECT r FROM b1b_first_scrub); c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('runtime_sessions',1,1),('runtime_executions',2,2),('runtime_history_dependencies',1,2),
    ('runtime_session_batches',2,2),('runtime_session_history',2,2),('runtime_tool_calls',2,2),
    ('runtime_scope_material',1,1),('conversations',2,2),('messages',2,2),
    ('conversation_context_snapshots',2,2),('ordinary_chat_requests',2,1)) v(k,done,skipped) LOOP
    IF (r->>c.k)::int IS DISTINCT FROM c.done OR (r->>(c.k || '_skipped'))::int IS DISTINCT FROM c.skipped THEN
      RAISE EXCEPTION 'B1b C2 wrong counter for %: %',c.k,r;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM runtime_scope_material WHERE erased_at IS NOT NULL AND content_hash IS NOT NULL)
    OR EXISTS (SELECT 1 FROM runtime_sessions WHERE erased_at IS NOT NULL AND (scope IS NOT NULL OR start_payload IS NOT NULL))
    OR EXISTS (SELECT 1 FROM runtime_executions WHERE erased_at IS NOT NULL
      AND (payload IS NOT NULL OR result IS NOT NULL OR primary_result IS NOT NULL OR match_result IS NOT NULL))
    OR EXISTS (SELECT 1 FROM runtime_session_batches WHERE erased_at IS NOT NULL AND items IS NOT NULL)
    OR EXISTS (SELECT 1 FROM runtime_session_history WHERE erased_at IS NOT NULL AND item IS NOT NULL)
    OR EXISTS (SELECT 1 FROM runtime_tool_calls WHERE erased_at IS NOT NULL AND (arguments IS NOT NULL OR result IS NOT NULL))
    OR EXISTS (SELECT 1 FROM messages WHERE erased_at IS NOT NULL AND content IS NOT NULL)
    OR EXISTS (SELECT 1 FROM conversation_context_snapshots WHERE erased_at IS NOT NULL AND (content IS NOT NULL OR metadata IS NOT NULL))
    OR EXISTS (SELECT 1 FROM conversations WHERE erased_at IS NOT NULL
      AND (title IS NOT NULL OR summary IS NOT NULL OR summary_metadata IS NOT NULL))
    OR EXISTS (SELECT 1 FROM ordinary_chat_requests WHERE erased_at IS NOT NULL AND (input IS NOT NULL
      OR response_params IS NOT NULL OR partial_content IS NOT NULL OR failure_reason IS NOT NULL
      OR reservation IS DISTINCT FROM '{"balance_after":7}'::jsonb
      OR billing_result IS DISTINCT FROM '{"balance_after":7,"refunded_credits":2}'::jsonb)) THEN
    RAISE EXCEPTION 'B1b C2 private content survived';
  END IF;
  IF EXISTS (SELECT 1 FROM b1b_bill_before x JOIN bill2_runs b ON b.id=x.id WHERE x.row IS DISTINCT FROM to_jsonb(b))
    OR EXISTS (SELECT 1 FROM b1b_conversation_before x JOIN conversations conv ON conv.id=x.id
      WHERE x.is_deleted IS DISTINCT FROM conv.is_deleted OR x.deleted_at IS DISTINCT FROM conv.deleted_at) THEN
    RAISE EXCEPTION 'B1b C2 financial row/session_ref/soft-delete facts changed';
  END IF;
  IF EXISTS (SELECT 1 FROM runtime_executions WHERE actor_id=(SELECT open FROM b1b_i) AND erased_at IS NOT NULL)
    OR EXISTS (SELECT 1 FROM conversations WHERE user_id=(SELECT open FROM b1b_i) AND erased_at IS NOT NULL) THEN
    RAISE EXCEPTION 'B1b C2 other actor changed';
  END IF;
END $$;
SELECT 'PASS B1b C2 all 11 tables: content/hash cleared, in-flight counts, other owner/money/soft-delete unchanged';
DO $$
DECLARE r jsonb; k text;
BEGIN
  r := account_erasure_scrub_runtime((SELECT closed FROM b1b_i));
  FOR k IN SELECT jsonb_object_keys(r) LOOP
    IF k NOT LIKE '%_skipped' AND (r->>k)::int <> 0 THEN RAISE EXCEPTION 'B1b C3 repeated scrub changed %',k; END IF;
  END LOOP;
END $$;
SELECT 'PASS B1b C3 repeated scrub is idempotent';
-- Exact trigger messages keep FK/constraint errors from masquerading as a successful refusal.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['runtime_sessions','runtime_executions','runtime_history_dependencies','runtime_session_batches',
    'runtime_session_history','runtime_tool_calls','runtime_scope_material','conversations','messages',
    'conversation_context_snapshots','ordinary_chat_requests'] LOOP
    PERFORM pg_temp.b1b_refuses(format('UPDATE %I SET erased_at = NULL WHERE erased_at IS NOT NULL',t),'erased row is immutable');
  END LOOP;
END $$;
SELECT pg_temp.b1b_refuses('UPDATE runtime_executions SET result = ''{"body":"late complete"}'' WHERE erased_at IS NOT NULL',
  'erased row is immutable');
SELECT pg_temp.b1b_refuses('UPDATE runtime_executions SET primary_result = ''{"body":"late checkpoint"}'' WHERE erased_at IS NOT NULL',
  'erased row is immutable');
SELECT pg_temp.b1b_refuses('UPDATE runtime_tool_calls SET result = ''{"body":"late tool complete"}'' WHERE erased_at IS NOT NULL',
  'erased row is immutable');
SELECT 'PASS B1b C4 erased rows and NULL complete/checkpoint/tool results cannot be rewritten';
SELECT pg_temp.b1b_refuses(format('UPDATE runtime_scope_material SET content_hash = ''replacement'', erased_at = now() WHERE session_id = %L',
  (SELECT v FROM b1b_ids WHERE k='o_session')),'erasure outside allow-list');
SELECT pg_temp.b1b_refuses(format('UPDATE runtime_executions SET payload=NULL,result=NULL,primary_result=NULL,match_result=NULL,
  erased_at=now(),state=''cancelled'' WHERE id=%L',(SELECT v FROM b1b_ids WHERE k='o_exec')),'erasure outside allow-list');
SELECT pg_temp.b1b_refuses(format('UPDATE conversations SET title=NULL,summary=NULL,summary_metadata=NULL,erased_at=now() WHERE id=%L',
  (SELECT v FROM b1b_ids WHERE k='o_conv')),'ACCOUNT_ERASURE_NOT_CLOSED');
SELECT 'PASS B1b C5 replacement/non-whitelist/open-account direct marker rejected';
-- Rewritten CHECK and former NOT NULL remain effective before erasure.
DO $$ BEGIN
  BEGIN UPDATE runtime_scope_material SET content=NULL WHERE session_id=(SELECT v FROM b1b_ids WHERE k='o_session');
    RAISE EXCEPTION 'B1b C6 live required content accepted NULL'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE runtime_session_batches SET items='{}' WHERE session_id=(SELECT v FROM b1b_ids WHERE k='o_session');
    RAISE EXCEPTION 'B1b C6 live array CHECK lost'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
SELECT 'PASS B1b C6 original live-row CHECK and required content retained';
-- Deletion remains PR-C. Neither of the existing DELETE guards can report success by swallowing.
DO $$
DECLARE n bigint;
BEGIN
  DELETE FROM conversations WHERE id=(SELECT v FROM b1b_ids WHERE k='busy_conv');
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>0 OR NOT EXISTS(SELECT 1 FROM conversations WHERE id=(SELECT v FROM b1b_ids WHERE k='busy_conv')) THEN
    RAISE EXCEPTION 'B1b ordinary busy conversation was deleted'; END IF;
  DELETE FROM conversations WHERE id=(SELECT v FROM b1b_ids WHERE k='artifact_busy_conv');
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>0 OR NOT EXISTS(SELECT 1 FROM conversations WHERE id=(SELECT v FROM b1b_ids WHERE k='artifact_busy_conv')) THEN
    RAISE EXCEPTION 'B1b artifact busy conversation was deleted'; END IF;
END $$;
SELECT 'PASS B1b C7 both silent DELETE refusals checked by row existence, zero rows is not success';
-- Simulate B2 settling the skipped fixtures; this is fixture-only, not a new money path.
UPDATE bill2_runs SET state='settled' WHERE id IN ((SELECT v FROM b1b_ids WHERE k='busy_exec'),
  (SELECT v FROM b1b_ids WHERE k='unknown_exec'));
UPDATE runtime_executions SET state='cancelled' WHERE id=(SELECT v FROM b1b_ids WHERE k='busy_exec');
UPDATE ordinary_chat_requests SET state='failed' WHERE request_id=(SELECT v FROM b1b_ids WHERE k='busy_request');
UPDATE artifact_generations SET state='refunded' WHERE id=(SELECT v FROM b1b_ids WHERE k='generation');
DO $$
DECLARE r jsonb:=account_erasure_scrub_runtime((SELECT closed FROM b1b_i)); c record; k text;
BEGIN
  FOR c IN SELECT * FROM (VALUES ('runtime_sessions',1),('runtime_executions',2),('runtime_history_dependencies',2),
    ('runtime_session_batches',2),('runtime_session_history',2),('runtime_tool_calls',2),('runtime_scope_material',1),
    ('conversations',2),('messages',2),('conversation_context_snapshots',2),('ordinary_chat_requests',1)) v(k,n) LOOP
    IF (r->>c.k)::int IS DISTINCT FROM c.n THEN RAISE EXCEPTION 'B1b C10 retry count for %: %',c.k,r; END IF;
  END LOOP;
  FOR k IN SELECT jsonb_object_keys(r) LOOP
    IF k LIKE '%_skipped' AND (r->>k)::int<>0 THEN RAISE EXCEPTION 'B1b C10 still skipped %',k; END IF;
  END LOOP;
END $$;
SELECT 'PASS B1b C10 retry scrubs formerly in-flight fixtures after terminal settlement';
ROLLBACK;
