-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- CORE-PATH-V2 V2-12 B8a (number 0463 assigned by the controller): the billed TikHub reads of the publish monitor move from
-- a sessionless BILL2 run to a kind='review' turn (policy.review.mode = 'read'), billed like any paid tool call of a turn.
--   * social_billed_runs.run_id and social_billed_reads.run_id are unchanged uuid columns; they now hold the turn's request_id
--     (turns.request_id, unique per actor). Nothing references bill2_runs any more; the tables keep no foreign keys on purpose
--     (an open run must still be found and closed after the connection or account is gone).
--   * publish_monitor_session(actor, connection): the hidden conversation a read turn runs in (turn_open needs one), one per
--     connection (scope kind 'publish_monitor_read'); it holds no messages.
--   * publish_monitor_billed_run: binds a turn (by request id) instead of a BILL2 run.
--   * publish_monitor_billed_recovery: unchanged for a run opened on BILL2 before this migration (its receipts are still replayed and
--     its hold released); a turn run needs only its live ledger attempts freed, its turn is settled by the turn recovery job.
--   * publish_monitor_billed_run accepts a turn's request id and, for old code that is still running while this is applied, a BILL2 run
--     id (both until batch F), and also says whether the run is such a legacy BILL2 run ('legacy'). publish_monitor_billed_orphans keeps
--     its old output shape (old code validates it strictly); a turn run is listed once its turn is closed, a legacy run as before.
--     publish_monitor_billed_legacy(run) tells the two apart. The order of deployment is therefore free: old code keeps working on
--     the new functions, new code works on the old ones only after the migration.
-- publish_monitor_tool_only_run stays until batch F (bill2_prepare still calls it). Repeatable: CREATE OR REPLACE only.
-- Recovery: re-apply 0289's versions of billed_run and billed_orphans (packages/db/functions history) and
-- DROP FUNCTION public.publish_monitor_session(uuid,uuid); ledger rows written meanwhile keep the turn's request id and are
-- closed by the daily job once their turns are closed.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.publish_monitor_session(p_actor_id uuid,p_connection_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE sc jsonb; s runtime_sessions;
BEGIN
 IF p_actor_id IS NULL OR p_connection_id IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted::text='false')
  OR NOT EXISTS(SELECT 1 FROM social_connections WHERE id=p_connection_id AND actor_id=p_actor_id) THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 sc:=jsonb_build_object('kind','publish_monitor_read','connectionId',p_connection_id);
 INSERT INTO runtime_sessions(actor_id,scope,start_request_id,start_payload)
 VALUES(p_actor_id,sc,gen_random_uuid(),jsonb_build_object('scope',sc)) ON CONFLICT(actor_id,scope) DO NOTHING;
 SELECT * INTO s FROM runtime_sessions WHERE actor_id=p_actor_id AND scope=sc;
 IF s.id IS NULL OR s.erased_at IS NOT NULL OR s.content_deleted_at IS NOT NULL THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 RETURN s.id;
END $$;

-- The open run of the current refresh, if any ({runId, policies}); with p_run_id (a read turn's request id), binds that new run
-- when none is open. NULL when the claim is no longer current.
CREATE OR REPLACE FUNCTION public.publish_monitor_billed_run(p_connection_id uuid,p_lease uuid,p_refresh_id uuid,
 p_run_id uuid,p_policies jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c social_connections; b social_billed_runs;
BEGIN
 c:=publish_monitor_refresh_current(p_connection_id,p_lease,p_refresh_id);
 IF c.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO b FROM social_billed_runs WHERE connection_id=c.id AND refresh_id=p_refresh_id AND closed_at IS NULL FOR UPDATE;
 IF b.run_id IS NULL AND p_run_id IS NOT NULL THEN
  IF jsonb_typeof(p_policies) IS DISTINCT FROM 'array'
   -- Old code still running while this migration is applied binds the BILL2 run it prepared; both kinds are accepted until batch F.
   OR (NOT EXISTS(SELECT 1 FROM turns WHERE request_id=p_run_id AND actor_id=c.actor_id AND kind='review')
    AND NOT EXISTS(SELECT 1 FROM bill2_runs WHERE id=p_run_id AND actor_id=c.actor_id)) THEN
   RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  INSERT INTO social_billed_runs(run_id,connection_id,refresh_id,actor_id,policies)
  VALUES(p_run_id,c.id,p_refresh_id,c.actor_id,p_policies) RETURNING * INTO b;
 END IF;
 RETURN CASE WHEN b.run_id IS NULL THEN jsonb_build_object('runId',NULL)
  ELSE jsonb_build_object('runId',b.run_id,'policies',b.policies,
   'legacy',NOT EXISTS(SELECT 1 FROM turns WHERE request_id=b.run_id AND actor_id=b.actor_id)) END;
END $$;

-- What a left-open run still needs: its live ledger attempts (opened or dispatched) are abandoned so their keys are free again. For a
-- run opened on BILL2 before this migration (no turn) the sent-without-receipt calls and the saved receipts are listed as before, so
-- the old settlement still releases its hold; a turn run has none (its turn is settled by the turn recovery job).
CREATE OR REPLACE FUNCTION public.publish_monitor_billed_recovery(p_run_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('operationId',x.id,'callId',x.call_id,'model',x.model,
   'callPending',x.pending,'live',x.state IN ('opened','dispatched'),'receipt',x.receipt) ORDER BY x.created_at),'[]'::jsonb)
 FROM (SELECT r.id,r.call_id,r.model,r.state,r.created_at,
   CASE WHEN r.state='answered' THEN r.result->'billing'->'receipt' END AS receipt,
   EXISTS(SELECT 1 FROM bill2_calls bc WHERE bc.id=r.call_id AND bc.run_id=r.run_id AND bc.state='dispatched'
    AND bc.settled_at IS NULL) AS pending
  FROM social_billed_reads r WHERE r.run_id=p_run_id) x
 WHERE x.pending OR x.state IN ('opened','dispatched')
$$;

-- Runs still open whose refresh can no longer be running (its connection is gone, its lease expired an hour ago, or it has moved
-- on to another refresh) and whose turn is closed. The daily job abandons their live attempts and marks them closed.
CREATE OR REPLACE FUNCTION public.publish_monitor_billed_orphans(p_limit integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('connectionId',b.connection_id,'actorId',b.actor_id,'runId',b.run_id,
  'policies',b.policies)),'[]'::jsonb)
 FROM (SELECT b.* FROM social_billed_runs b LEFT JOIN social_connections c ON c.id=b.connection_id
  WHERE b.closed_at IS NULL AND (c.id IS NULL OR c.refresh_id IS DISTINCT FROM b.refresh_id
   OR c.lease_expires_at IS NULL OR c.lease_expires_at<clock_timestamp()-interval '1 hour')
   AND NOT EXISTS(SELECT 1 FROM turns t WHERE t.request_id=b.run_id AND t.actor_id=b.actor_id AND t.state<>'closed')
  ORDER BY b.created_at LIMIT LEAST(GREATEST(p_limit,1),200)) b
$$;

-- Whether a run is a BILL2 run opened before reads moved to turns (it has no turn).
CREATE OR REPLACE FUNCTION public.publish_monitor_billed_legacy(p_run_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM turns WHERE request_id=p_run_id AND kind='review')
$$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('publish_monitor_session','publish_monitor_billed_run',
   'publish_monitor_billed_recovery','publish_monitor_billed_orphans','publish_monitor_billed_legacy') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
 END LOOP;
END $$;
COMMIT;
