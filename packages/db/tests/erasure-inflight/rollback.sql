-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Only before new recovery facts. Stop host/cron writers and drain in-flight requests first.
-- Never undo terminal money, restore content or reopen accounts; otherwise forward-fix.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM account_erasure_requests WHERE stage='billing_pending')
 OR EXISTS(SELECT 1 FROM runtime_executions e JOIN runtime_sessions s ON s.id=e.session_id
  JOIN account_erasure_requests a ON a.profile_id=e.actor_id
  WHERE e.state='cost_pending' AND s.active_execution IS DISTINCT FROM e.id) THEN
  RAISE EXCEPTION 'ERASURE_INFLIGHT_ROLLBACK_REQUIRES_FORWARD_FIX';
 END IF;
END $$;
DROP FUNCTION IF EXISTS public.account_erasure_financial_batch(integer,uuid,uuid);
CREATE OR REPLACE FUNCTION public.bill2_read(p_actor_id uuid, p_run_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;erasing boolean;BEGIN SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id;
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 erasing:=bill2_erasure_closed(p_actor_id,r.pre_deduct_id);
 IF NOT erasing THEN PERFORM bill2_actor(p_actor_id);END IF;
 RETURN bill2_erasure_view(r,erasing)||jsonb_build_object('calls',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'sequence',sequence,'state',state,'providerId',provider_id,'costUsd',selected_cost_usd::text,'recoveryAttempts',recovery_attempts) ORDER BY sequence),'[]') FROM bill2_calls WHERE run_id=r.id));END $function$;

