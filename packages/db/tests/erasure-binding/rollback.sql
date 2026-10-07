-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
BEGIN;
LOCK TABLE public.bill2_runs IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM bill2_runs WHERE erased_session_id IS NOT NULL) THEN
  RAISE EXCEPTION 'ERASURE_BINDING_ROLLBACK_REQUIRES_FORWARD_FIX';
 END IF;
END $$;
DROP FUNCTION public.account_erasure_detach_runtime(uuid,uuid);
CREATE OR REPLACE FUNCTION public.runtime_binding_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.session_ref IS NOT DISTINCT FROM OLD.session_ref THEN RETURN NEW;END IF;
 IF OLD.session_ref IS NOT NULL OR NEW.session_ref IS NULL OR OLD.state<>'prepared'
 OR EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=OLD.id)
 OR NOT EXISTS(SELECT 1 FROM runtime_executions e JOIN runtime_sessions s ON s.id=e.session_id
  WHERE e.billing_run_id=OLD.id AND e.session_id=NEW.session_ref AND e.actor_id=OLD.actor_id AND s.scope=OLD.scope)
 THEN RAISE EXCEPTION 'RUNTIME_IMMUTABLE_BINDING';END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS runtime_binding_guard ON bill2_runs;
CREATE TRIGGER runtime_binding_guard BEFORE UPDATE OF session_ref ON bill2_runs FOR EACH ROW EXECUTE FUNCTION runtime_binding_guard();
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
 RETURN EXISTS(SELECT 1 FROM bill2_receipts WHERE call_id=p_call_id AND payload_hash=encode(sha256(convert_to(p_evidence::text,'utf8')),'hex'));
END $function$;
ALTER TABLE public.bill2_runs DROP COLUMN erased_session_id;
ALTER TABLE public.bill2_runs DROP COLUMN erased_execution_id;
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
 erasing:=bill2_erasure_closed(p_actor_id,coalesce(b.pre_deduct_id,b.id));
 IF NOT erasing AND b.paused_reason='user_stop' AND NOT b.cancel_requested AND e.result IS NULL AND runtime_history_available(e.id) THEN
  -- Only the receipt reconstruction host can decide whether stopped content is usable.
  RETURN jsonb_build_object('executionId',e.id,'runId',b.id,'state','cost_pending','billing',bill2_public(b));
 END IF;
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
   IF erasing THEN
    UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;
   END IF;
  END IF;
 ELSE v:=bill2_public(b);END IF;
 IF erasing THEN v:=(v-'scope')||'{"accountClosed":true}'::jsonb;END IF;
 RETURN jsonb_build_object('executionId',e.id,'runId',b.id,'state',e.state,'billing',v);
END $function$;
COMMIT;
