-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PUBLISH-MONITOR PR-4b (docs/launch/tasks/PUBLISH-MONITOR.md §6, §8): billed TikHub reads outside a chat turn. Number
-- 0290 assigned by the controller. Each refresh of a TikHub connection bills on its own sessionless PAYG v2 run (the
-- FUSION-REVIEW pattern: a fresh BILL2 draft scope, no new scope kind). BILL2 only learns to accept a run that freezes
-- tool routes and no model (Owner-approved, two marker-guarded edits below). This migration also adds the ledger that makes a re-read after an interruption free for the user: every supplier request of a refresh is
-- recorded with its BILL2 call and, once answered, its normalized result, so a re-run re-applies the stored result
-- instead of calling and charging again (plan §8: the same key never freezes or charges twice).
BEGIN;
SET LOCAL lock_timeout='5s';

-- The runs that bill one refresh of one connection. A refresh normally has one; a re-run after a killed process first
-- closes the left-open run (its unanswered calls settle at zero for the user) and opens a new one. The frozen tool
-- policies are kept so a later process can build those zero receipts. Ids and prices only, no content, and deliberately
-- not tied to the connection row: an open run must still be found and closed after the connection or account is gone.
CREATE TABLE IF NOT EXISTS public.social_billed_runs(
 run_id uuid PRIMARY KEY,
 connection_id uuid NOT NULL,
 refresh_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 policies jsonb NOT NULL CHECK(jsonb_typeof(policies)='array' AND pg_column_size(policies)<=65536),
 closed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS social_billed_runs_one_open
 ON public.social_billed_runs(connection_id,refresh_id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS social_billed_runs_open ON public.social_billed_runs(created_at) WHERE closed_at IS NULL;
ALTER TABLE public.social_billed_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.social_billed_runs FROM PUBLIC,anon,authenticated,service_role;

-- "余额不足，未更新" (plan §6): a background read found the balance too low; nothing was held or charged.
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.social_connections'::regclass
  AND conname='social_connections_refresh_check')
  AND position('insufficient_credits' IN pg_get_constraintdef((SELECT oid FROM pg_constraint
   WHERE conrelid='public.social_connections'::regclass AND conname='social_connections_refresh_check')))=0 THEN
  ALTER TABLE public.social_connections DROP CONSTRAINT social_connections_refresh_check;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.social_connections'::regclass
  AND conname='social_connections_refresh_check') THEN
  ALTER TABLE public.social_connections ADD CONSTRAINT social_connections_refresh_check
   CHECK((refresh_state IS NULL OR refresh_state IN ('ok','partial','not_fetched','no_posts_yet','reauth_suggested',
     'failed','entitlement','insufficient_credits'))
    AND (refresh_error IS NULL OR refresh_error ~ '^[A-Z0-9_]{1,64}$')
    AND empty_streak BETWEEN 0 AND 1000 AND pages_used BETWEEN 0 AND 1000);
 END IF;
END $$;

-- Owner 2026-10-17: "同意 PUBLISH-MONITOR 4b 在 0290 里为发布监控的纯工具计费单放宽 BILL2 模型检查（仅限带标记的运行单）".
-- A publish-monitor read run bills only TikHub calls and freezes no model. BILL2 requires the run's top-level model to
-- be an active ai_models row that also appears in its call policy; for this one run shape only, the top-level model is a
-- fixed placeholder id. Recognised only by all of: v2 contract, the publishMonitor input marker the server writes, the
-- placeholder id, and tool routes only. Every other check of both functions is unchanged.
CREATE OR REPLACE FUNCTION public.publish_monitor_tool_only_run(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce(p->>'contractVersion'='bill2.v2' AND jsonb_typeof(p->'input'->'publishMonitor')='object'
  AND p->>'modelId'=bill2_tool_model_id('publish-monitor:read-run')::text
  AND jsonb_typeof(p->'callPolicy')='array' AND jsonb_array_length(p->'callPolicy') BETWEEN 1 AND 32
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'callPolicy') x WHERE x->>'protocol' IS DISTINCT FROM 'research-tool-v1'),
  false)
$$;