CREATE OR REPLACE FUNCTION public.account_erasure_note_error(p_profile_id uuid, p_code text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.account_erasure_requests
  SET last_error_code = p_code, retry_count = retry_count + 1, stage_updated_at = clock_timestamp()
  WHERE profile_id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_REQUEST_MISSING' USING ERRCODE = 'P0002';
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.runtime_financial_recovery(p_actor_id uuid, p_execution_id uuid, p_finish boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE e runtime_executions;s runtime_sessions;b bill2_runs;v jsonb;erasing boolean;terminal text;
BEGIN
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id;
 IF e.id IS NULL THEN RAISE EXCEPTION 'RUNTIME_EXECUTION_DENIED';END IF;
 SELECT * INTO s FROM runtime_sessions WHERE id=e.session_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO b FROM bill2_runs WHERE id=e.billing_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF s.id IS NULL OR b.id IS NULL OR b.session_ref IS DISTINCT FROM e.session_id THEN RAISE EXCEPTION 'RUNTIME_BINDING_DENIED';END IF;
 erasing:=bill2_erasure_closed(p_actor_id,b.pre_deduct_id);
 IF NOT erasing AND e.result IS NULL AND runtime_history_available(e.id) AND e.state NOT IN ('cancelled','cost_pending')
 AND NOT EXISTS(SELECT 1 FROM runtime_test_windows w WHERE w.id=b.test_window_id
  AND (NOT w.enabled OR clock_timestamp()>=w.expires_at OR NOT(p_actor_id=ANY(w.actor_ids)))) THEN
  RAISE EXCEPTION 'RUNTIME_EXECUTION_STILL_ALLOWED';
 END IF;
 IF p_finish THEN
  -- A winning financial outcome is authoritative even after execution content is gone.
  IF NOT erasing THEN
   IF e.result IS NOT NULL THEN v:=bill2_close(p_actor_id,b.id,'delivered',e.result);
   ELSE v:=bill2_cancel(p_actor_id,b.id);END IF;
  ELSIF b.state NOT IN ('settled','refunded') THEN
   IF NOT b.closed OR b.outcome IS NULL OR b.outcome='unknown' THEN
    IF e.result IS NOT NULL THEN v:=bill2_close(p_actor_id,b.id,'delivered',e.result);
    ELSE v:=bill2_cancel(p_actor_id,b.id);END IF;
   END IF;
  END IF;
  v:=bill2_finalize(p_actor_id,b.id);
  IF v->>'state' IN ('settled','refunded') THEN
   terminal:=CASE WHEN NOT erasing THEN CASE WHEN e.result IS NULL THEN 'cancelled' ELSE 'completed' END
     WHEN v->>'state'='settled' AND v->>'outcome'='delivered' THEN 'completed' ELSE 'cancelled' END;
   -- Already-erased terminal rows remain immutable; no redundant UPDATE or content write.
   IF e.state IS DISTINCT FROM terminal THEN
    UPDATE runtime_executions SET state=terminal WHERE id=e.id RETURNING * INTO e;
   END IF;
   UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;
  ELSE
   UPDATE runtime_executions SET state='cost_pending' WHERE id=e.id RETURNING * INTO e;
  END IF;
 ELSE v:=bill2_public(b);END IF;
 IF erasing THEN v:=(v-'scope')||'{"accountClosed":true}'::jsonb;END IF;
 RETURN jsonb_build_object('executionId',e.id,'runId',b.id,'state',e.state,'billing',v);
END $function$;

CREATE OR REPLACE FUNCTION public.bill2_revoke_unstarted_dispatch(p_actor_id uuid, p_run_id uuid, p_call_id uuid, p_token uuid, p_request_hash text, p_inspect boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;eligible boolean;erasing boolean;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 erasing:=bill2_erasure_closed(p_actor_id,r.pre_deduct_id);
 IF NOT erasing THEN PERFORM bill2_actor(p_actor_id);END IF;
 IF NOT erasing AND NOT coalesce(bill2_scope_allowed(p_actor_id,r.scope),false) THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM bill2_calls WHERE id=p_call_id AND run_id=r.id FOR UPDATE;
 IF c.id IS NULL OR p_token IS NULL OR c.token IS DISTINCT FROM p_token
  OR p_request_hash IS NULL OR c.payload->>'requestHash' IS DISTINCT FROM p_request_hash
  OR c.provider<>'openrouter' OR c.payload->>'protocol' IS DISTINCT FROM 'openrouter-chat-v1'
 THEN RAISE EXCEPTION 'BILL2_UNSTARTED_DISPATCH_DENIED' USING ERRCODE='42501';END IF;
 -- Retain the original token for exact idempotent readback. Cancelled state
 -- permanently prevents rotate/dispatch; bill2_record rejects NULL dispatch.
 IF c.dispatch_revoked_at IS NOT NULL THEN RETURN jsonb_build_object('revoked',true,'eligible',false);END IF;
 eligible:=NOT r.conflict AND c.state='dispatched' AND c.dispatched_at IS NOT NULL
  AND c.provider_id IS NULL AND c.selected_cost_usd IS NULL
  AND NOT EXISTS(SELECT 1 FROM bill2_receipts WHERE call_id=c.id)
  AND NOT EXISTS(SELECT 1 FROM bill2_provider_ids WHERE call_id=c.id);
 IF p_inspect THEN RETURN jsonb_build_object('revoked',false,'eligible',eligible);END IF;
 IF NOT eligible THEN RAISE EXCEPTION 'BILL2_UNSTARTED_DISPATCH_DENIED' USING ERRCODE='42501';END IF;
 -- The dispatch timestamp represented a permission grant, not observed HTTP.
 -- Preserve it before clearing the existing possible-dispatch accounting flag.
 UPDATE bill2_calls SET dispatch_granted_at=dispatched_at,dispatch_revoked_at=clock_timestamp(),dispatched_at=NULL,state='cancelled' WHERE id=c.id;
 PERFORM bill2_cancel(p_actor_id,r.id);
 PERFORM bill2_finalize(p_actor_id,r.id);
 RETURN jsonb_build_object('revoked',true,'eligible',false);
END $function$;

CREATE OR REPLACE FUNCTION public.runtime_receipt_saved(p_actor_id uuid, p_execution_id uuid, p_run_id uuid, p_call_id uuid, p_evidence jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM runtime_executions e JOIN bill2_runs r ON r.id=e.billing_run_id
  JOIN bill2_calls c ON c.run_id=r.id WHERE e.id=p_execution_id AND e.actor_id=p_actor_id
  AND r.actor_id=p_actor_id AND r.id=p_run_id AND r.session_ref=e.session_id AND c.id=p_call_id)
 THEN RAISE EXCEPTION 'RUNTIME_BINDING_DENIED';END IF;
 RETURN EXISTS(SELECT 1 FROM bill2_receipts WHERE call_id=p_call_id AND payload=p_evidence);
END $function$;

COMMIT;
