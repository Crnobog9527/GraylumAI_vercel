-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved.
-- This code is proprietary and confidential.
-- PUBLISH-MONITOR plan §9 item 25: Post for Me cleanup that stopped retrying must be visible and re-queueable.
-- Provisional number; the controller assigns the final one when this is ready to merge.
--
-- After 50 failed attempts the worker stops: a deletion or takeover disconnect (social_connections.deletion_attempts,
-- 0265 provider_work_claim) and a connect-attempt cleanup (social_connect_requests.cleanup_attempts, 0265
-- cleanup_claim; the daily orphan sweep is its backstop). These read-only list and re-queue functions are for the
-- admin page and the job's alert. The tables stay closed to service_role (0240); only these definer functions open.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.publish_monitor_stuck_list(p_limit integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 -- No user identity: the provider account id and the error code are what a person needs at Post for Me.
 RETURN jsonb_build_object(
  'connections',COALESCE((SELECT jsonb_agg(v ORDER BY v->>'updatedAt') FROM (
   SELECT jsonb_build_object('id',c.id,'kind',CASE WHEN c.status='deleting' THEN 'deletion' ELSE 'takeover_disconnect' END,
    'platform',c.platform,'providerAccountId',c.provider_account_id,'attempts',c.deletion_attempts,
    'error',c.deletion_error,'updatedAt',c.updated_at) v
   FROM social_connections c
   WHERE c.source='postforme' AND (c.status='deleting' OR c.provider_disconnect_pending) AND c.deletion_attempts>=50
   ORDER BY c.updated_at LIMIT p_limit) q),'[]'::jsonb),
  'requests',COALESCE((SELECT jsonb_agg(v ORDER BY v->>'createdAt') FROM (
   SELECT jsonb_build_object('id',r.id,'platform',r.platform,'state',r.state,'attempts',r.cleanup_attempts,
    'error',r.cleanup_error,'createdAt',r.created_at,'providerAccountIds',to_jsonb(r.candidate_provider_ids)) v
   FROM social_connect_requests r
   WHERE r.state IN ('applied','abandoned') AND r.cleanup_attempts>=50
   ORDER BY r.created_at LIMIT p_limit) q),'[]'::jsonb));
END $$;

-- Puts one stopped record back in the queue with a fresh allowance, only while it is still stopped (a second click,
-- or a record that settled meanwhile, changes nothing). Returns whether it was re-queued.
CREATE OR REPLACE FUNCTION public.publish_monitor_stuck_requeue(p_kind text,p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
 IF p_id IS NULL OR p_kind IS NULL OR p_kind NOT IN ('connection','request') THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 IF p_kind='connection' THEN
  UPDATE social_connections SET deletion_attempts=0,deletion_error=NULL,lease_owner=NULL,lease_expires_at=NULL,
   updated_at=clock_timestamp()
  WHERE id=p_id AND source='postforme' AND (status='deleting' OR provider_disconnect_pending) AND deletion_attempts>=50;
 ELSE
  -- The 30-day retention (0265 cleanup_claim) still counts from created_at; a re-queued attempt keeps that limit.
  UPDATE social_connect_requests SET cleanup_attempts=0,cleanup_error=NULL,cleanup_lease=NULL,cleanup_lease_until=NULL
  WHERE id=p_id AND state IN ('applied','abandoned') AND cleanup_attempts>=50;
 END IF;
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN n>0;
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('publish_monitor_stuck_list','publish_monitor_stuck_requeue') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
 END LOOP;
END $$;
COMMIT;
