-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Delete only closed-subject business leaves. Original financial rows/identities remain.
BEGIN;
SET LOCAL lock_timeout='2s';
CREATE OR REPLACE FUNCTION public.erasure_business_owner(t text,j jsonb)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result uuid;
BEGIN
 CASE
 WHEN t IN ('opc_content_versions','opc_handoffs','opc_library_requests','opc_topic_workspaces',
  'opc_topic_draft_versions','opc_video_material_bindings','opc_account_strategy_request_bases',
  'opc_account_strategy_drafts','opc_accounts','opc_businesses','opc_drafts','artifact_projects',
  'runtime_sessions','runtime_executions') THEN RETURN (j->>'actor_id')::uuid;
 WHEN t IN ('conversations','ordinary_chat_requests') THEN RETURN (j->>'user_id')::uuid;
 WHEN t IN ('messages','conversation_context_snapshots','artifact_chat_turns','artifact_chats') THEN
  SELECT user_id INTO result FROM conversations WHERE id=(j->>'conversation_id')::uuid;
 WHEN t IN ('artifact_versions','artifact_requests','artifact_evidence','artifact_work_references','artifact_rounds') THEN
  SELECT actor_id INTO result FROM artifact_projects WHERE id=(j->>'project_id')::uuid;
 WHEN t IN ('artifact_confirmations','artifact_candidates','agent_slice_links') THEN
  SELECT p.actor_id INTO result FROM artifact_rounds r JOIN artifact_projects p ON p.id=r.project_id
   WHERE r.id=(j->>'round_id')::uuid;
 WHEN t IN ('runtime_tool_calls','runtime_history_dependencies','opc_result_links') THEN
  SELECT actor_id INTO result FROM runtime_executions WHERE id=(j->>'execution_id')::uuid;
 WHEN t IN ('runtime_scope_material','runtime_session_history','runtime_session_batches') THEN
  SELECT actor_id INTO result FROM runtime_sessions WHERE id=(j->>'session_id')::uuid;
 WHEN t IN ('opc_turns','opc_topic_openings','opc_plans','opc_draft_businesses') THEN
  SELECT actor_id INTO result FROM opc_drafts WHERE draft_id=(j->>'draft_id')::uuid;
 WHEN t IN ('opc_items','opc_item_edits') THEN
  SELECT actor_id INTO result FROM artifact_projects WHERE id=(j->>'work_item_id')::uuid;
 WHEN t='artifact_evidence_restrictions' THEN
  SELECT p.actor_id INTO result FROM artifact_evidence e JOIN artifact_projects p ON p.id=e.project_id
   WHERE e.id=(j->>'evidence_id')::uuid;
 ELSE RETURN NULL;
 END CASE;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.erasure_business_owner(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Preserve the immutable UPDATE behavior. The new DELETE exception is closed-subject-only,
-- with cleared-body markers, plus three explicitly nonfinancial immutable link tables.
CREATE OR REPLACE FUNCTION public.erasure_business_delete_allowed(t text,j jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT (j->>'erased_at' IS NOT NULL OR t IN
  ('opc_video_material_bindings','opc_account_strategy_request_bases','opc_account_strategy_drafts','opc_result_links'))
  AND EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=erasure_business_owner(t,j));
$$;
REVOKE ALL ON FUNCTION public.erasure_business_delete_allowed(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.erasure_business_delete_allowed(text,jsonb) TO service_role;
DO $$
DECLARE signature text; original text; needle text:=E'BEGIN\n';
 addition text:=$patch$  IF TG_OP='DELETE' AND public.erasure_business_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;
$patch$;
BEGIN
 FOREACH signature IN ARRAY ARRAY['public.artifact_immutable()','public.artifact_chat_history_immutable()'] LOOP
  original:=pg_get_functiondef(signature::regprocedure);
  IF position('public.erasure_business_delete_allowed' IN original)=0 THEN
   IF length(original)-length(replace(original,needle,''))<>length(needle) THEN
    RAISE EXCEPTION 'ERASURE_PRUNE_SOURCE_MISMATCH';
   END IF;
   EXECUTE replace(original,needle,needle||addition);
  END IF;
 END LOOP;
END $$;

-- Retain original usage provenance without the old conversation CASCADE. This is a
-- one-way detach on the original financial row, not a new execution or accounting identity.
ALTER TABLE public.token_stats ADD COLUMN IF NOT EXISTS erased_conversation_id uuid;
ALTER TABLE public.token_stats ADD COLUMN IF NOT EXISTS erased_message_id uuid;
ALTER TABLE public.token_stats DROP CONSTRAINT token_stats_execution_scope;
ALTER TABLE public.token_stats ADD CONSTRAINT token_stats_execution_scope CHECK(
 num_nonnulls(conversation_id,artifact_generation_id,bill2_run_id)=1 OR
 (num_nonnulls(conversation_id,artifact_generation_id,bill2_run_id)=0 AND content_erased_at IS NOT NULL
  AND erased_conversation_id IS NOT NULL));
CREATE OR REPLACE FUNCTION public.erasure_usage_unlink_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.erased_conversation_id IS NOT NULL OR NEW.erased_message_id IS NOT NULL THEN
   RAISE EXCEPTION 'ERASURE_USAGE_IDENTITY_DENIED';
  END IF;
 ELSIF OLD.erased_conversation_id IS NOT NULL THEN
  IF NEW.erased_conversation_id IS DISTINCT FROM OLD.erased_conversation_id
   OR NEW.erased_message_id IS DISTINCT FROM OLD.erased_message_id
   OR NEW.conversation_id IS NOT NULL OR NEW.message_id IS NOT NULL THEN RAISE EXCEPTION 'ERASURE_USAGE_IDENTITY_DENIED'; END IF;
 ELSIF NEW.erased_conversation_id IS NOT NULL OR NEW.erased_message_id IS NOT NULL THEN
  IF OLD.content_erased_at IS NULL OR OLD.conversation_id IS NULL
   OR NEW.erased_conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.erased_message_id IS DISTINCT FROM OLD.message_id
   OR NEW.conversation_id IS NOT NULL OR NEW.message_id IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=OLD.user_id)
   OR (to_jsonb(OLD)-ARRAY['conversation_id','message_id','erased_conversation_id','erased_message_id']) IS DISTINCT FROM
      (to_jsonb(NEW)-ARRAY['conversation_id','message_id','erased_conversation_id','erased_message_id']) THEN
   RAISE EXCEPTION 'ERASURE_USAGE_IDENTITY_DENIED';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS aa_erasure_usage_unlink ON public.token_stats;
CREATE TRIGGER aa_erasure_usage_unlink BEFORE INSERT OR UPDATE ON public.token_stats
 FOR EACH ROW EXECUTE FUNCTION public.erasure_usage_unlink_guard();
REVOKE ALL ON FUNCTION public.erasure_usage_unlink_guard() FROM PUBLIC,anon,authenticated,service_role;

-- Late application/activity diagnostics are not financial authority and cannot recreate
-- private content after closure. Original financial receipts/ledgers remain untouched.
CREATE OR REPLACE FUNCTION public.account_erasure_log_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=NEW.user_id)
  OR TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=OLD.user_id) THEN
  RETURN NULL;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS account_erasure_log_guard ON public.application_logs;
