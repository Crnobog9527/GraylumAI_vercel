/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- FUSION-REVIEW PR-3a. Number allocated by the controller.
-- Fusion calls do not use runtime sessions (controller 2026-10-14, option A): each model call is an
-- isolated bill2 v2 run in a Fusion billing group (0234). This migration adds what that design needs
-- and the runtime session tables used to provide:
--  * the saved output of each Fusion call (what the user sees), which also decides "saved" for an
--    unjudged call at its recovery deadline (0234 looked at runtime_executions.result);
--  * the source conversation of a group, so deleting that conversation deletes its Fusion outputs and
--    scrubs the group's runs exactly like the existing per-run cleanup;
--  * account erasure coverage and a recovery batch for sessionless group runs.
-- New table reason (AGENTS.md section 5): no existing table stores a model answer that is not a
-- runtime execution; the output must be erasable and readable without a session.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.fusion_billing_groups ADD COLUMN IF NOT EXISTS source_session_id uuid;
CREATE INDEX IF NOT EXISTS fusion_billing_groups_source_idx ON public.fusion_billing_groups(source_session_id)
  WHERE source_session_id IS NOT NULL;

-- Constraint names avoid the generic *_fkey suffix, which the secret scan reads as a key in the fingerprint.
CREATE TABLE IF NOT EXISTS public.fusion_call_outputs (
  call_id uuid CONSTRAINT fusion_call_outputs_pk PRIMARY KEY CONSTRAINT fusion_call_outputs_call_ref REFERENCES public.bill2_calls(id),
  run_id uuid NOT NULL CONSTRAINT fusion_call_outputs_run_ref REFERENCES public.bill2_runs(id),
  group_id uuid NOT NULL CONSTRAINT fusion_call_outputs_group_ref REFERENCES public.fusion_billing_groups(id),
  actor_id uuid NOT NULL CONSTRAINT fusion_call_outputs_actor_ref REFERENCES public.profiles(id),
  body text NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 262144),
  body_hash text NOT NULL CHECK (body_hash ~ '^[a-f0-9]{64}$'),
  saved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fusion_call_outputs_group_idx ON public.fusion_call_outputs(group_id);
CREATE INDEX IF NOT EXISTS fusion_call_outputs_actor_idx ON public.fusion_call_outputs(actor_id);
ALTER TABLE public.fusion_call_outputs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fusion_call_outputs FROM PUBLIC, anon, authenticated, service_role;