DO $$ DECLARE src text; a text; BEGIN
 src:=pg_get_functiondef('public.bill2_prepare(uuid,uuid,jsonb)'::regprocedure);
 a:=$x$ IF NOT EXISTS(SELECT 1 FROM ai_models WHERE id=(p_payload->>'modelId')::uuid AND is_active='true') THEN RAISE EXCEPTION 'BILL2_MODEL_DENIED';END IF;$x$;
 IF position('-- 0290 tool-only run' IN src)=0 THEN
  IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'PUBLISH_MONITOR_BILLING_SOURCE_MISMATCH: bill2_prepare'; END IF;
  EXECUTE replace(src,a,$x$ -- 0290 tool-only run
 IF NOT EXISTS(SELECT 1 FROM ai_models WHERE id=(p_payload->>'modelId')::uuid AND is_active='true')
  AND NOT publish_monitor_tool_only_run(p_payload) THEN RAISE EXCEPTION 'BILL2_MODEL_DENIED';END IF;$x$);
 END IF;
 src:=pg_get_functiondef('public.runtime_direct_billing_allowed_before_opc(uuid,jsonb,uuid)'::regprocedure);
 a:=$x$ IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(policy) x WHERE x->>'modelId'=p->>'modelId') THEN RAISE EXCEPTION 'BILL2_MODEL_DENIED';END IF;$x$;
 IF position('-- 0290 tool-only run' IN src)=0 THEN
  IF array_length(string_to_array(src,a),1)<>2 THEN
   RAISE EXCEPTION 'PUBLISH_MONITOR_BILLING_SOURCE_MISMATCH: runtime_direct_billing_allowed_before_opc'; END IF;
  EXECUTE replace(src,a,$x$ -- 0290 tool-only run
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(policy) x WHERE x->>'modelId'=p->>'modelId')
  AND NOT publish_monitor_tool_only_run(p) THEN RAISE EXCEPTION 'BILL2_MODEL_DENIED';END IF;$x$);
 END IF;
END $$;

