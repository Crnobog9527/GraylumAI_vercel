-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Run after erasure-b1b-fixture.sql in the local replay database.
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
    OR EXISTS (SELECT 1 FROM b1b_conversation_before x JOIN conversations c ON c.id=x.id
      WHERE x.is_deleted IS DISTINCT FROM c.is_deleted OR x.deleted_at IS DISTINCT FROM c.deleted_at) THEN
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
