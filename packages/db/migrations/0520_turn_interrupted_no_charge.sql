-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2: an interrupted turn that saved no answer is not charged (Owner 2026-11-11, deep review finding 9; MASTER_PLAN 2.1).
-- Before: a turn closed `interrupted` (a model call over its 240 s limit closed by the request, or a turn the platform stopped at
-- 300 s closed by the recovery job) charged the user what its final receipts said, min(N, H), although no answer was saved and the
-- admin "refund this turn" answered already_settled. AGENTS 5: paid for and not delivered is outside the 5 USD loss line.
-- Now: turn_user_charge answers 0 for an interrupted turn. One rule in the one function every settlement goes through: the close
-- itself (turn_close), the later settlement pass of a cost that became known (turn_close's closed branch, turn_recover 'settle') and
-- the admin refund all read it, so a turn is charged the same whichever of them settles it. The provider costs stay on the receipts
-- (turn_calls), in the stop-loss (daily_spend) and in absorbed_credits: Graylum bears them, on record.
-- Unchanged: a compare turn still pays for each column whose answer was saved as usable; a jury turn keeps its own rule (a
--   deliverable revision pays the price, an interruption the known usable usage); a report already paid nothing when interrupted
--   (turn_report_settlement); a voice generation already paid only for a saved profile. Completed, stopped, failed, expired and
--   erased closes are untouched. The freeze of an interrupted turn with a model cost still unknown waits for recovery as before
--   (turn_close: every freeze of a turn settles once), then returns in full.
-- Compatible: one whole-function replacement, same signature and grants; code deployed before or after reads the same result
--   shape (chargedCredits 0 instead of a positive number for these turns). Turns already settled keep what they were charged.
-- Repeatable: CREATE OR REPLACE.
-- Recovery: re-apply the definition of turn_user_charge from packages/db/functions/turn/ at the commit before this migration
--   (turns settled meanwhile keep their zero charge).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.turn_user_charge(p_actor_id uuid, p_turn_id bigint, p_kind text, p_delivered boolean, p_refund_all boolean, p_credits integer, p_held integer, p_fixed integer, p_at timestamp with time zone)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE stops integer; t turns;
BEGIN
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id;
  IF p_refund_all THEN RETURN 0; END IF;
  -- A voice generation is paid for only when a usable profile was saved and kept (the old rule: no profile, no charge, whatever the
  -- call cost; an erased one, its version deleted meanwhile, saved nothing).
  IF t.kind = 'voice' AND (NOT p_delivered OR p_kind <> 'completed') THEN RETURN 0; END IF;
  -- An erased review or compare (its report, source or conversation deleted) pays nothing, also for an answer that arrived after:
  -- its body was never kept, so nothing was delivered.
  IF t.kind IN ('jury','compare') AND p_kind = 'erased' THEN RETURN 0; END IF;
  IF t.kind = 'jury' THEN
    -- A review another path ended unfinished (an archived business) refunds everything, whichever job closes its turn first and
    -- whatever was saved before that end.
    IF EXISTS (SELECT 1 FROM fusion_reviews r WHERE r.actor_id = p_actor_id AND r.id = (t.policy->>'reviewId')::uuid
        AND r.state IN ('incomplete','revision_failed')) THEN
      RETURN 0;
    END IF;
    -- The jury's fixed price (Owner 10-17/10-27, V2-7b), as fusion_review_fee_settle_internal: a deliverable revision (a usable
    -- summary that changes a section) pays the price however the turn ended; an interruption or the 24-hour end pays the known
    -- usage, at most the price; no change, a failed revision, an incomplete review or an erasure pays nothing.
    IF EXISTS (SELECT 1 FROM turn_calls c WHERE c.turn_id = p_turn_id AND c.status = 'ok' AND c.usage->>'deliverable' = 'true')
      OR EXISTS (SELECT 1 FROM fusion_turn_outputs o WHERE o.turn_id = p_turn_id AND o.deliverable)
      -- Closed as delivered: the fact stays on the turn when the answer is deleted before a late cost settles.
      OR p_delivered THEN
      RETURN least(coalesce(p_fixed, p_held), p_held);
    END IF;
    IF p_kind IN ('interrupted','expired') THEN
      -- The known usage as turn_close counts it, without a seat or summary judged unusable (format or revision invalid): one
      -- whose cost was settled later by recovery (status ok) is borne by the platform, as when its cost was known at once.
      -- The verdict stays on the receipt, so a deletion of the saved answer does not make it chargeable.
      SELECT ceil((t.policy->>'q')::numeric * coalesce(sum(c.nominal_usd * c.multiplier), 0))::integer INTO p_credits
      FROM turn_calls c WHERE c.turn_id = p_turn_id AND c.status = 'ok' AND c.call_kind <> 'decision'
        AND coalesce(c.answer_verdict, 'usable') = 'usable';
      RETURN least(p_credits, coalesce(p_fixed, p_held), p_held);
    END IF;
    RETURN 0;
  END IF;
  IF t.kind = 'compare' THEN
    -- Each column is rounded on its own (2.7 "各模型各自取整"), as the old per-run settlement did.
    SELECT coalesce(sum(ceil((t.policy->>'q')::numeric * c.nominal_usd * c.multiplier)), 0)::integer INTO p_credits
    FROM turn_calls c WHERE c.turn_id = p_turn_id AND c.status = 'ok' AND c.call_kind <> 'decision'
      -- Only a column with a usable answer is charged: not one refused, empty or broken off, also when recovery settled its cost
      -- later as ok (the verdict stays on the receipt, also when the saved answer is deleted, turn_fusion_record / _output).
      AND c.answer_verdict = 'usable';
  END IF;
  -- Owner 2026-11-11: a turn that was cut off (a call over its time limit, a function the platform stopped, a turn recovery had to end)
  -- saved no answer, so the user pays nothing for it, whatever its receipts say. The receipts keep their costs: they are Graylum's
  -- (absorbed_credits, the stop-loss). What was saved and delivered stays charged by the rules above: a compare column with a usable
  -- answer, a jury by its own rule.
  IF p_kind = 'interrupted' AND NOT p_delivered AND t.kind <> 'compare' THEN RETURN 0; END IF;
  IF p_kind = 'expired' AND NOT p_delivered THEN RETURN 0; END IF;
  IF p_kind = 'stopped' THEN
    -- 10-27: the first two stops within 24 hours are free; from the third, what was generated, at most the fixed price.
    SELECT count(*) INTO stops FROM turns r WHERE r.actor_id = p_actor_id AND r.kind = 'report' AND r.stopped_by_user
      AND r.id <> p_turn_id AND r.closed_at > p_at - interval '24 hours' AND r.closed_at <= p_at;
    RETURN CASE WHEN stops < 2 THEN 0 ELSE least(p_credits, p_held, coalesce(p_fixed, p_held)) END;
  END IF;
  IF p_kind = 'completed' AND p_fixed IS NOT NULL THEN RETURN CASE WHEN p_delivered THEN least(p_fixed, p_held) ELSE 0 END; END IF;
  RETURN least(p_credits, p_held);
END $function$;

COMMIT;
