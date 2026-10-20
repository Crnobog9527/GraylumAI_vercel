-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAYWALL: irreversible business archive; retain all content and financial evidence.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE public.opc_businesses ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE INDEX IF NOT EXISTS opc_businesses_active_actor_idx ON public.opc_businesses(actor_id)
 WHERE erased_at IS NULL AND archived_at IS NULL;

-- Resolve only server-owned bindings. A topic, account-strategy draft or work item
-- inherits the same business; caller JSON never declares its archive status.
CREATE OR REPLACE FUNCTION public.opc_target_business(a uuid,t jsonb)
RETURNS uuid LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE scope jsonb;bid uuid;pid uuid;did uuid;
BEGIN
 IF t->>'executionId' IS NOT NULL THEN
  SELECT s.scope INTO scope FROM runtime_executions e JOIN runtime_sessions s ON s.id=e.session_id
   WHERE e.id=(t->>'executionId')::uuid AND e.actor_id=a AND s.actor_id=a;
 ELSIF t->>'sessionId' IS NOT NULL THEN
  SELECT s.scope INTO scope FROM runtime_sessions s WHERE s.id=(t->>'sessionId')::uuid AND s.actor_id=a;
 ELSE scope:=t; END IF;
 did:=coalesce(scope->>'draftId',t->>'draftId')::uuid;
 pid:=coalesce(scope->>'workItemId',scope->>'projectId')::uuid;
 SELECT b.id INTO bid FROM opc_businesses b WHERE b.actor_id=a AND (
  b.id=(t->>'businessId')::uuid OR EXISTS(
   SELECT 1 FROM opc_draft_businesses db JOIN opc_drafts d ON d.draft_id=db.draft_id
    WHERE db.business_id=b.id AND d.actor_id=a AND (d.draft_id=did OR d.project_id=pid)) OR EXISTS(
   SELECT 1 FROM opc_accounts ac WHERE ac.business_id=b.id AND ac.actor_id=a
    AND (ac.project_id=pid OR EXISTS(SELECT 1 FROM opc_items i
     WHERE i.account_project_id=ac.project_id AND i.work_item_id=pid))));
 RETURN bid;
END $$;
REVOKE ALL ON FUNCTION public.opc_target_business(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.opc_assert_business_writable(a uuid,t jsonb)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE b opc_businesses;bid uuid:=opc_target_business(a,t);
BEGIN
 IF bid IS NULL THEN RETURN; END IF; -- unrelated/legacy scopes retain their own authorization
 SELECT * INTO b FROM opc_businesses WHERE id=bid AND actor_id=a FOR KEY SHARE;
 IF b.archived_at IS NOT NULL THEN RAISE EXCEPTION 'OPC_BUSINESS_ARCHIVED'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.opc_assert_business_writable(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.opc_businesses_list(p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM bill2_actor(p_actor_id);
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object(
  'businessId',b.id,'name',b.name,'archivedAt',b.archived_at,'isArchived',b.archived_at IS NOT NULL,
  'currentSourceVersionId',b.current_source_version_id,'createdAt',b.created_at,
  'drafts',(SELECT coalesce(jsonb_agg(jsonb_build_object('draftId',d.draft_id,'projectId',d.project_id,
   'roundId',d.round_id,'sessionId',d.session_id) ORDER BY d.draft_id),'[]'::jsonb)
   FROM opc_drafts d JOIN opc_draft_businesses db ON db.draft_id=d.draft_id
   JOIN artifact_projects p ON p.id=d.project_id AND p.actor_id=p_actor_id
   WHERE db.business_id=b.id AND d.actor_id=p_actor_id AND p.erased_at IS NULL AND p.content_deleted_at IS NULL)
  ) ORDER BY b.created_at,b.id),'[]'::jsonb) FROM opc_businesses b
  WHERE b.actor_id=p_actor_id AND b.erased_at IS NULL);
END $$;

