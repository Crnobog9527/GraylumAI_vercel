-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE: retain original financial identity while detaching erased terminal Runtime content.
-- No automatic caller, no content deletion, no new financial authority.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.runtime_binding_guard()'::regprocedure) NOT IN ('e5826ceda5e9347116422f1af5b248ff','4dab7ca2b071ee719cc24e6cd44557de')
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.runtime_receipt_saved(uuid,uuid,uuid,uuid,jsonb)'::regprocedure) NOT IN ('88275eb3e676e1f33184c1140ba5ac7c','9d4c112984a46c75ca16950be247e4e1')
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.runtime_financial_recovery(uuid,uuid,boolean)'::regprocedure) NOT IN ('e8124796fc9d42da1911a69078b16d53','50a4975992343164d1addfee424a1886') THEN RAISE EXCEPTION 'ERASURE_BINDING_SOURCE_MISMATCH'; END IF;
END $$;
ALTER TABLE public.bill2_runs ADD COLUMN IF NOT EXISTS erased_session_id uuid;
ALTER TABLE public.bill2_runs ADD COLUMN IF NOT EXISTS erased_execution_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS bill2_runs_erased_execution_id_key
 ON public.bill2_runs(erased_execution_id) WHERE erased_execution_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.runtime_binding_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.erased_session_id IS NOT NULL OR NEW.erased_execution_id IS NOT NULL THEN
   RAISE EXCEPTION 'RUNTIME_IMMUTABLE_BINDING';
  END IF;
  RETURN NEW;
 END IF;
 IF OLD.erased_session_id IS NOT NULL OR OLD.erased_execution_id IS NOT NULL THEN
  IF NEW.erased_session_id IS DISTINCT FROM OLD.erased_session_id
   OR NEW.erased_execution_id IS DISTINCT FROM OLD.erased_execution_id
   OR NEW.session_ref IS NOT NULL OR NEW.actor_id IS DISTINCT FROM OLD.actor_id THEN
   RAISE EXCEPTION 'RUNTIME_IMMUTABLE_BINDING';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.erased_session_id IS NOT NULL OR NEW.erased_execution_id IS NOT NULL THEN
  IF current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
   OR OLD.session_ref IS NULL OR NEW.session_ref IS NOT NULL
   OR NEW.erased_session_id IS DISTINCT FROM OLD.session_ref
   OR NOT OLD.closed OR OLD.state NOT IN ('settled','refunded') OR OLD.conflict
   OR OLD.content_erased_at IS NULL
   OR NOT coalesce(bill2_erasure_closed(OLD.actor_id,coalesce(OLD.pre_deduct_id,OLD.id)),false)
   OR (to_jsonb(NEW)-ARRAY['session_ref','erased_session_id','erased_execution_id']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['session_ref','erased_session_id','erased_execution_id'])
   OR NOT EXISTS(SELECT 1 FROM runtime_executions e JOIN runtime_sessions s ON s.id=e.session_id
    WHERE e.id=NEW.erased_execution_id AND e.billing_run_id=OLD.id AND e.actor_id=OLD.actor_id
     AND s.id=OLD.session_ref AND s.actor_id=OLD.actor_id AND s.erased_at IS NOT NULL
     AND e.erased_at IS NOT NULL AND e.state=CASE WHEN OLD.state='settled' AND OLD.outcome='delivered'
      THEN 'completed' ELSE 'cancelled' END AND s.active_execution IS NULL)
   OR EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=OLD.id AND c.content_erased_at IS NULL)
   OR EXISTS(SELECT 1 FROM bill2_receipts x JOIN bill2_calls c ON c.id=x.call_id
    WHERE c.run_id=OLD.id AND x.financial_projection_version IS NULL)
  THEN RAISE EXCEPTION 'RUNTIME_ERASURE_BINDING_DENIED'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.session_ref IS NOT DISTINCT FROM OLD.session_ref THEN RETURN NEW;END IF;
 IF OLD.session_ref IS NOT NULL OR NEW.session_ref IS NULL OR OLD.state<>'prepared'
 OR EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=OLD.id)
 OR NOT EXISTS(SELECT 1 FROM runtime_executions e JOIN runtime_sessions s ON s.id=e.session_id
  WHERE e.billing_run_id=OLD.id AND e.session_id=NEW.session_ref AND e.actor_id=OLD.actor_id AND s.scope=OLD.scope)
 THEN RAISE EXCEPTION 'RUNTIME_IMMUTABLE_BINDING';END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS runtime_binding_guard ON public.bill2_runs;
CREATE TRIGGER runtime_binding_guard BEFORE INSERT OR UPDATE ON public.bill2_runs
 FOR EACH ROW EXECUTE FUNCTION public.runtime_binding_guard();

