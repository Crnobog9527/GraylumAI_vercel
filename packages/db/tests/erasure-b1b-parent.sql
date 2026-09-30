-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Disposable replay DB only. Fixture bypass ends before any tested operation.
BEGIN;
SET LOCAL session_replication_role = replica;
CREATE TEMP TABLE b1p_ids(k text PRIMARY KEY, v uuid);
INSERT INTO b1p_ids SELECT k,gen_random_uuid() FROM unnest(ARRAY[
  'closed','open','erased_conv','busy_conv','open_conv','request','token',
  'closed_success_pre','closed_abort_pre','open_abort_pre','move_message','move_snapshot']) k;
CREATE FUNCTION pg_temp.b1p_id(k text) RETURNS uuid LANGUAGE sql AS $$
  SELECT v FROM b1p_ids WHERE b1p_ids.k=$1
$$;
INSERT INTO profiles(id,email,nickname,role,status,membership_level,credits,is_deleted,deleted_at)
SELECT v,'parent-' || k || '@example.test','parent-' || k,'user',
  CASE k WHEN 'closed' THEN 'deleted' ELSE 'active' END,'free',10,
  CASE k WHEN 'closed' THEN 'true' ELSE 'false' END,
  CASE k WHEN 'closed' THEN now() ELSE NULL END
FROM b1p_ids WHERE k IN ('closed','open');
INSERT INTO account_erasure_requests(profile_id,request_id)
VALUES(pg_temp.b1p_id('closed'),gen_random_uuid());
INSERT INTO conversations(id,user_id,title)
SELECT pg_temp.b1p_id(c),pg_temp.b1p_id(a),'parent guard fixture'
FROM (VALUES ('erased_conv','closed'),('busy_conv','closed'),('open_conv','open')) x(c,a);
INSERT INTO ordinary_chat_requests(request_id,user_id,conversation_id,writer_token,input,state)
VALUES(pg_temp.b1p_id('request'),pg_temp.b1p_id('closed'),pg_temp.b1p_id('busy_conv'),
  pg_temp.b1p_id('token'),'{"message":"in-flight question"}','running');
-- A real legacy finalizer will attempt a nonzero balance restoration before inserting messages.
INSERT INTO billing_history(id,user_id,operation_type,amount,metadata)
SELECT pg_temp.b1p_id(k),pg_temp.b1p_id(a),'pre_deduct',-3,'{}'::jsonb
FROM (VALUES ('closed_success_pre','closed'),('closed_abort_pre','closed'),('open_abort_pre','open')) x(k,a);
INSERT INTO messages(id,conversation_id,role,content)
VALUES(pg_temp.b1p_id('move_message'),pg_temp.b1p_id('open_conv'),'user','move sentinel');
INSERT INTO conversation_context_snapshots(id,conversation_id,snapshot_type,content)
VALUES(pg_temp.b1p_id('move_snapshot'),pg_temp.b1p_id('open_conv'),'rolling_summary','move sentinel');
GRANT SELECT ON b1p_ids TO service_role;
COMMIT;

BEGIN;
CREATE FUNCTION pg_temp.b1p_refuses(stmt text, expected text, expected_state text DEFAULT '42501')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> expected_state OR SQLERRM <> expected THEN RAISE; END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'B1b parent expected refusal: %',expected;
END $$;
-- Compare complete rows, not just counts: credit changes before the denied INSERT must roll back.
CREATE FUNCTION pg_temp.b1p_snapshot() RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM profiles p WHERE id=pg_temp.b1p_id('closed')),
    'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM messages m
      WHERE conversation_id IN (pg_temp.b1p_id('erased_conv'),pg_temp.b1p_id('busy_conv'))),
    'billing',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM billing_history b WHERE user_id=pg_temp.b1p_id('closed')),
    'credits',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM credit_transactions c WHERE user_id=pg_temp.b1p_id('closed')),
    'tokens',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM token_stats t WHERE user_id=pg_temp.b1p_id('closed')),
    'usage',(SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM ai_usage_logs u WHERE user_id=pg_temp.b1p_id('closed')),
    'requests',(SELECT jsonb_agg(to_jsonb(r) ORDER BY request_id) FROM ordinary_chat_requests r
      WHERE user_id=pg_temp.b1p_id('closed')))
