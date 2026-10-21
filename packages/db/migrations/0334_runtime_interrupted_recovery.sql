-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Service-only inventory and locked final check. Keeps unknown-failure refund eligibility.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION public.runtime_interrupted_recovery(
 p_actor_id uuid DEFAULT NULL,p_execution_id uuid DEFAULT NULL,p_epoch bigint DEFAULT NULL,p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions;s runtime_sessions;r bill2_runs;items jsonb;ended jsonb;
 stamp timestamptz:=clock_timestamp();cutoff timestamptz:=stamp-interval '300 seconds';
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN
  RAISE EXCEPTION 'RUNTIME_RECOVERY_BATCH_LIMIT_INVALID' USING ERRCODE='22023';
 END IF;
 IF p_execution_id IS NULL THEN
  IF p_epoch IS NOT NULL THEN RAISE EXCEPTION 'RUNTIME_RECOVERY_BINDING_DENIED';END IF;
  SELECT coalesce(jsonb_agg(item ORDER BY created_at,id),'[]'::jsonb) INTO items FROM (
   SELECT ex.id,ex.created_at,jsonb_build_object('executionId',ex.id,'actorId',ex.actor_id,
    'runId',br.id,'epoch',br.runtime_epoch) item
   FROM runtime_executions ex JOIN runtime_sessions sess ON sess.id=ex.session_id AND sess.actor_id=ex.actor_id
   JOIN bill2_runs br ON br.id=ex.billing_run_id AND br.actor_id=ex.actor_id AND br.session_ref=sess.id
   WHERE (p_actor_id IS NULL OR ex.actor_id=p_actor_id) AND sess.active_execution=ex.id
    AND ex.state='interrupted' AND ex.result IS NULL AND ex.failure_code IS NULL
    AND ex.content_deleted_at IS NULL AND ex.created_at<=cutoff
    AND br.contract_version='bill2.v2' AND br.runtime_epoch>0 AND NOT br.closed
    AND NOT br.cancel_requested AND NOT br.conflict AND br.paused_reason IS NULL
    AND (br.runtime_dispatch_deadline IS NULL OR br.runtime_dispatch_deadline<=stamp)
    AND NOT EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=br.id AND (
     (c.dispatched_at IS NOT NULL AND (c.dispatched_at>cutoff OR c.settled_at IS NULL OR c.selected_cost_usd IS NULL))
     OR (c.dispatched_at IS NULL AND c.state<>'cancelled')))
   ORDER BY ex.created_at,ex.id LIMIT p_limit
  ) selected;
  RETURN items;
 END IF;
 IF p_actor_id IS NULL OR p_epoch IS NULL OR p_epoch<1 THEN RAISE EXCEPTION 'RUNTIME_RECOVERY_BINDING_DENIED';END IF;
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id;
 IF e.id IS NULL THEN RAISE EXCEPTION 'RUNTIME_EXECUTION_DENIED';END IF;
 -- Same lock order as normal execution, stop and resume. No provider work holds these locks.
 SELECT * INTO s FROM runtime_sessions WHERE id=e.session_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO r FROM bill2_runs WHERE id=e.billing_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF s.id IS NULL OR r.id IS NULL OR r.session_ref IS DISTINCT FROM s.id THEN
  RAISE EXCEPTION 'RUNTIME_RECOVERY_BINDING_DENIED';
 END IF;
 IF r.contract_version<>'bill2.v2' OR r.runtime_epoch IS DISTINCT FROM p_epoch THEN
  RETURN jsonb_build_object('state','skipped');
 END IF;
 IF e.state IN ('completed','cancelled') AND r.closed AND r.state IN ('settled','refunded') THEN
  RETURN jsonb_build_object('state',e.state);
 END IF;
 IF s.active_execution IS DISTINCT FROM e.id OR e.state<>'interrupted' OR e.result IS NOT NULL
  OR e.failure_code IS NOT NULL OR e.content_deleted_at IS NOT NULL OR e.created_at>cutoff
  OR r.closed OR r.cancel_requested OR r.conflict OR r.paused_reason IS NOT NULL
  OR r.runtime_dispatch_deadline>stamp
  OR EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=r.id AND (
   (c.dispatched_at IS NOT NULL AND (c.dispatched_at>cutoff OR c.settled_at IS NULL OR c.selected_cost_usd IS NULL))
   OR (c.dispatched_at IS NULL AND c.state<>'cancelled')))
 THEN RETURN jsonb_build_object('state','skipped');END IF;
 -- An unknown failure is not a user cancellation. Keep charged PAYG runs open for
 -- the existing 24-hour stale-round refund; free its Session now and fence the old owner.
 IF r.charged>0 THEN
  UPDATE bill2_runs SET runtime_epoch=runtime_epoch+1,runtime_dispatch_deadline=NULL WHERE id=r.id;
  UPDATE runtime_executions SET failure_code='RUNTIME_INTERRUPTED_RELEASED' WHERE id=e.id;
  UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;
  RETURN jsonb_build_object('state','released');
 END IF;
 -- No charged PAYG spend to compensate. Existing cancellation also refunds incomplete report fees.
 -- This RPC already owns the same epoch and locks; financial cancellation must also work
 -- after content context was revoked. runtime_cancel still enforces actor and scope authority.
 ended:=runtime_cancel(p_actor_id,e.id);
 PERFORM report_fee_settle_internal(e.id,false);
 RETURN ended;
END $$;
REVOKE ALL ON FUNCTION public.runtime_interrupted_recovery(uuid,uuid,bigint,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.runtime_interrupted_recovery(uuid,uuid,bigint,integer) TO service_role;
-- A released, fenced failure no longer blocks a new turn's attached organizer.
-- Keep all other pending-organizer gates and the original 24-hour refund eligibility.
DO $patch$ DECLARE signature text;src text;old_gate text:='AND NOT pr.cancel_requested) THEN RAISE EXCEPTION ''RUNTIME_ORGANIZER_PENDING'';';
 new_gate text:='AND NOT pr.cancel_requested AND pending.failure_code IS DISTINCT FROM ''RUNTIME_INTERRUPTED_RELEASED'') THEN RAISE EXCEPTION ''RUNTIME_ORGANIZER_PENDING'';';
BEGIN
 FOREACH signature IN ARRAY ARRAY['public.runtime_admit(uuid,uuid,uuid,jsonb,jsonb)',
  'public.opc_step_material(uuid,uuid,uuid,text,text,text)'] LOOP
  SELECT pg_get_functiondef(signature::regprocedure) INTO src;
  IF position(new_gate IN src)>0 THEN CONTINUE;END IF;
  IF position(old_gate IN src)=0 THEN RAISE EXCEPTION 'RUNTIME_INTERRUPTED_GATE_PATCH_MISSING';END IF;
  EXECUTE replace(src,old_gate,new_gate);
 END LOOP;
END $patch$;
COMMIT;
