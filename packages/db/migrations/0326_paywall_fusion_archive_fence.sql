-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- PAYWALL: fence every Fusion transaction against its persisted source business.
-- 0324 stays immutable. Reports/history stay intact; legacy held fees reconcile transactionally.
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
  IF position('-- 0326 Fusion source archive guard' IN src)=0 THEN
   IF position('BEGIN' IN src)=0 THEN RAISE EXCEPTION 'OPC_FUSION_ARCHIVE_SOURCE_MISMATCH: %',fn; END IF;
   guard:=E'
 -- 0326 Fusion source archive guard
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
  IF position('-- 0326 Fusion run archive guard' IN src)=0 THEN
   IF array_length(string_to_array(src,spec.anchor),1)<>2 THEN
    RAISE EXCEPTION 'OPC_FUSION_ARCHIVE_RUN_MISMATCH: %',fn; END IF;
   src:=replace(src,spec.anchor,spec.replacement);
   EXECUTE regexp_replace(src,'\mBEGIN\M',E'BEGIN
 -- 0326 Fusion run archive guard');
  END IF;
 END LOOP;
END $$;
-- Owner: a review, once enabled, must finish (MASTER_PLAN 2026-10-17).
-- Archive must not become a new Stop button. Existing busy semantics cover the
-- whole active review/fixed fee, including between its individual model calls.
-- A table transition trigger also protects an already-running 0324 RPC during
-- rollout. Clients have no table UPDATE grant; archive already holds the actor
-- and business locks. Installing the trigger waits for older table writers.
CREATE OR REPLACE FUNCTION public.opc_review_archive_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL AND (
  EXISTS(SELECT 1 FROM fusion_reviews rv WHERE rv.actor_id=NEW.actor_id
   AND (rv.state IN ('running','paused') OR EXISTS(SELECT 1 FROM fusion_review_fees f
    WHERE f.review_id=rv.id AND f.state='held'))
   AND opc_target_business(NEW.actor_id,jsonb_build_object('draftId',rv.draft_id))=NEW.id)
  OR EXISTS(SELECT 1 FROM bill2_runs br JOIN fusion_billing_groups g ON g.id=br.fusion_group_id
   JOIN bill2_calls c ON c.run_id=br.id WHERE br.actor_id=NEW.actor_id AND g.actor_id=NEW.actor_id
   AND g.kind='review' AND c.settled_at IS NULL
   AND opc_target_business(NEW.actor_id,jsonb_build_object('runId',br.id))=NEW.id)
 ) THEN RAISE EXCEPTION 'OPC_BUSINESS_BUSY'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.opc_review_archive_guard() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS opc_review_archive_guard ON public.opc_businesses;
CREATE TRIGGER opc_review_archive_guard BEFORE UPDATE OF archived_at ON public.opc_businesses
 FOR EACH ROW EXECUTE FUNCTION public.opc_review_archive_guard();

-- Repair pre-0326 inconsistent data, not a voluntary review stop: an already
-- archived source cannot complete its review. Reuse the fixed-price failure
-- policy (0294): unfulfilled review refunds, delivered revisions stay charged.
-- Review -> ALL runs -> sorted model locks -> financial locks, before any refund.
CREATE OR REPLACE FUNCTION public.fusion_review_archive_reconcile(p_actor_id uuid,p_target jsonb)
RETURNS boolean LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE target jsonb:=p_target;business uuid;item record;model_key bigint;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF target->>'reviewId' IS NOT NULL THEN
  target:=jsonb_build_object('draftId',(SELECT draft_id FROM fusion_reviews
   WHERE id=(target->>'reviewId')::uuid AND actor_id=p_actor_id));
 END IF;
 SELECT b.id INTO business FROM opc_businesses b WHERE b.actor_id=p_actor_id AND b.archived_at IS NOT NULL
  AND b.id=opc_target_business(p_actor_id,target);
 IF business IS NULL THEN RETURN false; END IF;
 PERFORM rv.id FROM fusion_reviews rv WHERE rv.actor_id=p_actor_id
  AND (rv.state IN ('running','paused') OR EXISTS(SELECT 1 FROM fusion_review_fees f WHERE f.review_id=rv.id AND f.state='held'))
  AND opc_target_business(p_actor_id,jsonb_build_object('draftId',rv.draft_id))=business ORDER BY rv.id FOR UPDATE;
 PERFORM br.id FROM bill2_runs br JOIN fusion_billing_groups g ON g.id=br.fusion_group_id
  WHERE br.actor_id=p_actor_id AND g.actor_id=p_actor_id AND g.kind='review' AND (NOT br.closed OR EXISTS(
   SELECT 1 FROM bill2_calls c WHERE c.run_id=br.id AND c.settled_at IS NULL))
  AND opc_target_business(p_actor_id,jsonb_build_object('runId',br.id))=business ORDER BY br.id FOR UPDATE OF br;
 FOR model_key IN SELECT DISTINCT hashtextextended('bill2-payg:'||(x->>'model'),0)
  FROM bill2_runs br JOIN fusion_billing_groups g ON g.id=br.fusion_group_id,
   jsonb_array_elements(br.payload->'callPolicy') x
  WHERE br.actor_id=p_actor_id AND g.kind='review' AND (NOT br.closed OR EXISTS(
   SELECT 1 FROM bill2_calls c WHERE c.run_id=br.id AND c.settled_at IS NULL))
  AND opc_target_business(p_actor_id,jsonb_build_object('runId',br.id))=business ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(model_key);
 END LOOP;
 -- A crash can leave a saved body without its host verdict. Serialize with
 -- output-save/verdict and keep the existing unjudged_saved recovery meaning;
 -- cancellation must not hide that output or turn a delivered summary into a refund.
 PERFORM c.id FROM bill2_calls c JOIN bill2_runs br ON br.id=c.run_id
  JOIN fusion_billing_groups g ON g.id=br.fusion_group_id
  WHERE br.actor_id=p_actor_id AND g.actor_id=p_actor_id AND g.kind='review' AND c.settled_at IS NULL
  AND opc_target_business(p_actor_id,jsonb_build_object('runId',br.id))=business ORDER BY c.id FOR UPDATE OF c;
 UPDATE bill2_calls c SET fusion_verdict='unjudged_saved' FROM bill2_runs br,fusion_billing_groups g
  WHERE c.run_id=br.id AND br.fusion_group_id=g.id AND br.actor_id=p_actor_id AND g.actor_id=p_actor_id AND g.kind='review'
  AND c.fusion_verdict IS NULL AND c.settled_at IS NULL AND c.dispatched_at IS NOT NULL AND NOT c.provider_rejected
  AND NOT(br.closed AND br.outcome='confirmed_failure') AND br.content_deleted_at IS NULL
  AND EXISTS(SELECT 1 FROM fusion_call_outputs o WHERE o.call_id=c.id AND o.actor_id=p_actor_id)
  AND opc_target_business(p_actor_id,jsonb_build_object('runId',br.id))=business;
 FOR item IN SELECT br.id FROM bill2_runs br JOIN fusion_billing_groups g ON g.id=br.fusion_group_id
  WHERE br.actor_id=p_actor_id AND g.kind='review' AND (NOT br.closed OR EXISTS(
   SELECT 1 FROM bill2_calls c WHERE c.run_id=br.id AND c.settled_at IS NULL))
  AND opc_target_business(p_actor_id,jsonb_build_object('runId',br.id))=business ORDER BY br.id LOOP
  PERFORM bill2_cancel(p_actor_id,item.id);PERFORM bill2_finalize(p_actor_id,item.id);
 END LOOP;
 FOR item IN SELECT rv.* FROM fusion_reviews rv WHERE rv.actor_id=p_actor_id
  AND (rv.state IN ('running','paused') OR EXISTS(SELECT 1 FROM fusion_review_fees f WHERE f.review_id=rv.id AND f.state='held'))
  AND opc_target_business(p_actor_id,jsonb_build_object('draftId',rv.draft_id))=business ORDER BY rv.id LOOP
  IF item.state IN ('running','paused') THEN
   PERFORM fusion_review_advance(p_actor_id,item.id,jsonb_build_object('round',item.round,'phase',item.phase,'attempt',item.attempt),
    jsonb_build_object('state','incomplete','outcome',jsonb_build_object('kind','source_archived')));
  END IF;
  PERFORM fusion_review_fee_settle(p_actor_id,item.id);
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.fusion_review_archive_reconcile(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Review reads already perform lifecycle/fee maintenance in the host. Do it
-- inside the same RPC for legacy archived rows, including old callers/replays.
ALTER FUNCTION public.fusion_review_read(uuid,uuid) VOLATILE;
DO $$ DECLARE src text;anchor text; BEGIN
 src:=pg_get_functiondef('public.fusion_review_read(uuid,uuid)'::regprocedure);
 IF position('-- 0326 archived review read repair' IN src)=0 THEN
  EXECUTE regexp_replace(src,'\mBEGIN\M',$guard$BEGIN
  -- 0326 archived review read repair
  PERFORM fusion_review_archive_reconcile(p_actor_id,jsonb_build_object('reviewId',p_review_id));$guard$);
 END IF;
 src:=pg_get_functiondef('public.fusion_review_start(uuid,uuid,uuid,uuid,jsonb)'::regprocedure);
 IF position('-- 0326 archived review replay repair' IN src)=0 THEN
  anchor:='PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object(''draftId'',p_draft_id));';
  IF array_length(string_to_array(src,anchor),1)<>2 THEN RAISE EXCEPTION 'OPC_REVIEW_REPLAY_SOURCE_MISMATCH'; END IF;
  EXECUTE replace(src,anchor,$guard$BEGIN
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
  END;$guard$);
 END IF;
END $$;
-- A refused dispatch/rotation must also release the *whole* claimed compare.
-- Catch only the archive refusal before dispatch takes its run/financial locks;
-- stop uses its existing compare -> run -> financial order in this transaction.
-- Returning a refusal commits cleanup; re-raising would roll the refunds back.
DO $$ DECLARE src text;anchor text; BEGIN
 src:=pg_get_functiondef('public.bill2_dispatch(uuid,uuid,uuid,uuid,boolean,jsonb)'::regprocedure);
 IF position('-- 0326 archived compare cleanup' IN src)=0 THEN
  anchor:='PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object(''runId'',p_run_id));';
  IF array_length(string_to_array(src,anchor),1)<>2 THEN RAISE EXCEPTION 'OPC_FUSION_ARCHIVE_CLEANUP_MISMATCH'; END IF;
  src:=replace(src,anchor,$guard$BEGIN
  PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('runId',p_run_id));
 EXCEPTION WHEN raise_exception THEN
  -- 0326 archived compare cleanup
  IF SQLERRM<>'OPC_BUSINESS_ARCHIVED' THEN RAISE; END IF;
  IF EXISTS(SELECT 1 FROM fusion_compares fc JOIN bill2_runs source_run ON source_run.fusion_group_id=fc.group_id
   WHERE source_run.id=p_run_id AND source_run.actor_id=p_actor_id AND fc.actor_id=p_actor_id) THEN
   PERFORM fusion_compare_stop(p_actor_id,(SELECT fc.id FROM fusion_compares fc
    JOIN bill2_runs source_run ON source_run.fusion_group_id=fc.group_id
    WHERE source_run.id=p_run_id AND source_run.actor_id=p_actor_id AND fc.actor_id=p_actor_id),NULL);
  ELSIF EXISTS(SELECT 1 FROM bill2_runs source_run JOIN fusion_billing_groups g ON g.id=source_run.fusion_group_id
   WHERE source_run.id=p_run_id AND source_run.actor_id=p_actor_id AND g.actor_id=p_actor_id AND g.kind='review') THEN
   PERFORM fusion_review_archive_reconcile(p_actor_id,jsonb_build_object('runId',p_run_id));
  ELSE RAISE; END IF;
  RETURN jsonb_build_object('dispatch',false,'archived',true);
 END;$guard$);
  EXECUTE src;
 END IF;
END $$;
-- Stop/cancel, provider receipts, verdicts and settlement retain their permissions.
-- Already spent money can still reconcile; legacy Review reads repair holds above.

-- startCompare invokes this in a fresh transaction after an archive refusal.
-- Request identity also works when begin/replay refused before returning a compare id.
-- It closes admitted runs with *no calls*, which receipt-based recovery cannot find.
CREATE OR REPLACE FUNCTION public.fusion_compare_stop_archived(p_actor_id uuid,p_request_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE source_compare fusion_compares;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO source_compare FROM fusion_compares
  WHERE actor_id=p_actor_id AND request_id=p_request_id FOR UPDATE;
 IF source_compare.id IS NULL THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM opc_businesses b WHERE b.actor_id=p_actor_id AND b.archived_at IS NOT NULL
  AND b.id=opc_target_business(p_actor_id,jsonb_build_object('sessionId',source_compare.session_id))) THEN
  RETURN false;
 END IF;
 PERFORM fusion_compare_stop(p_actor_id,source_compare.id,NULL);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.fusion_compare_stop_archived(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fusion_compare_stop_archived(uuid,uuid) TO service_role;
-- Repair existing inconsistent rows at upgrade time too. No model/provider work;
-- all original reports and financial rows remain, release entries are appended.
DO $$ DECLARE business record; BEGIN
 FOR business IN SELECT b.id,b.actor_id FROM opc_businesses b JOIN profiles p ON p.id=b.actor_id
  WHERE b.archived_at IS NOT NULL AND p.status='active' AND p.is_deleted='false' ORDER BY b.actor_id,b.id LOOP
  PERFORM fusion_review_archive_reconcile(business.actor_id,jsonb_build_object('businessId',business.id));
 END LOOP;
END $$;
COMMIT;