$$;
SET LOCAL ROLE service_role;
SELECT account_erasure_scrub_runtime(pg_temp.b1p_id('closed'));
RESET ROLE;
DO $$ BEGIN
  IF (SELECT erased_at IS NULL FROM conversations WHERE id=pg_temp.b1p_id('erased_conv'))
    OR (SELECT erased_at IS NOT NULL FROM conversations WHERE id=pg_temp.b1p_id('busy_conv'))
    OR (SELECT writer_token IS DISTINCT FROM pg_temp.b1p_id('token') FROM ordinary_chat_requests
      WHERE request_id=pg_temp.b1p_id('request')) THEN
    RAISE EXCEPTION 'B1b parent first scrub failed erased/in-flight boundary';
  END IF;
END $$;
CREATE TEMP TABLE b1p_before AS SELECT pg_temp.b1p_snapshot() contents;
SET LOCAL ROLE service_role;
DO $$ BEGIN
  IF current_user <> 'service_role' THEN RAISE EXCEPTION 'B1b parent role test is owner'; END IF;
END $$;
SELECT pg_temp.b1p_refuses(format(
  'SELECT * FROM atomic_finalize_ai_success(%L,%L,''question'',''late answer'',''fixture'',0,1,%L)',
  pg_temp.b1p_id('closed'),pg_temp.b1p_id('erased_conv'),pg_temp.b1p_id('closed_success_pre')),
  'ERASURE_PARENT_CLEARED');
RESET ROLE;
DO $$ BEGIN
  IF pg_temp.b1p_snapshot() IS DISTINCT FROM (SELECT contents FROM b1p_before) THEN
    RAISE EXCEPTION 'B1b parent denied success changed financial/content rows';
  END IF;
END $$;
SET LOCAL ROLE service_role;
SELECT pg_temp.b1p_refuses(format(
  'SELECT * FROM atomic_finalize_ai_abort(%L,%L,''question'',''late partial'',''fixture'',0,1,%L)',
  pg_temp.b1p_id('closed'),pg_temp.b1p_id('erased_conv'),pg_temp.b1p_id('closed_abort_pre')),
  'ERASURE_PARENT_CLEARED');
RESET ROLE;
DO $$ BEGIN
  IF pg_temp.b1p_snapshot() IS DISTINCT FROM (SELECT contents FROM b1p_before) THEN
    RAISE EXCEPTION 'B1b parent denied abort changed financial/content rows';
  END IF;
END $$;
SELECT 'PASS B1b parent P1 real service-role success/abort denied and complete financial/content rollback';

-- Snapshot ACL denial is not evidence that its trigger is effective. Test both separately.
SET LOCAL ROLE service_role;
SELECT pg_temp.b1p_refuses(format(
  'INSERT INTO conversation_context_snapshots(conversation_id,snapshot_type,content) VALUES(%L,''search_digest'',''late snapshot'')',
  pg_temp.b1p_id('erased_conv')),'permission denied for table conversation_context_snapshots');
RESET ROLE;
SELECT pg_temp.b1p_refuses(format(
  'INSERT INTO conversation_context_snapshots(conversation_id,snapshot_type,content) VALUES(%L,''search_digest'',''late snapshot'')',
  pg_temp.b1p_id('erased_conv')),'ERASURE_PARENT_CLEARED');
SELECT pg_temp.b1p_refuses(format(
  'INSERT INTO messages(conversation_id,role,content) VALUES(%L,''user'',''late message'')',
  pg_temp.b1p_id('erased_conv')),'ERASURE_PARENT_CLEARED');
SELECT pg_temp.b1p_refuses(format(
  'UPDATE messages SET conversation_id=%L WHERE id=%L',
  pg_temp.b1p_id('erased_conv'),pg_temp.b1p_id('move_message')),'ERASURE_PARENT_CLEARED');
SELECT pg_temp.b1p_refuses(format(
  'UPDATE conversation_context_snapshots SET conversation_id=%L WHERE id=%L',
  pg_temp.b1p_id('erased_conv'),pg_temp.b1p_id('move_snapshot')),'ERASURE_PARENT_CLEARED');
SELECT pg_temp.b1p_refuses(format(
  'INSERT INTO messages(conversation_id,role,content,erased_at) VALUES(%L,''user'',NULL,now())',
  pg_temp.b1p_id('open_conv')),'ERASURE_INSERT_DENIED');
