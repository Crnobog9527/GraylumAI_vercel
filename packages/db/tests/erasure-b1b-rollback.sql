-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- B1b rollback: refuse before any change if a B1b row has already lost content.
-- Restores the pre-0150 content scrub definition as well as the eleven B1b tables.
-- Restores the controller-provided staging originals verbatim (PR #537).
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
DECLARE t text; n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['runtime_sessions','runtime_executions','runtime_history_dependencies',
    'runtime_session_batches','runtime_session_history','runtime_tool_calls','runtime_scope_material',
    'conversations','messages','conversation_context_snapshots','ordinary_chat_requests'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE erased_at IS NOT NULL',t) INTO n;
    IF n>0 THEN RAISE EXCEPTION 'ERASURE_ROLLBACK_REFUSED: % has erased rows',t; END IF;
  END LOOP;
END $$;
DROP FUNCTION public.account_erasure_scrub_runtime(uuid);
DROP TRIGGER b_erasure_parent_guard ON public.messages;
DROP TRIGGER b_erasure_parent_guard ON public.conversation_context_snapshots;
DROP FUNCTION public.erasure_conversation_child_guard();
DROP TRIGGER erasure_closed_account_guard ON public.conversations;
DROP FUNCTION public.erasure_closed_conversation_guard();
DO $$
DECLARE t text; c record;
BEGIN
  FOREACH t IN ARRAY ARRAY['runtime_sessions','runtime_executions','runtime_history_dependencies',
    'runtime_session_batches','runtime_session_history','runtime_tool_calls','runtime_scope_material',
    'conversations','messages','conversation_context_snapshots','ordinary_chat_requests'] LOOP
    EXECUTE format('DROP TRIGGER a_erased_row_guard ON public.%I',t);
    FOR c IN SELECT con.conname,pg_get_constraintdef(con.oid) AS def FROM pg_constraint con
      WHERE con.conrelid=format('public.%I',t)::regclass AND con.contype='c'
      AND (con.conname LIKE 'erasure\_present\_%' OR con.conname LIKE 'erasure\_cleared\_%'
        OR pg_get_constraintdef(con.oid) LIKE 'CHECK (((erased_at IS NOT NULL) OR %') LOOP
      IF c.conname LIKE 'erasure\_present\_%' THEN
        EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I SET NOT NULL',t,
          substring(c.def FROM 'OR \(([a-z_]+) IS NOT NULL\)'));
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',t,c.conname);
      ELSIF c.conname LIKE 'erasure\_cleared\_%' THEN
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',t,c.conname);
      ELSE
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',t,c.conname);
        EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK %s',t,c.conname,
          substring(c.def FROM '^CHECK \(\(\(erased_at IS NOT NULL\) OR (.*)\)\)$'));
      END IF;
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I DROP COLUMN erased_at',t);
  END LOOP;
END $$;
-- Exact staging originals, including bodies, settings and retained ACLs.
CREATE OR REPLACE FUNCTION public.erasure_update_allowed(o jsonb, n jsonb, specs text[])
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  spec text; col text; rule text; cols text[] := '{}'; oldv jsonb; newv jsonb; kept jsonb;
BEGIN
  IF specs IS NULL OR cardinality(specs) = 0
    OR nullif(o -> 'erased_at', 'null'::jsonb) IS NOT NULL
    OR nullif(n -> 'erased_at', 'null'::jsonb) IS NULL THEN
    RETURN false;
  END IF;
  FOREACH spec IN ARRAY specs LOOP
    col := split_part(spec, '=', 1);
    rule := nullif(substr(spec, length(col) + 2), '');
    cols := cols || col;
    oldv := nullif(o -> col, 'null'::jsonb);
    newv := nullif(n -> col, 'null'::jsonb);
    IF rule IS NULL THEN
      IF newv IS NOT NULL THEN RETURN false; END IF;
    ELSIF rule LIKE 'erased:%' THEN
      IF NOT ((oldv IS NULL AND newv IS NULL)
        OR newv = to_jsonb('erased:' || (n ->> substr(rule, 8)))) THEN RETURN false; END IF;
    ELSIF rule LIKE 'keys:%' THEN
      SELECT jsonb_object_agg(e.key, e.value) INTO kept
      FROM jsonb_each(CASE WHEN jsonb_typeof(oldv) = 'object' THEN oldv ELSE '{}'::jsonb END) e
      WHERE e.key = ANY (string_to_array(substr(rule, 6), ','));
      IF newv IS DISTINCT FROM kept THEN RETURN false; END IF;
    ELSE
      RETURN false;
    END IF;
  END LOOP;
  RETURN (o - cols - 'erased_at') = (n - cols - 'erased_at');
