-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DB-100 line W (C6, Owner/controller 2026-10-25: only change how the queries read, not how often they run or what
-- they return). The three recovery and reconciliation jobs below walked every settled round on each run:
-- runtime_stale_charged_rounds (executions seq scan), runtime_pending_financial_batch (bill2_runs seq scan) and
-- runtime_interrupted_recovery (the list branch joined from the biggest table). Each now starts from a small partial
-- index over the open rows, so the pages read per call follow the number of open rounds, not the history.
--  * bill2_runs_recovery_open: runs that are not settled/refunded, or a user-stopped run still waiting for its cancel
--    (exactly the rows runtime_pending_financial_batch can list; all other branches of its WHERE need one of them).
--  * runtime_executions_open_created: executions in a state runtime_stale_charged_rounds looks at (created_at order).
--  * runtime_sessions_active_execution: sessions with a live execution (the only ones interrupted recovery needs).
-- runtime_interrupted_recovery changes only its list branch: the same joins and filters as 0379, driven from the
-- sessions that have an active execution (OFFSET 0 keeps that order). The locked per-execution branch is untouched.
-- The two stale-round functions and runtime_pending_financial_batch keep their definitions; the indexes are enough.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE INDEX IF NOT EXISTS bill2_runs_recovery_open ON public.bill2_runs (id)
 WHERE state NOT IN ('settled','refunded') OR (paused_reason='user_stop' AND cancel_requested);
CREATE INDEX IF NOT EXISTS runtime_executions_open_created ON public.runtime_executions (created_at, id)
 WHERE state IN ('prepared','running','interrupted','cost_pending','waiting_resume','waiting_credits');
CREATE INDEX IF NOT EXISTS runtime_sessions_active_execution ON public.runtime_sessions (active_execution)
 WHERE active_execution IS NOT NULL;
