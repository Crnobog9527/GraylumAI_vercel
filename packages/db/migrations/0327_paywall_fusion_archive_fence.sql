-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- PAYWALL: fence every Fusion transaction against its persisted source business.
-- 0324 is already applied to staging and must stay immutable. No stored data is rewritten.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.opc_target_business(a uuid,t jsonb)
RETURNS uuid LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE scope jsonb;bid uuid;pid uuid;did uuid;
BEGIN
 IF t->>'runId' IS NOT NULL THEN
  SELECT coalesce(s.scope,r.scope) INTO scope FROM bill2_runs r
   LEFT JOIN fusion_billing_groups g ON g.id=r.fusion_group_id AND g.actor_id=a
   LEFT JOIN runtime_sessions s ON s.id=g.source_session_id AND s.actor_id=a
   WHERE r.id=(t->>'runId')::uuid AND r.actor_id=a;
 ELSIF t->>'groupId' IS NOT NULL THEN
  SELECT s.scope INTO scope FROM fusion_billing_groups g
   JOIN runtime_sessions s ON s.id=g.source_session_id AND s.actor_id=a
   WHERE g.id=(t->>'groupId')::uuid AND g.actor_id=a;
 ELSIF t->>'executionId' IS NOT NULL THEN
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

-- Each mutation acquires the same business KEY SHARE lock as 0324, before its
-- own compare/group/run locks. Archive takes FOR UPDATE NOWAIT and the user lock.
-- Independent transactions therefore recheck, not just the earlier begin call.
DO $$ DECLARE spec record;src text;guard text;fn regprocedure; BEGIN
 FOR spec IN SELECT * FROM (VALUES
  ('fusion_compare_gate(uuid,uuid,text,boolean)',
   $g$jsonb_build_object('sessionId',(SELECT session_id FROM fusion_compares
    WHERE id=p_compare_id AND actor_id=p_actor_id))$g$),
  ('fusion_compare_claim(uuid,uuid,jsonb)',
   $g$jsonb_build_object('sessionId',(SELECT session_id FROM fusion_compares
    WHERE id=p_compare_id AND actor_id=p_actor_id))$g$),
  ('fusion_compare_adopt(uuid,uuid,integer,uuid,jsonb,jsonb)',
   $g$jsonb_build_object('sessionId',(SELECT session_id FROM fusion_compares
    WHERE id=p_compare_id AND actor_id=p_actor_id))$g$),
  ('fusion_group_admit(uuid,uuid,text,uuid,jsonb)', $g$jsonb_build_object('sessionId',p_source_session_id)$g$),
  ('fusion_group_create(uuid,uuid,text,uuid)', $g$jsonb_build_object('sessionId',p_source_session_id)$g$),
  ('fusion_group_attach(uuid,uuid,uuid)', $g$jsonb_build_object('groupId',p_group_id)$g$),
  ('fusion_group_claim(uuid,uuid,text,integer,jsonb)', $g$jsonb_build_object('groupId',p_group_id)$g$)
 ) changes(signature,target) LOOP
  fn:=('public.'||spec.signature)::regprocedure;
  src:=pg_get_functiondef(fn);
  IF position('-- 0327 Fusion source archive guard' IN src)=0 THEN
   IF position('BEGIN' IN src)=0 THEN RAISE EXCEPTION 'OPC_FUSION_ARCHIVE_SOURCE_MISMATCH: %',fn; END IF;
   guard:=E'
 -- 0327 Fusion source archive guard
 PERFORM opc_assert_business_writable(p_actor_id,'||spec.target||E');
';
   EXECUTE regexp_replace(src,'\mBEGIN\M','BEGIN'||guard);
  END IF;
 END LOOP;
END $$;

-- A compare column uses a fresh temporary BILL2 draft. Resolve its *run* through
-- the authoritative Fusion group -> source session, rather than trusting that draft.
-- This also fences direct claim/dispatch retries after group admission committed.
DO $$ DECLARE spec record;src text;fn regprocedure; BEGIN
 FOR spec IN SELECT * FROM (VALUES
  ('bill2_claim(uuid,uuid,integer,jsonb)',
   '(SELECT scope FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id)',
   'jsonb_build_object(''runId'',p_run_id)'),
  ('bill2_dispatch(uuid,uuid,uuid,uuid,boolean,jsonb)',
   '(SELECT scope FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id)',
   'jsonb_build_object(''runId'',p_run_id)'),
  ('bill2_payg_claim(uuid,uuid,integer,jsonb)',
   '(SELECT scope FROM bill2_runs WHERE id=rid AND actor_id=a)',
   'jsonb_build_object(''runId'',rid)'),
  ('opc_business_archive(uuid,uuid)',
   'opc_target_business(p_actor_id,r.scope)=b.id',
   'opc_target_business(p_actor_id,jsonb_build_object(''runId'',r.id))=b.id')
 ) changes(signature,anchor,replacement) LOOP
  fn:=('public.'||spec.signature)::regprocedure;
  src:=pg_get_functiondef(fn);
  IF position('-- 0327 Fusion run archive guard' IN src)=0 THEN
   IF array_length(string_to_array(src,spec.anchor),1)<>2 THEN
    RAISE EXCEPTION 'OPC_FUSION_ARCHIVE_RUN_MISMATCH: %',fn; END IF;
   src:=replace(src,spec.anchor,spec.replacement);
   EXECUTE regexp_replace(src,'\mBEGIN\M',E'BEGIN
 -- 0327 Fusion run archive guard');
  END IF;
 END LOOP;
END $$;
-- Read, stop/cancel, provider receipts, verdicts and settlement deliberately retain
-- their original permissions and behavior. Already spent money can still reconcile.
COMMIT;
