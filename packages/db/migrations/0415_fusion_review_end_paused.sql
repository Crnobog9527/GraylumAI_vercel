-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- FUSION-REVIEW paused-review expiry (Owner 2026-10-27: "评审团暂停超过 24 小时，也自动结束并退还没用的押金").
-- A review that stays paused (0236 fusion_review_pause_idle: no movement for an hour, every call settled) kept its fixed
-- fee held for good: fusion_review_fee_settle_due skips running and paused reviews, so only the user's "end review"
-- settled it. New function fusion_review_end_paused(p_idle, p_limit) ends every review that has been paused for p_idle
-- (default 24 hours) through fusion_review_close(.., 'interrupted') -- the same path as the user's "end review" -- so the
-- delivered part is charged by the existing stop rule and the unused fee is released by fusion_review_fee_settle_internal
-- (its own conservation check, one release row per review). No refund logic is written here. The scheduled recovery
-- (fusion-recovery, every 10 minutes) calls it right after fusion_review_pause_idle.
-- Concurrency: each review is locked FOR UPDATE SKIP LOCKED and its state and age are re-checked under the lock, so a user
-- who continues (fusion_review_claim resumes it to running and restarts its age) at the moment of expiry either wins
-- the lock (the review is skipped) or finds it ended (FUSION_REVIEW_ENDED); two runs at once end a review once.
-- p_limit counts only reviews ended or failed, not skipped ones, so reviews stuck in front cannot starve those behind them;
-- the result also reports how many were skipped, which the scheduled recovery logs.
-- A review that still has a saved, unjudged output (a call with an output, no verdict and not settled: the listing of
-- fusion_review_unjudged) is skipped and left paused for the next run: finalizing it now would mark the output
-- unjudged_saved, bill a summary that may be malformed and take it out of the re-judging listing for good. The scheduled
-- recovery re-judges before it calls this function, so such a review is ended on a later run.
-- Compatibility: a new function only; no existing function, table or privilege changes, so old and new application code are
-- interchangeable (old code simply never calls it; paused reviews then keep waiting as before).
-- Repeatable: CREATE OR REPLACE and an idempotent grant; no data change when applied. Running the function again ends nothing
-- new and settles nothing twice.
-- Recovery: DROP FUNCTION public.fusion_review_end_paused(interval,integer); reviews it already ended stay ended
-- and settled (their fees were refunded or charged by the normal rule), and nothing needs restoring.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.fusion_review_end_paused(p_idle interval DEFAULT '24 hours', p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE cand record; rv fusion_reviews; ended integer:=0; failed integer:=0; skipped integer:=0;
BEGIN
  IF p_idle IS NULL OR p_idle<interval '1 hour' OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'FUSION_REVIEW_INVALID'; END IF;
  FOR cand IN SELECT id FROM fusion_reviews WHERE state='paused' AND updated_at<=clock_timestamp()-p_idle
      ORDER BY updated_at,id LOOP
    -- p_limit bounds the reviews actually ended or failed in one run; a skipped review (locked, resumed, or waiting for its
    -- unjudged output to be judged) takes no place, so a stuck one in front never keeps the ones behind it from being ended.
    EXIT WHEN ended+failed>=p_limit;
    BEGIN
      -- Never waits on a review row a claim, advance or close holds: it is skipped until the next run. The state and the age
      -- are read again under the lock, because a claim may have resumed it (running, age restarted) since the listing.
      SELECT * INTO rv FROM fusion_reviews WHERE id=cand.id FOR UPDATE SKIP LOCKED;
      IF NOT FOUND OR rv.state<>'paused' OR rv.updated_at>clock_timestamp()-p_idle THEN skipped:=skipped+1; CONTINUE; END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(rv.steps) x
          JOIN bill2_runs br ON br.fusion_group_id=(x->>'groupId')::uuid AND br.actor_id=rv.actor_id
          JOIN bill2_calls c ON c.run_id=br.id
          WHERE c.fusion_verdict IS NULL AND c.settled_at IS NULL
            AND EXISTS(SELECT 1 FROM fusion_call_outputs o WHERE o.call_id=c.id)) THEN skipped:=skipped+1; CONTINUE; END IF;
      -- The user's "end review": cancels and finalizes the review's runs, then settles the fixed fee (charge what the stop
      -- rule says was delivered, release the rest) with the settlement's conservation check.
      PERFORM fusion_review_close(rv.actor_id,rv.id,'interrupted');
      ended:=ended+1;
    EXCEPTION
      WHEN deadlock_detected OR lock_not_available THEN skipped:=skipped+1;
      WHEN OTHERS THEN
        -- Content-free: the review id and the error code only. The review stays paused and is tried again next run.
        failed:=failed+1;
        RAISE WARNING 'fusion_review_end_paused failed: review % sqlstate %',cand.id,SQLSTATE;
    END;
  END LOOP;
  RETURN jsonb_build_object('ended',ended,'failed',failed,'skipped',skipped);
END $function$;

REVOKE ALL ON FUNCTION public.fusion_review_end_paused(interval,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fusion_review_end_paused(interval,integer) TO service_role;

COMMIT;
