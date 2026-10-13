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
  INSERT INTO fusion_call_outputs(call_id, run_id, group_id, actor_id, body, body_hash)
    VALUES (c.id, r.id, g.id, p_actor_id, p_body, h) RETURNING * INTO o;
  RETURN jsonb_build_object('callId',c.id,'bodyHash',h,'savedAt',o.saved_at);
END $$;

CREATE OR REPLACE FUNCTION public.fusion_call_output_read(p_actor_id uuid, p_call_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o fusion_call_outputs; s runtime_sessions;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  SELECT * INTO o FROM fusion_call_outputs WHERE call_id=p_call_id AND actor_id=p_actor_id;
  IF o.call_id IS NULL THEN RETURN NULL; END IF;
  SELECT s2.* INTO s FROM runtime_sessions s2 JOIN fusion_billing_groups g ON g.source_session_id=s2.id WHERE g.id=o.group_id;
  IF s.id IS NULL OR s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('callId',o.call_id,'body',o.body,'bodyHash',o.body_hash,'savedAt',o.saved_at);
END $$;

-- Sessionless group runs are invisible to runtime_pending_financial_batch (it joins executions);
-- the recovery cron reads them here and runs the existing per-run receipt recovery and finalize.
CREATE OR REPLACE FUNCTION public.fusion_pending_financial_batch(p_limit integer)
RETURNS TABLE(actor_id uuid, run_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT r.actor_id, r.id FROM bill2_runs r
  WHERE r.fusion_group_id IS NOT NULL AND r.contract_version='bill2.v2'
    AND EXISTS (SELECT 1 FROM bill2_calls c WHERE c.run_id=r.id AND c.settled_at IS NULL)
  ORDER BY r.created_at, r.id LIMIT least(greatest(coalesce(p_limit,50),1),200);
$$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['fusion_group_create(uuid,uuid,text,uuid)','fusion_call_output_save(uuid,uuid,text)',
    'fusion_call_output_read(uuid,uuid)','fusion_pending_financial_batch(integer)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
  -- The sourceless 0234 form is for local fixtures only.
  REVOKE EXECUTE ON FUNCTION public.fusion_group_create(uuid,uuid,text) FROM service_role;
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

-- Deleting a conversation also deletes the Fusion outputs started from it and scrubs those runs with
-- the same per-run steps the cleanup already uses for execution runs. Money facts stay on the runs.
DO $$ DECLARE src text; a text; BEGIN
  src:=pg_get_functiondef('public.content_erasure_confirm(uuid,text,uuid,text)'::regprocedure);
  IF position('-- 0235 fusion outputs' IN src)=0 THEN
    a:=$x$ UPDATE runtime_scope_material m SET request=NULL,content=NULL,content_hash=NULL,erased_at=stamp$x$;
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: content_erasure_confirm'; END IF;
    EXECUTE replace(src,a,$x$ -- 0235 fusion outputs
 FOR row IN SELECT r.id,r.closed FROM bill2_runs r JOIN fusion_billing_groups g ON g.id=r.fusion_group_id
  WHERE g.actor_id=a AND (g.source_session_id=ANY(sessions)
   OR g.source_session_id IN (SELECT d.session_id FROM opc_drafts d WHERE d.actor_id=a AND d.project_id=ANY(projects))) ORDER BY r.id LOOP
  UPDATE bill2_runs SET content_deleted_at=stamp WHERE id=row.id AND content_deleted_at IS NULL;
  IF NOT row.closed THEN PERFORM bill2_cancel(a,row.id); END IF;
  PERFORM bill2_finalize(a,row.id);
  PERFORM account_erasure_scrub_calls(a,row.id);
  PERFORM account_erasure_scrub_run(a,row.id);
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
    a:=$x$total bigint:=(SELECT count(*) FROM opc_data_events WHERE actor_id=p_profile_id);$x$;
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: account_erasure_body_remaining'; END IF;
    EXECUTE replace(src,a,$x$total bigint:=(SELECT count(*) FROM opc_data_events WHERE actor_id=p_profile_id)
  +(SELECT count(*) FROM fusion_call_outputs WHERE actor_id=p_profile_id);$x$);
  END IF;
END $$;
COMMIT;