CREATE OR REPLACE FUNCTION public.account_erasure_detach_runtime(p_profile_id uuid,p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs; e runtime_executions; s runtime_sessions;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_profile_id;
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501'; END IF;
 IF NOT coalesce(bill2_erasure_closed(p_profile_id,coalesce(r.pre_deduct_id,r.id)),false) THEN
  RAISE EXCEPTION 'ACCOUNT_ERASURE_NOT_CLOSED' USING ERRCODE='42501';
 END IF;
 IF r.erased_session_id IS NOT NULL THEN RETURN '{"processed":0,"remaining":0}'::jsonb; END IF;
 IF r.session_ref IS NULL THEN RETURN '{"processed":0,"remaining":0,"reason":"no_runtime_binding"}'::jsonb; END IF;
 -- Same session -> execution -> run order as Runtime recovery. Never hold run/profile then wait on a session.
 SELECT * INTO s FROM runtime_sessions WHERE id=r.session_ref AND actor_id=p_profile_id FOR UPDATE NOWAIT;
 SELECT * INTO e FROM runtime_executions WHERE billing_run_id=r.id AND actor_id=p_profile_id FOR UPDATE NOWAIT;
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_profile_id FOR UPDATE;
 PERFORM id FROM bill2_calls WHERE run_id=r.id ORDER BY id FOR UPDATE;
 PERFORM x.id FROM bill2_receipts x JOIN bill2_calls c ON c.id=x.call_id
  WHERE c.run_id=r.id ORDER BY x.id FOR UPDATE OF x;
 PERFORM id FROM profiles WHERE id=p_profile_id FOR UPDATE;
 IF r.erased_session_id IS NOT NULL THEN RETURN '{"processed":0,"remaining":0}'::jsonb; END IF;
 IF s.id IS NULL OR e.id IS NULL OR e.session_id IS DISTINCT FROM s.id OR r.session_ref IS DISTINCT FROM s.id THEN
  RAISE EXCEPTION 'RUNTIME_BINDING_DENIED' USING ERRCODE='42501';
 END IF;
 IF NOT r.closed OR r.state NOT IN ('settled','refunded') OR r.conflict THEN
  RETURN '{"processed":0,"remaining":1,"reason":"billing_pending"}'::jsonb;
 END IF;
 IF s.erased_at IS NULL OR e.erased_at IS NULL OR e.state NOT IN ('completed','cancelled')
  OR s.active_execution IS NOT NULL OR r.content_erased_at IS NULL
  OR EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=r.id AND content_erased_at IS NULL)
  OR EXISTS(SELECT 1 FROM bill2_receipts x JOIN bill2_calls c ON c.id=x.call_id
   WHERE c.run_id=r.id AND x.financial_projection_version IS NULL) THEN
  RETURN '{"processed":0,"remaining":1,"reason":"content_pending"}'::jsonb;
 END IF;
 UPDATE bill2_runs SET erased_session_id=session_ref,erased_execution_id=e.id,session_ref=NULL WHERE id=r.id;
 RETURN '{"processed":1,"remaining":0}'::jsonb;
EXCEPTION WHEN lock_not_available THEN
 RETURN '{"processed":0,"remaining":1,"reason":"binding_busy"}'::jsonb;
END $$;
REVOKE ALL ON FUNCTION public.account_erasure_detach_runtime(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.account_erasure_detach_runtime(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.runtime_receipt_saved(
 p_actor_id uuid,p_execution_id uuid,p_run_id uuid,p_call_id uuid,p_evidence jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM bill2_runs r JOIN bill2_calls c ON c.run_id=r.id
  WHERE r.id=p_run_id AND r.actor_id=p_actor_id AND c.id=p_call_id AND
   (EXISTS(SELECT 1 FROM runtime_executions e WHERE e.id=p_execution_id AND e.actor_id=p_actor_id
     AND e.billing_run_id=r.id AND r.session_ref=e.session_id)
    OR (r.session_ref IS NULL AND r.erased_session_id IS NOT NULL AND r.erased_execution_id=p_execution_id
     AND r.closed AND r.state IN ('settled','refunded')
     AND bill2_erasure_closed(p_actor_id,coalesce(r.pre_deduct_id,r.id))))) THEN
  RAISE EXCEPTION 'RUNTIME_BINDING_DENIED';
 END IF;
 RETURN EXISTS(SELECT 1 FROM bill2_receipts WHERE call_id=p_call_id
  AND payload_hash=encode(sha256(convert_to(p_evidence::text,'utf8')),'hex'));
END $$;
CREATE OR REPLACE FUNCTION public.runtime_financial_recovery(p_actor_id uuid, p_execution_id uuid, p_finish boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE e runtime_executions;s runtime_sessions;b bill2_runs;v jsonb;erasing boolean;terminal text;
BEGIN
 -- Detached bindings only expose their existing terminal financial result; never repeat settlement.
 SELECT * INTO b FROM bill2_runs WHERE actor_id=p_actor_id AND erased_execution_id=p_execution_id;
 IF b.id IS NOT NULL THEN
  IF b.session_ref IS NOT NULL OR NOT b.closed OR b.state NOT IN ('settled','refunded')
   OR NOT coalesce(bill2_erasure_closed(p_actor_id,coalesce(b.pre_deduct_id,b.id)),false) THEN
   RAISE EXCEPTION 'RUNTIME_BINDING_DENIED';
  END IF;
  RETURN jsonb_build_object('executionId',p_execution_id,'runId',b.id,
   'state',CASE WHEN b.state='settled' AND b.outcome='delivered' THEN 'completed' ELSE 'cancelled' END,
   'billing',(bill2_public(b)-'scope')||'{"accountClosed":true}'::jsonb);
 END IF;
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