-- One row per supplier request attempt of a refresh. request_key is the request identity (sha256 of vendor, route and
-- exact body); a refresh may hold several attempts of one key only when an earlier attempt ended without a usable
-- answer (state 'abandoned': its BILL2 call was settled at zero for the user). Rows go with their connection.
CREATE TABLE IF NOT EXISTS public.social_billed_reads(
 id uuid PRIMARY KEY,
 actor_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 refresh_id uuid NOT NULL,
 request_key text NOT NULL CHECK(request_key ~ '^[0-9a-f]{64}$'),
 -- The frozen route of the request (tikhub:<path>), so a zero receipt for an unanswered call names the right route.
 model text NOT NULL CHECK(model ~ '^tikhub:/[A-Za-z0-9_/.-]{1,200}$'),
 run_id uuid NOT NULL,
 call_id uuid,
 state text NOT NULL CHECK(state IN ('opened','dispatched','answered','cancelled','abandoned')),
 token uuid NOT NULL,
 result jsonb CHECK(result IS NULL OR (jsonb_typeof(result)='object' AND pg_column_size(result)<=262144)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(connection_id,actor_id) REFERENCES public.social_connections(id,actor_id) ON DELETE CASCADE,
 CHECK(state<>'answered' OR result IS NOT NULL)
);
-- At most one live attempt per key and refresh.
CREATE UNIQUE INDEX IF NOT EXISTS social_billed_reads_live
 ON public.social_billed_reads(connection_id,refresh_id,request_key) WHERE state IN ('opened','dispatched','answered');
CREATE UNIQUE INDEX IF NOT EXISTS social_billed_reads_call ON public.social_billed_reads(call_id) WHERE call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS social_billed_reads_retention ON public.social_billed_reads(created_at);
ALTER TABLE public.social_billed_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.social_billed_reads FROM PUBLIC,anon,authenticated,service_role;

-- The open run of the current refresh, if any ({runId, policies}); with p_run_id, binds that new run when none is open.
-- NULL when the claim is no longer current.
CREATE OR REPLACE FUNCTION public.publish_monitor_billed_run(p_connection_id uuid,p_lease uuid,p_refresh_id uuid,
 p_run_id uuid,p_policies jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c social_connections; b social_billed_runs;
BEGIN
 c:=publish_monitor_refresh_current(p_connection_id,p_lease,p_refresh_id);
 IF c.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO b FROM social_billed_runs WHERE connection_id=c.id AND refresh_id=p_refresh_id AND closed_at IS NULL FOR UPDATE;
 IF b.run_id IS NULL AND p_run_id IS NOT NULL THEN
  IF jsonb_typeof(p_policies) IS DISTINCT FROM 'array'
   OR NOT EXISTS(SELECT 1 FROM bill2_runs WHERE id=p_run_id AND actor_id=c.actor_id) THEN
   RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  INSERT INTO social_billed_runs(run_id,connection_id,refresh_id,actor_id,policies)
  VALUES(p_run_id,c.id,p_refresh_id,c.actor_id,p_policies) RETURNING * INTO b;
 END IF;
 RETURN CASE WHEN b.run_id IS NULL THEN jsonb_build_object('runId',NULL)
  ELSE jsonb_build_object('runId',b.run_id,'policies',b.policies) END;
END $$;

-- Calls of a run that were sent but never got a stored answer (a killed process): they are settled at zero for the
-- user before the run closes. Their ledger attempts are marked abandoned by the same step.
CREATE OR REPLACE FUNCTION public.publish_monitor_billed_unanswered(p_run_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('operationId',r.id,'callId',r.call_id,'state',r.state,'model',r.model)
  ORDER BY r.created_at),
  '[]'::jsonb)
 FROM social_billed_reads r WHERE r.run_id=p_run_id AND r.state IN ('opened','dispatched') AND r.call_id IS NOT NULL
$$;

-- What a re-run finds for one request of this refresh: the live attempt, if any (its state, call and stored answer).
CREATE OR REPLACE FUNCTION public.publish_monitor_billed_lookup(p_connection_id uuid,p_lease uuid,p_refresh_id uuid,
 p_request_key text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c social_connections; r social_billed_reads;
BEGIN
 c:=publish_monitor_refresh_current(p_connection_id,p_lease,p_refresh_id);
 IF c.id IS NULL THEN RETURN jsonb_build_object('stale',true); END IF;
 SELECT * INTO r FROM social_billed_reads WHERE connection_id=c.id AND refresh_id=p_refresh_id AND request_key=p_request_key
  AND state IN ('opened','dispatched','answered');
 IF r.id IS NULL THEN RETURN jsonb_build_object('stale',false,'found',false); END IF;
 RETURN jsonb_build_object('stale',false,'found',true,'operationId',r.id,'state',r.state,'callId',r.call_id,'runId',r.run_id,
  'result',r.result);
END $$;

-- Evidence steps (the RESEARCH-TOOLS EvidencePort contract, research/runtime/subcall.ts), bound to the current claim:
-- open (reserve, before any send) → link (BILL2 call) → dispatch (right before the send) → finish (store the answer).
CREATE OR REPLACE FUNCTION public.publish_monitor_billed_step(p_connection_id uuid,p_lease uuid,p_refresh_id uuid,
 p_operation_id uuid,p_step text,p_request_key text,p_model text,p_token uuid,p_call_id uuid,p_state text,p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c social_connections; r social_billed_reads; n integer;
BEGIN
 IF p_operation_id IS NULL OR p_step NOT IN ('open','link','dispatch','finish','cancel','abandon') THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 c:=publish_monitor_refresh_current(p_connection_id,p_lease,p_refresh_id);
 -- A stale claim may still finish what it already sent (the answer is kept for the next run), nothing else.
 IF c.id IS NULL AND p_step NOT IN ('finish','abandon') THEN RETURN jsonb_build_object('ok',false); END IF;
 IF p_step='open' THEN
  IF p_token IS NULL OR p_request_key IS NULL OR NOT EXISTS(SELECT 1 FROM social_billed_runs
    WHERE connection_id=c.id AND refresh_id=p_refresh_id AND closed_at IS NULL) THEN
   RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  INSERT INTO social_billed_reads(id,actor_id,connection_id,refresh_id,request_key,model,run_id,state,token)
  VALUES(p_operation_id,c.actor_id,c.id,p_refresh_id,p_request_key,p_model,
   (SELECT run_id FROM social_billed_runs WHERE connection_id=c.id AND refresh_id=p_refresh_id AND closed_at IS NULL),
   'opened',p_token)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN jsonb_build_object('ok',n=1);
 END IF;
 SELECT * INTO r FROM social_billed_reads WHERE id=p_operation_id FOR UPDATE;
 IF r.id IS NULL OR (c.id IS NOT NULL AND r.connection_id<>c.id) THEN RETURN jsonb_build_object('ok',false); END IF;
 IF p_step='link' THEN
  IF p_call_id IS NULL OR r.state<>'opened' THEN RETURN jsonb_build_object('ok',false); END IF;
  UPDATE social_billed_reads SET call_id=p_call_id,updated_at=clock_timestamp() WHERE id=r.id;
 ELSIF p_step='dispatch' THEN
  IF r.state<>'opened' OR r.token IS DISTINCT FROM p_token OR r.call_id IS NULL THEN RETURN jsonb_build_object('ok',false); END IF;
  UPDATE social_billed_reads SET state='dispatched',updated_at=clock_timestamp() WHERE id=r.id;
 ELSIF p_step='finish' THEN
  IF r.state NOT IN ('opened','dispatched') OR r.token IS DISTINCT FROM p_token THEN RETURN jsonb_build_object('ok',false); END IF;
  -- Only a usable answer is kept for re-use; a failed or unknown one leaves nothing to re-apply.
  UPDATE social_billed_reads SET state=CASE WHEN p_state='succeeded' AND p_result IS NOT NULL THEN 'answered' ELSE 'abandoned' END,
   result=CASE WHEN p_state='succeeded' THEN p_result END,updated_at=clock_timestamp() WHERE id=r.id;
 ELSIF p_step='cancel' THEN
  IF r.state<>'opened' THEN RETURN jsonb_build_object('ok',false); END IF;
  UPDATE social_billed_reads SET state='cancelled',updated_at=clock_timestamp() WHERE id=r.id;
 ELSE
  -- A re-run settled this attempt's BILL2 call at zero for the user (no stored answer): free the key for a new attempt.
  IF r.state NOT IN ('opened','dispatched') THEN RETURN jsonb_build_object('ok',false); END IF;
  UPDATE social_billed_reads SET state='abandoned',updated_at=clock_timestamp() WHERE id=r.id;
 END IF;
 RETURN jsonb_build_object('ok',true);
END $$;

-- Marks a run closed after the caller closed and finalized it in BILL2; idempotent.
CREATE OR REPLACE FUNCTION public.publish_monitor_billed_closed(p_run_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 UPDATE social_billed_runs SET closed_at=clock_timestamp() WHERE run_id=p_run_id AND closed_at IS NULL
$$;

-- Runs still open whose refresh can no longer be running: its connection is gone, its lease expired an hour ago, or it
-- has moved on to another refresh. The daily job closes and finalizes them so no hold stays frozen.
CREATE OR REPLACE FUNCTION public.publish_monitor_billed_orphans(p_limit integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('connectionId',b.connection_id,'actorId',b.actor_id,'runId',b.run_id,
  'policies',b.policies)),'[]'::jsonb)
 FROM (SELECT b.* FROM social_billed_runs b LEFT JOIN social_connections c ON c.id=b.connection_id
  WHERE b.closed_at IS NULL AND (c.id IS NULL OR c.refresh_id IS DISTINCT FROM b.refresh_id
   OR c.lease_expires_at IS NULL OR c.lease_expires_at<clock_timestamp()-interval '1 hour')
  ORDER BY b.created_at LIMIT LEAST(GREATEST(p_limit,1),200)) b
$$;

-- A background read that found the balance too low (plan §6 "余额不足，未更新"): nothing was held or charged; old data
-- stays, the connection is done for today, and the next daily run tries again.
CREATE OR REPLACE FUNCTION public.publish_monitor_refresh_insufficient(p_connection_id uuid,p_lease uuid,p_refresh_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c social_connections;
BEGIN
 c:=publish_monitor_refresh_current(p_connection_id,p_lease,p_refresh_id);
 IF c.id IS NULL THEN RETURN false; END IF;
 UPDATE social_connections SET refresh_day=(clock_timestamp() AT TIME ZONE 'UTC')::date,refresh_state='insufficient_credits',
  refresh_error=NULL,refresh_id=NULL,refresh_cursor=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
 WHERE id=c.id;
 RETURN true;
END $$;

-- Ledger retention: a refresh is settled within a day; answers are kept a week for review, then removed.
CREATE OR REPLACE FUNCTION public.publish_monitor_billed_prune(p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
 DELETE FROM social_billed_reads WHERE id IN (SELECT id FROM social_billed_reads
  WHERE created_at<clock_timestamp()-interval '7 days' ORDER BY created_at LIMIT LEAST(GREATEST(p_limit,1),50000));
 GET DIAGNOSTICS n=ROW_COUNT;
 DELETE FROM social_billed_runs WHERE closed_at<clock_timestamp()-interval '7 days';
 RETURN n;
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('publish_monitor_billed_run','publish_monitor_billed_lookup',
   'publish_monitor_billed_step','publish_monitor_billed_closed','publish_monitor_billed_orphans',
   'publish_monitor_billed_unanswered',
   'publish_monitor_billed_prune','publish_monitor_refresh_insufficient','publish_monitor_tool_only_run') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  IF split_part(f::text,'(',1)<>'publish_monitor_tool_only_run' THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f); END IF;
 END LOOP;
END $$;
COMMIT;