-- A group is bound to the conversation it was started from; that conversation must be the caller's
-- and not deleted. The 0234 three-argument form (no source) stays for local fixtures only.
CREATE OR REPLACE FUNCTION public.fusion_group_create(p_actor_id uuid, p_request_id uuid, p_kind text, p_source_session_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE g fusion_billing_groups; s runtime_sessions;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  SELECT * INTO s FROM runtime_sessions WHERE id=p_source_session_id AND actor_id=p_actor_id FOR SHARE;
  IF s.id IS NULL OR s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'FUSION_GROUP_DENIED'; END IF;
  INSERT INTO fusion_billing_groups(actor_id, request_id, kind, source_session_id)
    VALUES (p_actor_id, p_request_id, p_kind, s.id) ON CONFLICT (actor_id, request_id) DO NOTHING;
  SELECT * INTO g FROM fusion_billing_groups WHERE actor_id=p_actor_id AND request_id=p_request_id;
  IF g.kind IS DISTINCT FROM p_kind OR g.source_session_id IS DISTINCT FROM s.id THEN RAISE EXCEPTION 'FUSION_GROUP_CONFLICT'; END IF;
  RETURN g.id;
END $$;

-- Attaching a run takes the source conversation first (share lock), as deletion (update lock) and
-- output saving do: an attach either commits before a deletion, which then finds and cleans the run,
-- or waits and is refused once the conversation is deleted. Otherwise identical to 0234.
CREATE OR REPLACE FUNCTION public.fusion_group_attach(p_actor_id uuid, p_group_id uuid, p_run_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs; g fusion_billing_groups; s runtime_sessions;
BEGIN
  SELECT s2.* INTO s FROM runtime_sessions s2 JOIN fusion_billing_groups g2 ON g2.source_session_id=s2.id
    WHERE g2.id=p_group_id AND g2.actor_id=p_actor_id FOR SHARE OF s2;
  SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
  SELECT * INTO g FROM fusion_billing_groups WHERE id=p_group_id AND actor_id=p_actor_id FOR UPDATE;
  IF r.id IS NULL OR g.id IS NULL OR r.contract_version<>'bill2.v2' THEN RAISE EXCEPTION 'FUSION_GROUP_DENIED'; END IF;
  IF r.fusion_group_id=g.id THEN RETURN; END IF;
  IF g.source_session_id IS NOT NULL AND (s.id IS NULL OR s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FUSION_GROUP_DENIED'; END IF;
  IF r.fusion_group_id IS NOT NULL OR r.closed
    OR EXISTS (SELECT 1 FROM bill2_calls WHERE run_id=r.id) THEN RAISE EXCEPTION 'FUSION_GROUP_DENIED'; END IF;
  PERFORM set_config('graylum.fusion_group_attach', r.id::text, true);
  UPDATE bill2_runs SET fusion_group_id=g.id, version=version+1 WHERE id=r.id;
  PERFORM set_config('graylum.fusion_group_attach', '', true);
END $$;

-- Group admission in one transaction (FUSION-REVIEW PR-3b): the switch, membership permission, model
-- allowlist and group budget are read here, so a concurrent change is decided by what this transaction
-- reads. Idempotent by request: a replay returns the first admission's runs and frozen requests (kept in
-- each run's private input), never re-prices. Each run carries exactly one frozen call:
-- payload.input.fusion = {index, phase, body, call}, with call.requestHash = sha256(body).
-- Only review groups are admitted until FUSION-COMPARE defines its model list.
CREATE OR REPLACE FUNCTION public.fusion_group_admit(p_actor_id uuid, p_request_id uuid, p_kind text,
  p_source_session_id uuid, p_runs jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE g fusion_billing_groups; item jsonb; f jsonb; v jsonb; run jsonb; out jsonb:='[]'; member_level text;
  total numeric:=0; i integer:=0; gid uuid;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  IF p_kind IS DISTINCT FROM 'review' THEN RAISE EXCEPTION 'FUSION_GROUP_INVALID'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fusion-admit:'||p_actor_id::text||':'||p_request_id::text,0));
  SELECT * INTO g FROM fusion_billing_groups WHERE actor_id=p_actor_id AND request_id=p_request_id;
  IF g.id IS NOT NULL THEN
    IF g.kind<>p_kind OR g.source_session_id IS DISTINCT FROM p_source_session_id THEN RAISE EXCEPTION 'FUSION_GROUP_CONFLICT'; END IF;
    -- The replay returns frozen private requests: take the conversation's share lock first and refuse
    -- once it is deleted, so a replay never returns content a committed deletion removed.
    PERFORM 1 FROM runtime_sessions WHERE id=g.source_session_id AND actor_id=p_actor_id
      AND content_deleted_at IS NULL AND erased_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'FUSION_GROUP_DENIED'; END IF;
    RETURN jsonb_build_object('groupId',g.id,'replayed',true,'runs',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'runId',r.id,'fusion',r.payload#>'{input,fusion}') ORDER BY (r.payload#>>'{input,fusion,index}')::int)
      FROM bill2_runs r WHERE r.fusion_group_id=g.id AND r.actor_id=p_actor_id),'[]'));
  END IF;
  IF jsonb_typeof(p_runs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_runs) NOT BETWEEN 1 AND 16 THEN
    RAISE EXCEPTION 'FUSION_GROUP_INVALID'; END IF;
  SELECT value INTO v FROM system_settings WHERE key='fusion_settings';
  IF jsonb_typeof(v)='string' THEN v:=(v#>>'{}')::jsonb; END IF;
  IF v#>>'{review,enabled}' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'FUSION_REVIEW_DISABLED'; END IF;
  -- Paid, consistent, unexpired membership (same facts as reports), then the plan's own Fusion switch.
  PERFORM report_membership_check(p_actor_id);
  SELECT membership_level INTO member_level FROM profiles WHERE id=p_actor_id;
  IF NOT EXISTS(SELECT 1 FROM membership_plans mp WHERE mp.level=member_level AND mp.allow_fusion_review) THEN
    RAISE EXCEPTION 'FUSION_MEMBERSHIP_REQUIRED'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_runs) LOOP
    f:=item#>'{payload,input,fusion}';
    IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR (f->>'index') IS DISTINCT FROM i::text
      OR jsonb_typeof(f->'body') IS DISTINCT FROM 'string' OR jsonb_typeof(f->'call') IS DISTINCT FROM 'object'
      OR f->>'phase' NOT IN ('fusion_review','fusion_summary') OR f#>>'{call,phase}' IS DISTINCT FROM f->>'phase'
      OR f#>>'{call,requestHash}' IS DISTINCT FROM encode(sha256(convert_to(f->>'body','UTF8')),'hex')
      OR jsonb_array_length(item#>'{payload,callPolicy}')<>1 OR item#>>'{payload,limits,maxCalls}' IS DISTINCT FROM '1'
      OR item#>>'{payload,callPolicy,0,modelId}' IS DISTINCT FROM item#>>'{payload,modelId}'
      OR item#>>'{payload,contractVersion}' IS DISTINCT FROM 'bill2.v2' OR item#>'{payload,sessionRef}' IS NOT NULL
    THEN RAISE EXCEPTION 'FUSION_GROUP_INVALID'; END IF;
    -- Administrator allowlist: reviewers for review calls, the summary model for the summary call.
    IF (f->>'phase'='fusion_review' AND NOT coalesce(v#>'{review,reviewerModelIds}','[]') ? (item#>>'{payload,modelId}'))
      OR (f->>'phase'='fusion_summary' AND v#>>'{review,summaryModelId}' IS DISTINCT FROM item#>>'{payload,modelId}')
    THEN RAISE EXCEPTION 'FUSION_MODEL_DENIED'; END IF;
    total:=total+bill2_decimal(item#>'{payload,limits,costUsd}');
    i:=i+1;
  END LOOP;
  IF coalesce(v#>>'{review,maxBudgetUsd}','')='' OR total>bill2_decimal(v#>'{review,maxBudgetUsd}') THEN
    RAISE EXCEPTION 'FUSION_BUDGET_EXCEEDED'; END IF;
  gid:=fusion_group_create(p_actor_id,p_request_id,p_kind,p_source_session_id);
  FOR item IN SELECT value FROM jsonb_array_elements(p_runs) LOOP
    run:=bill2_prepare(p_actor_id,(item->>'requestId')::uuid,item->'payload');
    PERFORM fusion_group_attach(p_actor_id,gid,(run->>'id')::uuid);
    out:=out||jsonb_build_object('runId',run->>'id','fusion',item#>'{payload,input,fusion}');
  END LOOP;
  RETURN jsonb_build_object('groupId',gid,'replayed',false,'runs',out);
END $$;

-- A run admitted through fusion_group_admit carries its frozen call: the group claim must claim exactly
-- that call (phase, request hash, quote), under the run locks it already holds (#947 review).
DO $$ DECLARE src text; a text; BEGIN
  src:=pg_get_functiondef('public.fusion_group_claim(uuid,uuid,text,integer,jsonb)'::regprocedure);
  IF position('{input,fusion,call}' IN src)=0 THEN
    a:=$x$      res:=bill2_claim(p_actor_id, (item->>'runId')::uuid, (item->>'sequence')::int, item->'payload');$x$;
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: fusion_group_claim'; END IF;
    EXECUTE replace(src,a,$x$      IF EXISTS(SELECT 1 FROM bill2_runs br WHERE br.id=(item->>'runId')::uuid
        AND br.payload#>'{input,fusion,call}' IS NOT NULL AND br.payload#>'{input,fusion,call}' IS DISTINCT FROM item->'payload') THEN
        RAISE EXCEPTION 'FUSION_GROUP_CONFLICT'; END IF;
$x$||a);
  END IF;
END $$;

-- Saved output: idempotent for the same body; only for a dispatched call of a grouped run whose
-- source conversation still exists. The call row lock orders this with settlement and erasure.
CREATE OR REPLACE FUNCTION public.fusion_call_output_save(p_actor_id uuid, p_call_id uuid, p_body text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c bill2_calls; r bill2_runs; g fusion_billing_groups; s runtime_sessions; o fusion_call_outputs; h text;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  IF p_body IS NULL OR octet_length(p_body) NOT BETWEEN 1 AND 262144 THEN RAISE EXCEPTION 'FUSION_OUTPUT_INVALID'; END IF;
  -- Lock order as conversation deletion: session first, then the call row.
  SELECT g2.* INTO g FROM fusion_billing_groups g2 JOIN bill2_runs r2 ON r2.fusion_group_id=g2.id
    JOIN bill2_calls c2 ON c2.run_id=r2.id WHERE c2.id=p_call_id AND g2.actor_id=p_actor_id;
  SELECT * INTO s FROM runtime_sessions WHERE id=g.source_session_id FOR SHARE;
  SELECT * INTO c FROM bill2_calls WHERE id=p_call_id FOR UPDATE;
  SELECT * INTO r FROM bill2_runs WHERE id=c.run_id AND actor_id=p_actor_id;
  IF c.id IS NULL OR r.id IS NULL OR g.id IS NULL OR r.fusion_group_id IS DISTINCT FROM g.id
    OR NOT fusion_purpose(c.payload) OR c.dispatched_at IS NULL THEN RAISE EXCEPTION 'FUSION_OUTPUT_DENIED'; END IF;
  IF s.id IS NULL OR s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL OR r.content_deleted_at IS NOT NULL
    OR bill2_erasure_closed(p_actor_id, r.id) THEN RAISE EXCEPTION 'FUSION_OUTPUT_DENIED'; END IF;
  h:=encode(sha256(convert_to(p_body,'UTF8')),'hex');
  SELECT * INTO o FROM fusion_call_outputs WHERE call_id=c.id;
  IF o.call_id IS NOT NULL THEN
    IF o.body_hash<>h THEN RAISE EXCEPTION 'FUSION_OUTPUT_CONFLICT'; END IF;
    RETURN jsonb_build_object('callId',c.id,'bodyHash',h,'savedAt',o.saved_at);
  END IF;
  -- A call already settled or judged (e.g. no_delivery at the recovery deadline) never gains a body later.
  IF c.settled_at IS NOT NULL OR c.fusion_verdict IS NOT NULL THEN RAISE EXCEPTION 'FUSION_OUTPUT_DENIED'; END IF;
  INSERT INTO fusion_call_outputs(call_id, run_id, group_id, actor_id, body, body_hash)
    VALUES (c.id, r.id, g.id, p_actor_id, p_body, h) RETURNING * INTO o;
  RETURN jsonb_build_object('callId',c.id,'bodyHash',h,'savedAt',o.saved_at);
END $$;

-- Reads take the source conversation's share lock first (deletion takes it for update), then read the
-- body afresh: a read either completes before a deletion commits or sees it and returns nothing.
-- The function changed from STABLE to VOLATILE while unmerged; row locks need a volatile function.
DROP FUNCTION IF EXISTS public.fusion_call_output_read(uuid,uuid);
CREATE FUNCTION public.fusion_call_output_read(p_actor_id uuid, p_call_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o fusion_call_outputs; s runtime_sessions;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  SELECT s2.* INTO s FROM runtime_sessions s2 JOIN fusion_billing_groups g ON g.source_session_id=s2.id
    JOIN bill2_runs r ON r.fusion_group_id=g.id JOIN bill2_calls c ON c.run_id=r.id
    WHERE c.id=p_call_id AND g.actor_id=p_actor_id FOR SHARE OF s2;
  IF s.id IS NULL OR s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RETURN NULL; END IF;
  SELECT * INTO o FROM fusion_call_outputs WHERE call_id=p_call_id AND actor_id=p_actor_id;
  IF o.call_id IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('callId',o.call_id,'body',o.body,'bodyHash',o.body_hash,'savedAt',o.saved_at);
END $$;

-- Sessionless group runs are invisible to runtime_pending_financial_batch (it joins executions);
-- the recovery cron reads them here: dispatched calls get the existing receipt recovery and finalize,
-- calls never dispatched by their dispatch deadline are cancelled (hold released, no charge). `recovery`
-- is the immutable original binding of a staging run (same shape as runtime_test_recovery_policy).
-- Paged by (created_at, id) so calls that cannot progress yet (e.g. cost still unknown after their
-- deadline) never starve newer ones; undispatched calls are listed only once their dispatch deadline passed.
-- The return type and signature changed while this migration was unmerged; drop first so a re-run stays valid.
DROP FUNCTION IF EXISTS public.fusion_pending_financial_batch(integer);
DROP FUNCTION IF EXISTS public.fusion_pending_financial_batch(integer,timestamptz,uuid);
CREATE FUNCTION public.fusion_pending_financial_batch(p_limit integer, p_after_created timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL)
RETURNS TABLE(actor_id uuid, run_id uuid, call_id uuid, dispatched boolean, dispatch_deadline timestamptz,
  recovery jsonb, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT r.actor_id, r.id, c.id, c.dispatched_at IS NOT NULL, c.dispatch_deadline,
    CASE WHEN r.payload->>'mode'='staging_test' AND r.test_window_id IS NOT NULL THEN jsonb_build_object(
      'id',r.test_window_id,'callPolicies',r.payload->'callPolicy','creditsPerUsd',r.payload->'rules'->>'creditsPerUsd',
      'multiplier',r.payload->'rules'->>'multiplier','expiresAt',r.deadline) END, c.created_at
  FROM bill2_runs r JOIN bill2_calls c ON c.run_id=r.id
  WHERE r.fusion_group_id IS NOT NULL AND r.contract_version='bill2.v2'
    AND ((c.settled_at IS NULL AND (c.dispatched_at IS NOT NULL OR c.dispatch_deadline<=clock_timestamp()))
      -- A zero-charge verdict can settle before the provider cost arrives (#935 review): keep looking the
      -- cost up for the record, within the existing lookup budget and deadline (bill2_recovery_claim rules).
      OR (c.settled_at IS NOT NULL AND c.dispatched_at IS NOT NULL AND c.selected_cost_usd IS NULL
        AND c.provider_id IS NOT NULL AND c.recovery_attempts<3
        AND clock_timestamp()<=coalesce(c.recovery_deadline,c.created_at+interval '24 hours')))
    AND (p_after_created IS NULL OR (c.created_at, c.id) > (p_after_created, p_after_id))
  ORDER BY c.created_at, c.id LIMIT least(greatest(coalesce(p_limit,50),1),200);
$$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['fusion_group_admit(uuid,uuid,text,uuid,jsonb)','fusion_call_output_save(uuid,uuid,text)',
    'fusion_call_output_read(uuid,uuid)','fusion_pending_financial_batch(integer,timestamptz,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
  -- Admission is the only service-callable way to build a group, so the switch, membership, allowlist,
  -- budget and frozen-call checks cannot be skipped (#947 review). Group creation and attaching stay
  -- internal (fusion_group_admit calls them as owner); the group claim stays callable and checks frozen calls.
  FOREACH f IN ARRAY ARRAY['fusion_group_create(uuid,uuid,text,uuid)','fusion_group_create(uuid,uuid,text)',
    'fusion_group_attach(uuid,uuid,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role', f);
  END LOOP;
END $$;

-- Content deletion ends an unjudged dispatched call as user_stopped (billable at known cost, FUSION-REVIEW
-- §3.3) even when the run was already closed, so a deleted conversation never leaves a hold until the
-- deadline nor turns a delivered result into a refunded no_delivery.
DO $$ DECLARE src text; a text; BEGIN
  src:=pg_get_functiondef('public.bill2_payg_finalize(uuid,uuid)'::regprocedure);
  IF position('OR r.content_deleted_at IS NOT NULL THEN' IN src)=0 THEN
    a:=$x$   ELSIF r.cancel_requested OR r.paused_reason='user_stop' THEN$x$;
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: bill2_payg_finalize stop'; END IF;
    EXECUTE replace(src,a,$x$   ELSIF r.cancel_requested OR r.paused_reason='user_stop' OR r.content_deleted_at IS NOT NULL THEN$x$);
  END IF;
END $$;

-- 0234 decided "saved" for an unjudged call by runtime_executions.result. Sessionless Fusion calls
-- have no execution: the saved Fusion output is the delivered result.
DO $$ DECLARE src text; a text; BEGIN
  src:=pg_get_functiondef('public.bill2_payg_finalize(uuid,uuid)'::regprocedure);
  IF position('fusion_call_outputs' IN src)=0 THEN
    a:=$x$EXISTS(SELECT 1 FROM runtime_executions
      WHERE billing_run_id=r.id AND result IS NOT NULL)$x$;
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: bill2_payg_finalize saved'; END IF;
    EXECUTE replace(src,a,$x$EXISTS(SELECT 1 FROM fusion_call_outputs WHERE call_id=c.id)$x$);
  END IF;
END $$;

-- 0234 lets the host write a verdict without looking at the body. A verdict about a body
-- (usable / format_invalid / revision_invalid) needs the saved Fusion output; no_delivery needs its
-- absence. Outputs are inserted under the same call row lock, so the check is consistent.
DO $$ DECLARE src text; a text; BEGIN
  src:=pg_get_functiondef('public.fusion_call_verdict(uuid,uuid,text)'::regprocedure);
  IF position('fusion_call_outputs' IN src)=0 THEN
    a:=$x$  UPDATE bill2_calls SET fusion_verdict=p_verdict WHERE id=c.id;$x$;
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: fusion_call_verdict'; END IF;
    EXECUTE replace(src,a,$x$  IF (p_verdict='no_delivery')=EXISTS(SELECT 1 FROM fusion_call_outputs WHERE call_id=c.id) THEN
    RAISE EXCEPTION 'FUSION_VERDICT_DENIED'; END IF;
$x$||a);
  END IF;
END $$;

-- Deleting a conversation also deletes the Fusion outputs started from it and scrubs those runs with
-- the same per-run steps the cleanup already uses for execution runs. Money facts stay on the runs.
DO $$ DECLARE src text; a text; BEGIN
  src:=pg_get_functiondef('public.content_erasure_confirm(uuid,text,uuid,text)'::regprocedure);
  IF position('-- 0235 fusion outputs' IN src)=0 THEN
    a:=$x$ UPDATE runtime_scope_material m SET request=NULL,content=NULL,content_hash=NULL,erased_at=stamp$x$;
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: content_erasure_confirm'; END IF;
    EXECUTE replace(src,a,$x$ -- 0235 fusion outputs
 -- Like the session/project locks above, take the Fusion run locks up front with NOWAIT: a concurrent group
 -- claim holds a run and then the profile, so waiting here could deadlock; failing fast lets the caller
 -- (or the deletion sweep) retry once the claim committed (#947 review).
 PERFORM r.id FROM bill2_runs r JOIN fusion_billing_groups g ON g.id=r.fusion_group_id
  WHERE g.actor_id=a AND (g.source_session_id=ANY(sessions)
   OR g.source_session_id IN (SELECT d.session_id FROM opc_drafts d WHERE d.actor_id=a AND d.project_id=ANY(projects)))
  ORDER BY r.id FOR UPDATE OF r NOWAIT;
 FOR row IN SELECT r.id,r.closed FROM bill2_runs r JOIN fusion_billing_groups g ON g.id=r.fusion_group_id
  WHERE g.actor_id=a AND (g.source_session_id=ANY(sessions)
   OR g.source_session_id IN (SELECT d.session_id FROM opc_drafts d WHERE d.actor_id=a AND d.project_id=ANY(projects))) ORDER BY r.id LOOP
  UPDATE bill2_runs SET content_deleted_at=stamp WHERE id=row.id AND content_deleted_at IS NULL;
  IF NOT row.closed THEN PERFORM bill2_cancel(a,row.id); END IF;
  PERFORM bill2_finalize(a,row.id);
  -- Anything a scrub could not clear yet is counted (review_required), and the recovery cron
  -- scrubs a content-deleted run again once it settles (PR-3b).
  financial:=account_erasure_scrub_calls(a,row.id);
  remaining:=remaining+coalesce((financial->>'remaining')::bigint,0);
  financial:=account_erasure_scrub_run(a,row.id);
  remaining:=remaining+coalesce((financial->>'remaining')::bigint,0);
  financial:=account_erasure_scrub_receipts(a,row.id,100);
  remaining:=remaining+coalesce((financial->>'remaining')::bigint,0);
 END LOOP;
 DELETE FROM fusion_call_outputs o USING fusion_billing_groups g
  WHERE o.group_id=g.id AND g.actor_id=a AND (g.source_session_id=ANY(sessions)
   OR g.source_session_id IN (SELECT d.session_id FROM opc_drafts d WHERE d.actor_id=a AND d.project_id=ANY(projects)));
$x$||a);
  END IF;
END $$;

-- The one-step conversation delete may skip the full cleanup only when nothing outside the
-- conversation holds a copy; Fusion outputs started from it are such a copy.
DO $$ DECLARE src text; a text; BEGIN
  src:=pg_get_functiondef('public.content_erasure_mark_session(uuid,uuid)'::regprocedure);
  IF position('fusion_billing_groups' IN src)=0 THEN
    a:=$x$  AND jsonb_array_length(scope->'projects')=0 AND jsonb_array_length(scope->'versions')=0$x$;
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: content_erasure_mark_session'; END IF;
    EXECUTE replace(src,a,$x$  AND NOT EXISTS(SELECT 1 FROM fusion_billing_groups fg WHERE fg.source_session_id=target)
$x$||a);
  END IF;
END $$;

-- Account erasure: Fusion outputs are account content, removed and counted like other bodies.
DO $$ DECLARE src text; a text; BEGIN
  src:=pg_get_functiondef('public.account_erasure_scrub_content(uuid)'::regprocedure);
  IF position('fusion_call_outputs' IN src)=0 THEN
    a:=$x$  RETURN counts;$x$;
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: account_erasure_scrub_content'; END IF;
    EXECUTE replace(src,a,$x$  DELETE FROM fusion_call_outputs WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts := counts || jsonb_build_object('fusion_call_outputs', n);
$x$||a);
  END IF;
  src:=pg_get_functiondef('public.account_erasure_body_remaining(uuid)'::regprocedure);
  IF position('fusion_call_outputs' IN src)=0 THEN
    -- Anchor without the closing semicolon, so it holds with or without 0232's runtime_session_names term.
    a:=$x$total bigint:=(SELECT count(*) FROM opc_data_events WHERE actor_id=p_profile_id)$x$;
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: account_erasure_body_remaining'; END IF;
    EXECUTE replace(src,a,a||$x$
  +(SELECT count(*) FROM fusion_call_outputs WHERE actor_id=p_profile_id)$x$);
  END IF;
END $$;
COMMIT;