CREATE OR REPLACE FUNCTION public.opc_business_archive(p_actor_id uuid,p_business_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b opc_businesses;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 -- Exactly the same user row lock as opc_start_b1: archive/count/insert serialize.
 PERFORM id FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'OPC_DENIED'; END IF;
 -- Mutations/dispatch keep a KEY SHARE lock until commit. NOWAIT avoids reversing
 -- existing business -> financial profile lock order: the owner retries a busy archive.
 BEGIN
  SELECT * INTO b FROM opc_businesses WHERE id=p_business_id AND actor_id=p_actor_id
   AND erased_at IS NULL FOR UPDATE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'OPC_BUSINESS_BUSY'; END;
 IF b.id IS NULL THEN RAISE EXCEPTION 'OPC_BUSINESS_DENIED'; END IF;
 IF b.archived_at IS NULL THEN
  -- A provider call already dispatched must settle first. Never erase/cancel its
  -- money or result while archiving. New claim/dispatch also holds the business lock.
  IF EXISTS(SELECT 1 FROM bill2_runs r JOIN bill2_calls c ON c.run_id=r.id
   WHERE r.actor_id=p_actor_id AND c.dispatched_at IS NOT NULL
    AND ((r.contract_version='bill2.v2' AND c.settled_at IS NULL)
     OR (r.contract_version<>'bill2.v2' AND (NOT r.closed OR c.state NOT IN ('responded','cancelled'))))
    AND opc_target_business(p_actor_id,r.scope)=b.id) THEN
   RAISE EXCEPTION 'OPC_BUSINESS_BUSY'; END IF;
  UPDATE opc_businesses SET archived_at=clock_timestamp(),revision=revision+1
   WHERE id=b.id RETURNING * INTO b;
 END IF;
 RETURN jsonb_build_object('businessId',b.id,'name',b.name,'archivedAt',b.archived_at,'isArchived',true);
END $$;
REVOKE ALL ON FUNCTION public.opc_businesses_list(uuid),public.opc_business_archive(uuid,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.opc_businesses_list(uuid),public.opc_business_archive(uuid,uuid) TO service_role;

-- Patch the post-0322 definition; keep the authoritative membership/refund fix.
DO $$ DECLARE src text;anchor text; BEGIN
 src:=pg_get_functiondef('public.opc_start_b1(uuid,uuid,text,text,uuid,text,text)'::regprocedure);
 IF position('-- 0324 active profiles' IN src)=0 THEN
  anchor:='WHERE business.actor_id=p_actor_id AND business.erased_at IS NULL;';
  IF array_length(string_to_array(src,anchor),1)<>2 THEN RAISE EXCEPTION 'OPC_ARCHIVE_CAP_ANCHOR'; END IF;
  src:=replace(src,anchor,'WHERE business.actor_id=p_actor_id AND business.erased_at IS NULL'
   ||E' AND business.archived_at IS NULL; -- 0324 active profiles');
  -- After the user lock, validate both an explicit business and the business of a
  -- replay. An old request cannot attach a fresh draft to an archived business.
  anchor:='  IF p_business_id IS NOT NULL THEN';
  IF array_length(string_to_array(src,anchor),1)<>2 THEN RAISE EXCEPTION 'OPC_ARCHIVE_START_ANCHOR'; END IF;
  src:=replace(src,anchor,$guard$  PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('businessId',p_business_id));
  PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('draftId',
   (SELECT draft_id FROM opc_drafts WHERE actor_id=p_actor_id AND request_id=p_request_id)));
  IF p_business_id IS NOT NULL THEN$guard$);
  EXECUTE src;
 END IF;
END $$;

