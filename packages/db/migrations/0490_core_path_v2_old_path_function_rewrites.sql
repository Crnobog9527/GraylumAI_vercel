-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-12 batch B-rewrites: the functions that stay after batch F but still named an old-path object are rewritten
-- first (same name and signature; Node unchanged), so batch F's guard has nothing left to refuse. Each rewrite removes a branch that
-- reads or writes a row only the old path creates; for turn-path data the results are the same (the tests in
-- packages/db/tests/v2-12-b-rewrites compare the calls the live code makes before and after).
--   runtime_session_result_view: 'sourceAvailable' no longer asks runtime_history_available about an old execution (a result saved
--     from an old execution is no longer available once old histories go; turn-sourced rows are overridden by the turn view as before).
--     runtime_session_results_list_turns / _save_turn / _edit / _versions use only this helper and need no change.
--   runtime_positioning_gate: refusals24h counts the turns refused for it (failure_code 'positioning_required'), the same expression
--     turn_open returns, not old executions cancelled for it.
--   runtime_test_actor_access: the "has an old run of a test window" branch is gone (no turn records a window); the window list stays.
--   opc_capture_apply: capture of old completed mentor executions has nothing left to process (a mentor reply is a turn's reply);
--     the guards and the draft/scope refusal stay, the batch is empty, an execution id is refused.
--   fusion_review_fee_settle: a review's price is its jury turn's freeze, not a fee row: no fee row, returns NULL as before for a review without one.
--   fusion_review_archive_reconcile: an archived business ends its running or paused reviews as incomplete (source_archived); no old fee,
--     billing group or provider call remains to cancel or settle.
--   fusion_review_start: only the replay of a known request stays (the turn path creates reviews in turn_fusion_open); a start that would
--     create a review through the old fee path is refused as invalid.
-- Repeatable: whole-function CREATE OR REPLACE. Recovery: re-apply the previous text from git history; nothing is written or removed.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.runtime_session_result_view(r runtime_session_results, p_versions integer)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT jsonb_build_object('id',r.id,'familyId',r.family_id,'version',r.version,'versions',p_versions,
  'resultType',r.result_type,'title',r.title,'body',r.body,'sourceExecutionId',r.source_execution_id,
  'sourceAvailable',r.source_execution_id IS NULL,
  'createdAt',r.created_at)
$function$;

CREATE OR REPLACE FUNCTION public.runtime_positioning_gate(p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT jsonb_build_object('positioned',public.opc_has_confirmed_positioning(p_actor_id),
  'refusals24h',(SELECT count(*) FROM public.turns r WHERE r.actor_id=p_actor_id AND r.failure_code='positioning_required'
   AND r.closed_at>now()-interval '24 hours'));
$function$;

CREATE OR REPLACE FUNCTION public.runtime_test_actor_access(p_actor_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM runtime_test_windows WHERE p_actor_id=ANY(actor_ids) OR (all_actors AND enabled AND clock_timestamp()<expires_at))
 THEN RAISE EXCEPTION 'RUNTIME_TEST_ACTOR_DENIED' USING ERRCODE='42501';END IF;
 RETURN true;
END $function$;

CREATE OR REPLACE FUNCTION public.fusion_review_fee_settle(p_actor_id uuid, p_review_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM bill2_actor(p_actor_id);
  RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public.opc_capture_apply(p_actor_id uuid, p_draft_id uuid, p_execution_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d opc_drafts;
BEGIN
 -- 0324 archived business guard
 IF true THEN PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('draftId',p_draft_id,'executionId',p_execution_id)); END IF;
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO d FROM opc_drafts WHERE actor_id=p_actor_id AND draft_id=p_draft_id;
 IF d.draft_id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',d.draft_id)),false)
 THEN RAISE EXCEPTION 'OPC_CAPTURE_DENIED';END IF;
 -- Nothing is left to capture from: a mentor reply is a turn's reply (applied by turn_close), and no execution exists to name.
 IF p_execution_id IS NOT NULL THEN RAISE EXCEPTION 'OPC_CAPTURE_DENIED';END IF;
 RETURN jsonb_build_object('processed','[]'::jsonb,'remaining',0,'hasMore',false);
END $function$;

CREATE OR REPLACE FUNCTION public.fusion_review_archive_reconcile(p_actor_id uuid, p_target jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE target jsonb:=p_target;business uuid;item record;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF target->>'reviewId' IS NOT NULL THEN
  target:=jsonb_build_object('draftId',(SELECT draft_id FROM fusion_reviews
   WHERE id=(target->>'reviewId')::uuid AND actor_id=p_actor_id));
 END IF;
 SELECT b.id INTO business FROM opc_businesses b WHERE b.actor_id=p_actor_id AND b.archived_at IS NOT NULL
  AND b.id=opc_target_business(p_actor_id,target);
 IF business IS NULL THEN RETURN false; END IF;
 PERFORM rv.id FROM fusion_reviews rv WHERE rv.actor_id=p_actor_id AND rv.state IN ('running','paused')
  AND opc_target_business(p_actor_id,jsonb_build_object('draftId',rv.draft_id))=business ORDER BY rv.id FOR UPDATE;
 FOR item IN SELECT rv.* FROM fusion_reviews rv WHERE rv.actor_id=p_actor_id AND rv.state IN ('running','paused')
  AND opc_target_business(p_actor_id,jsonb_build_object('draftId',rv.draft_id))=business ORDER BY rv.id LOOP
  UPDATE fusion_reviews SET state='incomplete',outcome=jsonb_build_object('kind','source_archived'),
   updated_at=clock_timestamp(),ended_at=clock_timestamp() WHERE id=item.id;
 END LOOP;
 RETURN true;
END $function$;

CREATE OR REPLACE FUNCTION public.fusion_review_start(p_actor_id uuid, p_request_id uuid, p_draft_id uuid, p_source_version_id uuid, p_config jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE rv fusion_reviews;
BEGIN
 -- 0324 archived business guard
 IF true THEN BEGIN
   PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('draftId',p_draft_id));
  EXCEPTION WHEN raise_exception THEN
   -- 0326 archived review replay repair
   IF SQLERRM<>'OPC_BUSINESS_ARCHIVED' THEN RAISE; END IF;
   PERFORM fusion_review_archive_reconcile(p_actor_id,jsonb_build_object('draftId',p_draft_id));
   IF EXISTS(SELECT 1 FROM fusion_reviews existing WHERE existing.actor_id=p_actor_id
    AND existing.request_id=p_request_id AND existing.draft_id=p_draft_id AND existing.source_version_id=p_source_version_id) THEN
    RETURN fusion_review_view((SELECT existing FROM fusion_reviews existing
     WHERE existing.actor_id=p_actor_id AND existing.request_id=p_request_id));
   END IF;
   RAISE;
  END; END IF;
 IF opc_draft_readonly(p_actor_id,p_draft_id) THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF; -- 0249 read-only
  PERFORM bill2_actor(p_actor_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('fusion-review:'||p_actor_id::text,0));
  SELECT * INTO rv FROM fusion_reviews WHERE actor_id=p_actor_id AND request_id=p_request_id;
  IF rv.id IS NOT NULL THEN
    IF rv.draft_id<>p_draft_id OR rv.source_version_id<>p_source_version_id THEN RAISE EXCEPTION 'FUSION_REVIEW_CONFLICT'; END IF;
    RETURN fusion_review_view(rv);
  END IF;
  -- A review is created by turn_fusion_open together with its jury turn; this function only answers a known request.
  RAISE EXCEPTION 'FUSION_REVIEW_INVALID';
END $function$;

COMMIT;