SELECT pg_temp.b1p_refuses(format(
  'INSERT INTO conversation_context_snapshots(conversation_id,snapshot_type,content,erased_at)
    VALUES(%L,''search_digest'',NULL,now())',pg_temp.b1p_id('open_conv')),'ERASURE_INSERT_DENIED');
DO $$ BEGIN
  BEGIN
    INSERT INTO messages(conversation_id,role,content) VALUES(gen_random_uuid(),'user','missing parent');
    RAISE EXCEPTION 'B1b parent missing conversation bypassed foreign key';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO conversation_context_snapshots(conversation_id,snapshot_type,content)
      VALUES(gen_random_uuid(),'search_digest','missing parent');
    RAISE EXCEPTION 'B1b parent missing snapshot conversation bypassed foreign key';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;
UPDATE messages SET content='ordinary update' WHERE id=pg_temp.b1p_id('move_message');
UPDATE conversation_context_snapshots SET content='ordinary update' WHERE id=pg_temp.b1p_id('move_snapshot');
SELECT 'PASS B1b parent P2 snapshot ACL and trigger separately denied; new/moved children denied; live update/FK preserved';

-- Existing financial RPCs retain their allowed path; no wrapper or ACL is replaced by the test.
SET LOCAL ROLE service_role;
SELECT * FROM atomic_finalize_ai_success(pg_temp.b1p_id('open'),pg_temp.b1p_id('open_conv'),
  'normal question','normal answer','fixture',0,0);
SELECT * FROM atomic_finalize_ai_abort(pg_temp.b1p_id('open'),pg_temp.b1p_id('open_conv'),
  'normal question','normal partial','fixture',0,1,pg_temp.b1p_id('open_abort_pre'));
RESET ROLE;
DO $$ BEGIN
  IF (SELECT count(*) FROM messages WHERE conversation_id=pg_temp.b1p_id('open_conv'))<>5
    OR (SELECT credits FROM profiles WHERE id=pg_temp.b1p_id('open'))<>12
    OR NOT EXISTS(SELECT 1 FROM billing_history WHERE user_id=pg_temp.b1p_id('open')
      AND operation_type='abort_settle' AND metadata->>'preDeductId'=pg_temp.b1p_id('open_abort_pre')::text) THEN
    RAISE EXCEPTION 'B1b parent normal finalizers no longer complete';
  END IF;
END $$;
SELECT 'PASS B1b parent P3 real service-role success/abort still finish for live conversation';

-- The closed actor's already-dispatched request was skipped, so its existing token may finish.
-- This is an existing zero-cost request; service_role never calls the revoked claim entrance.
SET LOCAL ROLE service_role;
SELECT ordinary_chat_transition(pg_temp.b1p_id('closed'),pg_temp.b1p_id('request'),pg_temp.b1p_id('token'),
  'respond',jsonb_build_object('p_user_id',pg_temp.b1p_id('closed'),
    'p_conversation_id',pg_temp.b1p_id('busy_conv'),'p_request_id',pg_temp.b1p_id('request'),
    'p_user_message','in-flight question','p_assistant_message','finished after closure',
    'p_model_used','fixture','p_total_cost_usd',0,'p_total_credits',0));
SELECT ordinary_chat_transition(pg_temp.b1p_id('closed'),pg_temp.b1p_id('request'),pg_temp.b1p_id('token'),'success');
RESET ROLE;
DO $$ BEGIN
  IF (SELECT state FROM ordinary_chat_requests WHERE request_id=pg_temp.b1p_id('request'))<>'succeeded'
    OR (SELECT count(*) FROM messages WHERE conversation_id=pg_temp.b1p_id('busy_conv') AND erased_at IS NULL)<>2 THEN
    RAISE EXCEPTION 'B1b parent skipped existing request could not finish';
  END IF;
END $$;
SET LOCAL ROLE service_role;
SELECT account_erasure_scrub_runtime(pg_temp.b1p_id('closed'));
RESET ROLE;
DO $$ BEGIN
  IF (SELECT erased_at IS NULL FROM conversations WHERE id=pg_temp.b1p_id('busy_conv'))
    OR EXISTS(SELECT 1 FROM messages WHERE conversation_id=pg_temp.b1p_id('busy_conv')
      AND (erased_at IS NULL OR content IS NOT NULL))
    OR EXISTS(SELECT 1 FROM ordinary_chat_requests WHERE request_id=pg_temp.b1p_id('request')
      AND (erased_at IS NULL OR writer_token IS NOT NULL OR input IS NOT NULL OR response_params IS NOT NULL)) THEN
    RAISE EXCEPTION 'B1b parent terminal retry left content or dispatch token';
  END IF;
END $$;
SELECT 'PASS B1b parent P4 closed in-flight request completes before scrub; terminal retry clears children and token';
ROLLBACK;