CREATE OR REPLACE FUNCTION public.runtime_interrupted_recovery(
 p_actor_id uuid DEFAULT NULL,p_execution_id uuid DEFAULT NULL,p_epoch bigint DEFAULT NULL,p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions;s runtime_sessions;r bill2_runs;items jsonb;ended jsonb;
 stamp timestamptz:=clock_timestamp();cutoff timestamptz:=stamp-interval '300 seconds';
 -- A running owner is gone once its dispatch lease (265 s) has expired by more than the rest of the 300 s function limit.
 owner_gone timestamptz:=stamp-interval '60 seconds';
 -- A round that already saved its reply is first left to ownerLostRecovery.ts (every minute, 20 per run), which turns it
 -- into a resumable wait that shows the reply; only one it could not hand back for 15 minutes is released here.
 reply_grace timestamptz:=stamp-interval '15 minutes';
 -- An admitted round is begun by the same request, or by the page's executeStream seconds later; one never begun after
 -- 10 minutes belongs to a client that is gone.
 never_begun timestamptz:=stamp-interval '10 minutes';
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN
  RAISE EXCEPTION 'RUNTIME_RECOVERY_BATCH_LIMIT_INVALID' USING ERRCODE='22023';
 END IF;
 IF p_execution_id IS NULL THEN
  IF p_epoch IS NOT NULL THEN RAISE EXCEPTION 'RUNTIME_RECOVERY_BINDING_DENIED';END IF;
  SELECT coalesce(jsonb_agg(item ORDER BY created_at,id),'[]'::jsonb) INTO items FROM (
   SELECT ex.id,ex.created_at,jsonb_build_object('executionId',ex.id,'actorId',ex.actor_id,
    'runId',br.id,'epoch',br.runtime_epoch) item
   FROM (SELECT rs.id,rs.actor_id,rs.active_execution FROM runtime_sessions rs WHERE rs.active_execution IS NOT NULL OFFSET 0) sess
   JOIN runtime_executions ex ON ex.id=sess.active_execution AND ex.session_id=sess.id AND ex.actor_id=sess.actor_id
   JOIN bill2_runs br ON br.id=ex.billing_run_id AND br.actor_id=ex.actor_id AND br.session_ref=sess.id
   WHERE (p_actor_id IS NULL OR ex.actor_id=p_actor_id)
    AND (ex.state='interrupted' OR (ex.state='running' AND br.runtime_dispatch_deadline<=
     CASE WHEN ex.primary_result IS NULL THEN owner_gone ELSE reply_grace END)
     OR (ex.state='prepared' AND br.runtime_epoch=0 AND ex.created_at<=never_begun
      AND NOT EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=br.id)))
    AND ex.result IS NULL AND ex.failure_code IS NULL
    AND ex.content_deleted_at IS NULL AND ex.created_at<=cutoff
    AND br.contract_version='bill2.v2' AND (br.runtime_epoch>0 OR ex.state='prepared') AND NOT br.closed
    AND NOT br.cancel_requested AND NOT br.conflict AND br.paused_reason IS NULL
    AND (br.runtime_dispatch_deadline IS NULL OR br.runtime_dispatch_deadline<=stamp)
    AND NOT EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=br.id AND (
     (c.dispatched_at IS NOT NULL AND (c.dispatched_at>cutoff OR c.settled_at IS NULL OR c.selected_cost_usd IS NULL))
     OR (c.dispatched_at IS NULL AND c.state<>'cancelled' AND NOT (c.state='prepared' AND c.settled_at IS NULL
      AND c.dispatch_deadline<=owner_gone))))
   ORDER BY ex.created_at,ex.id LIMIT p_limit
  ) selected;
  RETURN items;
 END IF;
 IF p_actor_id IS NULL OR p_epoch IS NULL OR p_epoch<0 THEN RAISE EXCEPTION 'RUNTIME_RECOVERY_BINDING_DENIED';END IF;
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
 IF s.active_execution IS DISTINCT FROM e.id OR e.state NOT IN ('interrupted','running','prepared')
  -- A never-begun round has epoch 0 and no call at all; begin() would have raised its epoch.
  OR (e.state='prepared' AND (r.runtime_epoch<>0 OR e.created_at>never_begun
   OR EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=r.id)))
  OR (e.state<>'prepared' AND r.runtime_epoch<1)
  OR (e.state='running' AND (r.runtime_dispatch_deadline IS NULL OR r.runtime_dispatch_deadline>
   CASE WHEN e.primary_result IS NULL THEN owner_gone ELSE reply_grace END))
  OR e.result IS NOT NULL
  OR e.failure_code IS NOT NULL OR e.content_deleted_at IS NOT NULL OR e.created_at>cutoff
  OR r.closed OR r.cancel_requested OR r.conflict OR r.paused_reason IS NOT NULL
  OR r.runtime_dispatch_deadline>stamp
  OR EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=r.id AND (
   (c.dispatched_at IS NOT NULL AND (c.dispatched_at>cutoff OR c.settled_at IS NULL OR c.selected_cost_usd IS NULL))
   OR (c.dispatched_at IS NULL AND c.state<>'cancelled' AND NOT (c.state='prepared' AND c.settled_at IS NULL
    AND c.dispatch_deadline<=owner_gone))))
 THEN RETURN jsonb_build_object('state','skipped');END IF;
 -- An unknown failure is not a user cancellation. Keep charged PAYG runs open for
 -- the existing 24-hour stale-round refund; free its Session now and fence the old owner.
 IF r.charged>0 THEN
  UPDATE bill2_runs SET runtime_epoch=runtime_epoch+1,runtime_dispatch_deadline=NULL WHERE id=r.id;
  -- A claim the dead owner never sent releases its hold, as runtime_execution does when a lease expires.
  UPDATE bill2_calls SET state='cancelled',token=gen_random_uuid(),runtime_retryable=false
   WHERE run_id=r.id AND state='prepared' AND dispatched_at IS NULL AND settled_at IS NULL;
  IF FOUND THEN PERFORM bill2_finalize(p_actor_id,r.id);END IF;
  -- A running owner that died is marked interrupted too, so the page stops waiting for it.
  UPDATE runtime_executions SET failure_code='RUNTIME_INTERRUPTED_RELEASED',state='interrupted' WHERE id=e.id;
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
COMMIT;