-- Same narrow, fail-closed source patch technique as 0201/0249. Only mutating
-- entry points gain a gate. Read/export, settlement, recovery and erasure stay intact.
DO $$ DECLARE spec record;fn record;src text;guard text; BEGIN
 FOR spec IN SELECT * FROM (VALUES
  ('opc_start', $g$jsonb_build_object('draftId',(SELECT draft_id FROM opc_drafts
    WHERE actor_id=p_actor_id AND request_id=p_request_id))$g$, 'true'),
  ('opc_information', $g$jsonb_build_object('draftId',p_draft_id)$g$, 'true'),
  ('opc_step_material', $g$jsonb_build_object('draftId',p_draft_id)$g$, 'true'),
  ('opc_capture_apply', $g$jsonb_build_object('draftId',p_draft_id,'executionId',p_execution_id)$g$, 'true'),
  ('opc_capture_resolve', $g$jsonb_build_object('draftId',p_draft_id)$g$, 'true'),
  ('opc_revise', $g$jsonb_build_object('draftId',p_draft_id)$g$, 'true'),
  ('opc_save_result', $g$jsonb_build_object('draftId',p_draft_id)$g$, 'true'),
  ('opc_save_plan', $g$jsonb_build_object('draftId',p_draft_id)$g$, 'true'),
  ('opc_handoff', $g$jsonb_build_object('draftId',p_draft_id)$g$, 'true'),
  ('opc_handoff_b1', $g$jsonb_build_object('draftId',p_draft_id)$g$, 'true'),
  ('opc_adopt_topics', $g$jsonb_build_object('draftId',p_draft_id)$g$, 'true'),
  ('opc_adopt_topics_with_source', $g$jsonb_build_object('draftId',p_draft_id)$g$, 'true'),
  ('opc_topic_bind', $g$jsonb_build_object('draftId',p_draft_id)$g$, 'true'),
  ('opc_topic_consent', $g$jsonb_build_object('draftId',p_draft_id)$g$, 'true'),
  ('opc_topic_material', $g$jsonb_build_object('draftId',p_draft_id)$g$, 'true'),
  ('opc_topic_draft_save', $g$jsonb_build_object('draftId',p_draft_id)$g$, 'true'),
  ('opc_topic_draft_from_execution', $g$jsonb_build_object('draftId',p_draft_id)$g$, 'true'),
  ('fusion_review_start', $g$jsonb_build_object('draftId',p_draft_id)$g$, 'true'),
  ('opc_account_strategy_begin', $g$jsonb_build_object('projectId',p_account_project_id)$g$, 'true'),
  ('opc_account_strategy_save_checked', $g$jsonb_build_object('projectId',p_account_project_id)$g$, 'true'),
  ('opc_account_ui_change', $g$jsonb_build_object('projectId',p_account_project_id)$g$, 'true'),
  ('opc_work_ui_change', $g$jsonb_build_object('workItemId',p_work_item_id)$g$, 'true'),
  ('opc_publication_ui_change', $g$jsonb_build_object('workItemId',p_work_item_id)$g$, 'true'),
  ('opc_brief_adoption', $g$jsonb_build_object('workItemId',p_work_item_id)$g$, 'true'),
  ('opc_content_from_execution', $g$jsonb_build_object('workItemId',p_work_item_id)$g$, 'true'),
  ('opc_content_manual_save', $g$jsonb_build_object('workItemId',p_work_item_id)$g$, 'true'),
  ('opc_content_reaction', $g$jsonb_build_object('executionId',p_execution_id)$g$, 'true'),
  ('opc_conversation_rename', $g$jsonb_build_object('sessionId',p_session_id)$g$, 'true'),
  ('opc_video_package_from_execution', $g$jsonb_build_object('workItemId',p_work_item_id)$g$, 'true'),
  ('opc_video_results_from_execution', $g$jsonb_build_object('workItemId',p_work_item_id)$g$, 'true'),
  ('opc_video_material_prepare', $g$jsonb_build_object('workItemId',p_work_item_id)$g$, 'true'),
  ('opc_work_result', $g$jsonb_build_object('executionId',p_execution_id)$g$, 'true'),
  ('opc_library_edit', $g$jsonb_build_object(CASE WHEN p_target='business' THEN 'businessId' ELSE 'projectId' END,p_target_id)$g$, 'true'),
  ('artifact_transition', $g$jsonb_build_object('projectId',p_project_id)$g$, $c$p_action NOT IN ('read','report')$c$),
  ('report_revision', $g$jsonb_build_object('draftId',p_draft_id)$g$, $c$p_action NOT IN ('read','latest')$c$),
  ('report_document', $g$jsonb_build_object('executionId',p_execution_id)$g$, $c$p_action IS DISTINCT FROM 'read'$c$),
  ('runtime_start', $g$p_payload->'scope'$g$, 'true'),
  ('runtime_material', $g$jsonb_build_object('sessionId',p_session_id)$g$, 'true'),
  ('fusion_compare_begin', $g$jsonb_build_object('sessionId',p_session_id)$g$, 'true'),
  ('artifact_create_work', $g$jsonb_build_object('projectId',p_project_id)$g$, 'true'),
  ('runtime_admit', $g$jsonb_build_object('sessionId',p_session_id)$g$, 'true'),
  ('bill2_prepare', $g$p_payload->'scope'$g$, 'true'),
  ('bill2_claim', $g$(SELECT scope FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id)$g$, 'true'),
  ('bill2_dispatch', $g$(SELECT scope FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id)$g$, 'true')
 ) changes(name,target,condition) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=spec.name) THEN
   RAISE EXCEPTION 'OPC_ARCHIVE_FUNCTION_MISSING: %',spec.name; END IF;
  FOR fn IN SELECT p.oid,p.oid::regprocedure sig FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname=spec.name LOOP
  src:=pg_get_functiondef(fn.oid);
  IF position('-- 0324 archived business guard' IN src)=0 THEN
   IF position('BEGIN' IN src)=0 THEN RAISE EXCEPTION 'OPC_ARCHIVE_GUARD_ANCHOR: %',fn.sig; END IF;
   guard:=format(E'\n -- 0324 archived business guard\n IF %s THEN PERFORM opc_assert_business_writable(p_actor_id,%s); END IF;\n',
    spec.condition,spec.target);
   EXECUTE regexp_replace(src,'\mBEGIN\M','BEGIN'||guard);
  END IF;
  END LOOP;
 END LOOP;
 -- Internal claim is also called by Fusion and directly by BILL2. Guard it
 -- before reserving credits; dispatch rechecks under its own transaction lock.
 src:=pg_get_functiondef('public.bill2_payg_claim(uuid,uuid,integer,jsonb)'::regprocedure);
 IF position('-- 0324 archived business guard' IN src)=0 THEN
  EXECUTE regexp_replace(src,'\mBEGIN\M',$g$BEGIN
 -- 0324 archived business guard
 PERFORM opc_assert_business_writable(a,(SELECT scope FROM bill2_runs WHERE id=rid AND actor_id=a));$g$);
 END IF;
END $$;
COMMIT;