END $function$;

CREATE OR REPLACE FUNCTION public.artifact_chat_message_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF EXISTS(SELECT 1 FROM conversations WHERE id=NEW.conversation_id AND skill_mode) THEN RAISE EXCEPTION 'guided messages require artifact turn' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $function$;
-- Restore the pre-0150 service-role admission grant; the function body never changed.
GRANT EXECUTE ON FUNCTION public.ordinary_chat_claim(uuid,uuid,jsonb,uuid) TO service_role;
-- Staging original verified by server MD5 3029c14ab84580323acba88565786281.
CREATE OR REPLACE FUNCTION public.account_erasure_scrub_content(p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  now_at timestamptz := clock_timestamp(); counts jsonb := '{}'; n bigint;
BEGIN
  IF p_profile_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM account_erasure_requests WHERE profile_id = p_profile_id) THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_NOT_CLOSED' USING ERRCODE = '42501';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS erasure_scope(kind text, id uuid) ON COMMIT DROP;
  DELETE FROM pg_temp.erasure_scope;
  INSERT INTO pg_temp.erasure_scope SELECT 'project', id FROM artifact_projects WHERE actor_id = p_profile_id;
  INSERT INTO pg_temp.erasure_scope SELECT 'round', r.id FROM artifact_rounds r
    JOIN pg_temp.erasure_scope s ON s.kind = 'project' AND s.id = r.project_id;
  INSERT INTO pg_temp.erasure_scope SELECT 'draft', draft_id FROM opc_drafts WHERE actor_id = p_profile_id;
  INSERT INTO pg_temp.erasure_scope SELECT 'plan', p.id FROM opc_plans p
    JOIN pg_temp.erasure_scope s ON s.kind = 'draft' AND s.id = p.draft_id;
  INSERT INTO pg_temp.erasure_scope SELECT 'item', i.work_item_id FROM opc_items i
    JOIN pg_temp.erasure_scope s ON s.kind = 'plan' AND s.id = i.plan_id;

  -- artifact chat turns first: the generation guard compares a live instruction with its turn.
  UPDATE artifact_chat_turns t SET body = NULL, erased_at = now_at
  FROM artifact_chats c JOIN pg_temp.erasure_scope s ON s.kind = 'project' AND s.id = c.project_id
  WHERE t.conversation_id = c.conversation_id AND t.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_chat_turns', n);

  -- Result keeps only its money keys; provider_observations is financial evidence (PR-B2).
  UPDATE artifact_generations g SET input = NULL, erased_at = now_at,
    result = (SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(
      CASE WHEN jsonb_typeof(g.result) = 'object' THEN g.result ELSE '{}'::jsonb END) e
      WHERE e.key IN ('credits', 'inputTokens', 'outputTokens', 'costUsd'))
  FROM pg_temp.erasure_scope s WHERE s.kind = 'project' AND s.id = g.project_id AND g.erased_at IS NULL
    AND g.state IN ('succeeded', 'refunded');
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_generations', n);
  SELECT count(*) INTO n FROM artifact_generations g JOIN pg_temp.erasure_scope s ON s.kind = 'project' AND s.id = g.project_id
  WHERE g.erased_at IS NULL;
  counts := counts || jsonb_build_object('artifact_generations_skipped', n);

  UPDATE artifact_rounds r SET steps = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'round' AND s.id = r.id AND r.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_rounds', n);
  UPDATE artifact_evidence e SET payload = NULL, content_hash = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'project' AND s.id = e.project_id AND e.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_evidence', n);
  UPDATE artifact_confirmations c SET body = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'round' AND s.id = c.round_id AND c.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_confirmations', n);
  UPDATE artifact_candidates c SET body = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'round' AND s.id = c.round_id AND c.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_candidates', n);
  UPDATE artifact_versions v SET report = NULL, report_hash = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'project' AND s.id = v.project_id AND v.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_versions', n);
  UPDATE artifact_requests q SET response = NULL, erased_at = now_at,
    payload = (SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(
      CASE WHEN jsonb_typeof(q.payload) = 'object' THEN q.payload ELSE '{}'::jsonb END) e
      WHERE e.key IN ('sliceExecution', 'slicePhase'))
  FROM pg_temp.erasure_scope s WHERE s.kind = 'project' AND s.id = q.project_id AND q.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_requests', n);
  UPDATE artifact_work_references w SET creation_payload = NULL, source_hash = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'project' AND s.id = w.project_id AND w.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_work_references', n);
  UPDATE agent_slice_links l SET source_hash = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'round' AND s.id = l.round_id AND l.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('agent_slice_links', n);
  UPDATE agent_slice_executions x SET preference_refs = NULL, discussion_refs = NULL, input_hash = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'project' AND s.id = x.project_id AND x.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('agent_slice_executions', n);
  UPDATE artifact_projects p SET work_title = NULL, erased_at = now_at,
    account = CASE WHEN p.account IS NULL THEN NULL ELSE 'erased:' || p.id END
  WHERE p.actor_id = p_profile_id AND p.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_projects', n);

  UPDATE research_operations o SET erased_at = now_at,
    result = (SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(
      CASE WHEN jsonb_typeof(o.result) = 'object' THEN o.result ELSE '{}'::jsonb END) e WHERE e.key = 'cost')
  FROM research_plans p WHERE p.actor_id = p_profile_id AND o.plan_id = p.id AND o.erased_at IS NULL
    AND o.state IN ('succeeded', 'failed', 'cancelled');
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('research_operations', n);
  SELECT count(*) INTO n FROM research_operations o JOIN research_plans p ON p.id = o.plan_id
  WHERE p.actor_id = p_profile_id AND o.erased_at IS NULL;
  counts := counts || jsonb_build_object('research_operations_skipped', n);
  UPDATE research_plans p SET operations = NULL, erased_at = now_at
  WHERE p.actor_id = p_profile_id AND p.erased_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM research_operations o WHERE o.plan_id = p.id AND o.erased_at IS NULL);
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('research_plans', n);

  UPDATE opc_turns t SET input_hash = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'draft' AND s.id = t.draft_id AND t.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_turns', n);
  UPDATE opc_plans p SET request = NULL, body = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'draft' AND s.id = p.draft_id AND p.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_plans', n);
  UPDATE opc_items i SET brief = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'item' AND s.id = i.work_item_id AND i.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_items', n);
  UPDATE opc_item_edits e SET title = NULL, brief = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'item' AND s.id = e.work_item_id AND e.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_item_edits', n);
  UPDATE opc_handoffs h SET payload = NULL, result = NULL, erased_at = now_at
  WHERE h.actor_id = p_profile_id AND h.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_handoffs', n);
  UPDATE opc_topic_openings o SET input = NULL, erased_at = now_at
  FROM opc_topic_workspaces w WHERE w.actor_id = p_profile_id AND o.draft_id = w.draft_id AND o.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_topic_openings', n);
  UPDATE opc_topic_workspaces w SET source_hash = NULL, erased_at = now_at
  WHERE w.actor_id = p_profile_id AND w.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_topic_workspaces', n);
  UPDATE opc_topic_draft_versions v SET request = NULL, body = NULL, erased_at = now_at
  WHERE v.actor_id = p_profile_id AND v.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_topic_draft_versions', n);
  UPDATE opc_library_requests r SET payload = NULL, result = NULL, erased_at = now_at
  WHERE r.actor_id = p_profile_id AND r.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_library_requests', n);
  UPDATE opc_content_versions c SET body = NULL, title = NULL, erased_at = now_at
  WHERE c.actor_id = p_profile_id AND c.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_content_versions', n);
  UPDATE opc_accounts a SET account_key = 'erased:' || a.project_id, erased_at = now_at
  WHERE a.actor_id = p_profile_id AND a.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_accounts', n);
  UPDATE opc_businesses b SET name = NULL, erased_at = now_at
  WHERE b.actor_id = p_profile_id AND b.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_businesses', n);

  -- Private settings with no inbound references are removed outright.
  DELETE FROM opc_work_ui WHERE actor_id = p_profile_id;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_work_ui_deleted', n);
  DELETE FROM opc_account_ui WHERE actor_id = p_profile_id;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_account_ui_deleted', n);
  DELETE FROM opc_publication_ui WHERE actor_id = p_profile_id;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_publication_ui_deleted', n);
  DELETE FROM agent_confirmed_preferences WHERE actor_id = p_profile_id;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('agent_confirmed_preferences_deleted', n);
  DELETE FROM agent_preference_requests WHERE actor_id = p_profile_id;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('agent_preference_requests_deleted', n);
  DELETE FROM artifact_accounts WHERE actor_id = p_profile_id;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_accounts_deleted', n);
  RETURN counts;
END $function$;

DROP FUNCTION public.account_erasure_barrier();
COMMIT;