CREATE TRIGGER account_erasure_log_guard BEFORE INSERT OR UPDATE ON public.application_logs
 FOR EACH ROW EXECUTE FUNCTION public.account_erasure_log_guard();
DROP TRIGGER IF EXISTS account_erasure_log_guard ON public.user_activity_logs;
CREATE TRIGGER account_erasure_log_guard BEFORE INSERT OR UPDATE ON public.user_activity_logs
 FOR EACH ROW EXECUTE FUNCTION public.account_erasure_log_guard();
REVOKE ALL ON FUNCTION public.account_erasure_log_guard() FROM PUBLIC,anon,authenticated,service_role;

-- Empty windows are allowed only when disabled; the original budget chain is retained.
ALTER TABLE public.runtime_test_windows DROP CONSTRAINT runtime_test_windows_actor_ids_check;
ALTER TABLE public.runtime_test_windows ADD CONSTRAINT runtime_test_windows_actor_ids_check
 CHECK(cardinality(actor_ids) BETWEEN 1 AND 8 OR (NOT enabled AND cardinality(actor_ids)=0));

CREATE OR REPLACE FUNCTION public.account_erasure_prune_business(p_profile_id uuid,p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t text; item record; n integer; removed integer:=0; legacy_evidence boolean;
BEGIN
 PERFORM account_erasure_assert_closed(p_profile_id);
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN RAISE EXCEPTION 'ERASURE_BATCH_LIMIT_INVALID'; END IF;
 IF NOT account_erasure_barrier() THEN RETURN 0; END IF;
 legacy_evidence:=EXISTS(SELECT 1 FROM artifact_generations g JOIN artifact_projects p ON p.id=g.project_id
  WHERE p.actor_id=p_profile_id) OR EXISTS(SELECT 1 FROM agent_slice_executions x JOIN artifact_projects p ON p.id=x.project_id
  WHERE p.actor_id=p_profile_id);
 UPDATE runtime_test_windows SET actor_ids=array_remove(actor_ids,p_profile_id),
  enabled=enabled AND cardinality(array_remove(actor_ids,p_profile_id))>0
  WHERE id IN (SELECT id FROM runtime_test_windows WHERE p_profile_id=ANY(actor_ids) LIMIT 100 FOR UPDATE SKIP LOCKED);
 -- Financial rows are never deleted. The existing guard permits only unchanged metadata;
 -- ordinary direct nullable content links may be safely severed on a closed, scrubbed row.
 UPDATE token_stats SET erased_conversation_id=conversation_id,erased_message_id=message_id,conversation_id=NULL,message_id=NULL WHERE ctid IN
  (SELECT ctid FROM token_stats WHERE user_id=p_profile_id AND content_erased_at IS NOT NULL
   AND conversation_id IS NOT NULL LIMIT p_limit FOR UPDATE SKIP LOCKED);
 FOREACH t IN ARRAY ARRAY[
  'opc_video_material_bindings','opc_account_strategy_request_bases','opc_result_links','opc_content_versions',
  'opc_item_edits','opc_items','opc_plans','opc_turns',
  'opc_topic_openings','opc_topic_draft_versions','opc_topic_workspaces','opc_handoffs',
  'opc_account_strategy_drafts','opc_draft_businesses','opc_accounts','opc_businesses',
  'opc_drafts','opc_library_requests','runtime_history_dependencies','runtime_tool_calls',
  'runtime_session_batches','runtime_session_history','runtime_executions','runtime_scope_material',
  'runtime_sessions','conversation_context_snapshots','messages','ordinary_chat_requests',
  'conversations','agent_slice_links','artifact_work_references','artifact_evidence_restrictions',
  'artifact_confirmations','artifact_candidates','artifact_versions','artifact_requests',
  'artifact_evidence','artifact_rounds','artifact_projects'
 ] LOOP
  EXIT WHEN removed>=p_limit;
  -- Legacy financial evidence is not covered by BILL2 projection: keep its original context
  -- identities (already body-scrubbed by B1) until the financial review is resolved.
  IF legacy_evidence AND (t LIKE 'artifact_%' OR t IN ('agent_slice_links','opc_result_links')) THEN CONTINUE; END IF;
  FOR item IN EXECUTE format('SELECT ctid AS row_tid,to_jsonb(x) AS body FROM public.%I x
   WHERE public.erasure_business_owner(%L,to_jsonb(x))=$1 LIMIT $2 FOR UPDATE SKIP LOCKED',t,t)
   USING p_profile_id,p_limit-removed LOOP
   -- Body-bearing rows must have passed B1. Conversation deletion also retains its original
   -- legacy guards, and a RETURN NULL is observed as zero affected rows, never completion.
   IF item.body ? 'erased_at' AND item.body->>'erased_at' IS NULL THEN CONTINUE; END IF;
   IF t='runtime_executions' AND EXISTS(SELECT 1 FROM bill2_runs b
     WHERE b.session_ref=(item.body->>'session_id')::uuid) THEN CONTINUE; END IF;
   BEGIN
    EXECUTE format('DELETE FROM public.%I WHERE ctid=$1',t) USING item.row_tid;
    GET DIAGNOSTICS n=ROW_COUNT;removed:=removed+n;
   EXCEPTION WHEN foreign_key_violation OR check_violation OR lock_not_available THEN
    -- A retained financial parent or a shared dependency stays. No cascade/trigger bypass.
    NULL;
   END;
  END LOOP;
 END LOOP;
 RETURN removed;
END $$;
REVOKE ALL ON FUNCTION public.account_erasure_prune_business(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.account_erasure_business_remaining(p_profile_id uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT (SELECT count(*) FROM runtime_sessions WHERE actor_id=p_profile_id)
 +(SELECT count(*) FROM conversations WHERE user_id=p_profile_id)
 +(SELECT count(*) FROM opc_drafts WHERE actor_id=p_profile_id)
 +(SELECT count(*) FROM opc_library_requests WHERE actor_id=p_profile_id)
 +(SELECT count(*) FROM artifact_projects p WHERE actor_id=p_profile_id
   AND NOT EXISTS(SELECT 1 FROM artifact_generations g WHERE g.project_id=p.id)
   AND NOT EXISTS(SELECT 1 FROM agent_slice_executions x WHERE x.project_id=p.id));
$$;
REVOKE ALL ON FUNCTION public.account_erasure_business_remaining(uuid) FROM PUBLIC,anon,authenticated,service_role;
DO $$
DECLARE original text; needle text;
BEGIN
 original:=pg_get_functiondef('public.account_erasure_local_cleanup(uuid,boolean)'::regprocedure);
 needle:=' remaining:=account_erasure_local_remaining(p_profile_id);';
 IF position('PERFORM account_erasure_prune_business(p_profile_id);' IN original)=0 THEN
  IF length(original)-length(replace(original,needle,''))<>length(needle) THEN RAISE EXCEPTION 'ERASURE_PRUNE_SOURCE_MISMATCH'; END IF;
  EXECUTE replace(original,needle,E' PERFORM account_erasure_prune_business(p_profile_id);\n'||needle);
 END IF;
 original:=pg_get_functiondef('public.account_erasure_local_remaining(uuid)'::regprocedure);
 needle:='account_erasure_body_remaining(p_profile_id)';
 IF position('account_erasure_business_remaining(p_profile_id)' IN original)=0 THEN
  IF length(original)-length(replace(original,needle,''))<>length(needle) THEN RAISE EXCEPTION 'ERASURE_PRUNE_SOURCE_MISMATCH'; END IF;
  EXECUTE replace(original,needle,'account_erasure_business_remaining(p_profile_id)+'||needle);
 END IF;
END $$;
COMMIT;
