-- ERASURE-STALE-CLAIM: a worker that is killed before account_erasure_executor_finish (Vercel ends the
-- account-erasure route at maxDuration=60s; on 2026-10-19 07:25 a slow database did exactly that on staging)
-- left executor_token set forever. Claims skipped that request on every run, so the account was never
-- erased and only the manual account_erasure_executor_recover path could free it.
--
-- A claim whose executor started more than 15 minutes ago is now taken over by the next claim. The old
-- invocation cannot still be running (the route stops at 60 s), and every request it sent was issued at
-- least 14 minutes earlier. All later steps re-read state and are idempotent: storage deletion re-scans and
-- re-verifies absence, local cleanup and scrubs are bounded re-runs, financial rows are only read or settled
-- through the existing bill2 paths. The old token loses its claim, so any late call made with it is refused
-- (ERASURE_EXECUTOR_NOT_CLAIMED) and its finish no longer matches.
--
-- Auth: if the dead worker had opened the Auth deletion intent, it may or may not have sent the delete.
-- Deleting an Auth user by its id is idempotent (the user id is never reused) and the processor reads the
-- current Auth state first and only deletes a user that is still present, so the original intent (same start
-- time) is reopened for the new claim instead of staying closed forever.
-- The takeover is recorded in executor_recovery_evidence with the old token; nothing else changes.
CREATE OR REPLACE FUNCTION public.account_erasure_executor_claim(p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.account_erasure_requests;
BEGIN
 IF p_token IS NULL THEN RAISE EXCEPTION 'ERASURE_EXECUTOR_INVALID'; END IF;
 SELECT * INTO r FROM account_erasure_requests WHERE stage<>'completed'
  AND (executor_token IS NULL OR executor_started_at<clock_timestamp()-interval '15 minutes')
  AND (executor_attempted_at IS NULL OR executor_attempted_at<clock_timestamp()-interval '5 minutes')
  ORDER BY executor_attempted_at NULLS FIRST,confirmed_at,profile_id LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF r.profile_id IS NULL THEN RETURN jsonb_build_object('claimed',false); END IF;
 PERFORM account_erasure_assert_closed(r.profile_id);
 UPDATE account_erasure_requests SET executor_token=p_token,executor_started_at=clock_timestamp(),
  executor_attempted_at=clock_timestamp(),executor_error_codes=ARRAY['ERASURE_EXECUTOR_RUNNING'],
  executor_recovery_evidence=CASE WHEN r.executor_token IS NULL THEN executor_recovery_evidence
   ELSE jsonb_build_object('token',r.executor_token,'evidence',
    jsonb_build_object('staleClaim',true,'startedAt',r.executor_started_at)) END,
  auth_delete_dispatch_ready=CASE WHEN r.executor_token IS NOT NULL AND auth_delete_claim_token=r.executor_token
   AND auth_delete_started_at IS NOT NULL AND auth_deleted_at IS NULL THEN true ELSE auth_delete_dispatch_ready END
 WHERE profile_id=r.profile_id;
 RETURN jsonb_build_object('claimed',true,'profileId',r.profile_id,'requestId',r.request_id);
END $$;
