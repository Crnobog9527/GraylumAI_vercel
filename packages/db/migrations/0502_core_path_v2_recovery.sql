-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-8 (placeholder 0502 from the controller, after 0422 start threshold; the real number is assigned before it is
-- applied): pause, resume and the recovery job on the 0420 turns
-- (docs/launch/tasks/CORE-PATH-V2.md sections 2.2, 2.5, 2.5.2, 3.3.2 item 7, 6.1 row V2-8).
--   turns.recovery_lease_until  the claim lease of the recovery job: a turn one instance claimed is not claimed by another
--                       instance until the lease ends (the instance died, or a settlement waits for its next lookup)
--   turn_recovery_claim  one short transaction: claims up to 50 turns with FOR UPDATE SKIP LOCKED and stamps the lease. Work is
--                       a running/stopping turn untouched for 15 minutes (interrupt), a paused turn untouched for 24 hours
--                       (expire), a closed turn whose settlement is pending and has either a final receipt that arrived after
--                       the last pass or an unknown model cost with a provider id to look up (settle). Every kind,
--                       compare and jury included (aligned with V2-7b: a jury between groups is paused(awaiting_user) and
--                       expires here with refund_all false, so turn_user_charge applies the jury rule; fusion-recovery only
--                       syncs the fusion_* rows).
--                       A paused turn (under 24 hours) with a used model answer whose cost is not final is claimed for a
--                       lookup: the job records the receipt it finds, so the resume (which waits for it) can go ahead.
--                       For a settle or a lookup it returns each unknown model call with the model and nominal price table the turn froze
--                       at open (policy model/pricing, or models/pricings by model id), so a late receipt is priced as a live one.
--   turn_recover        one turn, one short transaction: locks profile, session, turn (as turn_close), re-checks under the locks that
--                       the work is still due (a resume, a late write or another instance may have moved it), then calls
--                       turn_close, the only function that changes a turn's state: interrupted (stopped for a report that was
--                       stopping), expired (paused 24 hours: D = 0, the whole freeze back), or the closed-turn settlement pass
--                       of #1512 (what became known since, counted once). Idempotent: anything not due is skipped.
--   turn_open           whole copy of the 0422 start-threshold version, plus resume_of (2.2, 2.5 "充值后继续"): a turn paused
--                       for credits continues as a new turn of the same session and kind. In one transaction: the stop-loss
--                       reserves the new bound; the paused turn closes refunded in full (failed, failure_code resumed) and what
--                       it would charge (D = min(N, H)) is carried as policy.carriedCredits into the new turn, frozen with it and
--                       settled by its rule (a fixed price stays the fixed price across the chain; an expired continuation
--                       refunds the whole chain; nothing carried is recorded as absorbed); the balance left after the carried
--                       credits must still cover the start threshold L; the new turn's calls get what is left of the paused
--                       turn's limits (never more), and the session moves to it. Anything refused (credits still short,
--                       stop-loss, a model cost not final yet) rolls the whole resume back: the turn stays paused.
--   turn_resume_carry   the resume check of turn_open (internal): turn_open itself only dispatches to it.
--   turn_close          whole copy of 0421 plus the carried credits in N (close and settlement pass).
-- Unknown costs past 24 hours: unchanged rules (BILL2 0.3): a model call with no final receipt is never presumed free or retried;
-- the job keeps looking it up by provider id (every 10 minutes for a day, then every 6 hours) and a call without a provider id
-- waits for review. A third-party tool's unknown cost is 0 to the user already at the close (#1512); its stop-loss share sits on
-- the opening day's row, which no longer counts once the day is over, so nothing more is released after 24 hours.
-- Locks: transaction-level row locks only (no advisory locks, no SET, no temporary tables). The claim never waits (SKIP LOCKED);
-- turn_recover and turn_close lock profile -> session -> turn -> daily_spend bucket (0421's order, as the erasure functions); a
-- resume locks profile -> session -> paused turn -> today's bucket -> the paused turn's bucket (same row unless it opened on an
-- earlier day).
-- Compatibility: one new nullable column nothing reads yet, two new functions only the recovery job calls, and turn_open behaves
-- as before when resume_of is NULL (the V2-4 code always passes NULL). Repeatable: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE.
-- Recovery: drop the two functions and restore turn_open from 0421 (only resume_of changes); the column may stay or be dropped.
BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE public.turns ADD COLUMN IF NOT EXISTS recovery_lease_until timestamptz;

CREATE OR REPLACE FUNCTION public.turn_recovery_claim(p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE live jsonb; lookup jsonb; settle jsonb; n integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN RAISE EXCEPTION 'TURN_RECOVERY_INVALID' USING ERRCODE='22023'; END IF;
  -- 1. Live turns nobody has written for a while (partial index turns_live). The lease is short: a dead instance's claim comes
  -- back after two minutes.
  WITH due AS (
    SELECT actor_id, id, state FROM turns
    WHERE ((state IN ('running','stopping') AND updated_at < now() - interval '15 minutes')
        OR (state = 'paused' AND updated_at < now() - interval '24 hours'))
      AND (recovery_lease_until IS NULL OR recovery_lease_until <= now())
    ORDER BY updated_at LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), leased AS (
    UPDATE turns t SET recovery_lease_until = now() + interval '2 minutes' FROM due
    WHERE t.actor_id = due.actor_id AND t.id = due.id
    RETURNING t.actor_id, t.id, due.state
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('actorId', actor_id, 'turnId', id,
    'action', CASE WHEN state = 'paused' THEN 'expire' ELSE 'interrupt' END, 'calls', '[]'::jsonb)), '[]'::jsonb)
  INTO live FROM leased;
  n := p_limit - jsonb_array_length(live);
  IF n = 0 THEN RETURN live; END IF;
  -- 2. Turns paused for credits with a model call whose answer was used but whose cost is not final: its cost is looked up
  -- (the job records the receipt), so a resume after a top-up is not held until the 24-hour expiry. Every two minutes.
  WITH due AS (
    SELECT t.actor_id, t.id FROM turns t
    WHERE t.state = 'paused' AND t.updated_at >= now() - interval '24 hours'
      AND (t.recovery_lease_until IS NULL OR t.recovery_lease_until <= now())
      AND EXISTS (SELECT 1 FROM turn_calls k WHERE k.turn_id = t.id AND k.call_kind = 'model'
        AND k.status IN ('dispatched','identified') AND k.provider_id IS NOT NULL)
    ORDER BY t.recovery_lease_until NULLS FIRST, t.updated_at LIMIT n
    FOR UPDATE OF t SKIP LOCKED
  ), leased AS (
    UPDATE turns t SET recovery_lease_until = now() + interval '2 minutes'
    FROM due WHERE t.actor_id = due.actor_id AND t.id = due.id
    RETURNING t.actor_id, t.id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('actorId', l.actor_id, 'turnId', l.id, 'action', 'lookup',
    'calls', (SELECT coalesce(jsonb_agg(jsonb_build_object('seq', k.seq, 'providerId', k.provider_id,
        'model', coalesce(t.policy->'models'->>(k.model_id::text), t.policy->>'model'),
        'pricing', coalesce(t.policy->'pricings'->(k.model_id::text), t.policy->'pricing'),
        'upperUsd', k.upper_usd::text) ORDER BY k.seq), '[]'::jsonb)
      FROM turn_calls k JOIN turns t ON t.actor_id = l.actor_id AND t.id = k.turn_id
      WHERE k.turn_id = l.id AND k.call_kind = 'model' AND k.status IN ('dispatched','identified') AND k.provider_id IS NOT NULL))),
    '[]'::jsonb)
  INTO lookup FROM leased l;
  n := n - jsonb_array_length(lookup);
  IF n = 0 THEN RETURN live || lookup; END IF;
  -- 3. Closed turns still settling (partial index turns_settlement_pending), least recently tried first: a final receipt that
  -- arrived after the last pass, or an unknown model cost whose provider id can be looked up. The lease is the lookup interval.
  WITH due AS (
    SELECT t.actor_id, t.id, t.closed_at FROM turns t
    WHERE t.settlement = 'pending' AND t.state = 'closed'
      AND (t.recovery_lease_until IS NULL OR t.recovery_lease_until <= now())
      AND EXISTS (SELECT 1 FROM turn_calls k WHERE k.turn_id = t.id
        AND ((k.cost_pending AND k.provider_id IS NOT NULL AND k.call_kind = 'model')
          OR (NOT k.cost_pending AND k.settled_at > t.updated_at)))
    ORDER BY t.recovery_lease_until NULLS FIRST, t.updated_at LIMIT n
    FOR UPDATE OF t SKIP LOCKED
  ), leased AS (
    UPDATE turns t SET recovery_lease_until = now()
      + CASE WHEN due.closed_at > now() - interval '24 hours' THEN interval '10 minutes' ELSE interval '6 hours' END
    FROM due WHERE t.actor_id = due.actor_id AND t.id = due.id
    RETURNING t.actor_id, t.id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('actorId', l.actor_id, 'turnId', l.id, 'action', 'settle',
    'calls', (SELECT coalesce(jsonb_agg(jsonb_build_object('seq', k.seq, 'providerId', k.provider_id,
        -- The model and price table frozen at open (a multi-model kind freezes them per model id), never the catalog's current
        -- values: an edited model slug or price must not change how an old call is matched or priced.
        'model', coalesce(t.policy->'models'->>(k.model_id::text), t.policy->>'model'),
        'pricing', coalesce(t.policy->'pricings'->(k.model_id::text), t.policy->'pricing'),
        'upperUsd', k.upper_usd::text) ORDER BY k.seq), '[]'::jsonb)
      FROM turn_calls k JOIN turns t ON t.actor_id = l.actor_id AND t.id = k.turn_id WHERE k.turn_id = l.id AND k.cost_pending AND k.provider_id IS NOT NULL AND k.call_kind = 'model'))),
    '[]'::jsonb)
  INTO settle FROM leased l;
  RETURN live || lookup || settle;
END $function$;

CREATE OR REPLACE FUNCTION public.turn_recover(p_actor_id uuid, p_turn_id bigint, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; s runtime_sessions; result jsonb;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('interrupt','expire','settle') THEN
    RAISE EXCEPTION 'TURN_RECOVERY_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id;
  IF t.id IS NULL THEN RAISE EXCEPTION 'TURN_DENIED' USING ERRCODE='42501'; END IF;
  -- Lock order as turn_close: the profile, the session, then the turn.
  PERFORM 1 FROM profiles WHERE id = p_actor_id FOR UPDATE;
  IF t.session_id IS NOT NULL THEN SELECT * INTO s FROM runtime_sessions WHERE id = t.session_id FOR UPDATE; END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id FOR UPDATE;
  -- Re-checked under the locks; turn_close is the only state change.
  IF p_action = 'interrupt' AND t.state IN ('running','stopping') AND t.updated_at < now() - interval '15 minutes' THEN
    -- A report its user was stopping closes as stopped (the 24-hour stop rule applies); anything else as interrupted: the known
    -- receipts settle, an unknown cost keeps its share of the freeze for the settlement pass.
    result := public.turn_close(p_actor_id, p_turn_id, CASE WHEN t.state = 'stopping' THEN 'stopped' ELSE 'interrupted' END,
      '[]'::jsonb, false, false, 'recovery_interrupted');
  ELSIF p_action = 'expire' AND t.state = 'paused' AND t.updated_at < now() - interval '24 hours' THEN
    -- Owner 10-25/10-27: a paused turn that delivered nothing for 24 hours is refunded in full (expired, not delivered: D = 0);
    -- refund_all stays false so a jury is charged by its own rule in turn_user_charge (V2-7b).
    result := public.turn_close(p_actor_id, p_turn_id, 'expired', '[]'::jsonb, false, false, 'recovery_expired');
  ELSIF p_action = 'settle' AND t.state = 'closed' AND t.settlement = 'pending' THEN
    -- The settlement pass of a closed turn (#1512): what became known since the last pass, counted once. The lease stays: the
    -- next lookup of what is still unknown waits for it.
    RETURN public.turn_close(p_actor_id, p_turn_id, t.close_kind) || jsonb_build_object('action', p_action);
  ELSE
    UPDATE turns SET recovery_lease_until = NULL WHERE actor_id = p_actor_id AND id = p_turn_id;
    RETURN jsonb_build_object('turnId', t.id, 'action', p_action, 'skipped', true, 'state', t.state, 'settlement', t.settlement);
  END IF;
  -- Closed now: a cost still unknown is claimed again for the settlement pass without waiting for this lease.
  UPDATE turns SET recovery_lease_until = NULL WHERE actor_id = p_actor_id AND id = p_turn_id;
  RETURN result || jsonb_build_object('action', p_action);
END $function$;

-- The resume check of turn_open (kept out of it so turn_open only dispatches): the session's active turn, paused for credits, of
-- the same kind; the new limits within what it has left; returns the credits it carries (D = min(N, H) it would charge now).
CREATE OR REPLACE FUNCTION public.turn_resume_carry(p_actor_id uuid, p_session_id uuid, p_active_turn_id bigint, p_resume_of bigint,
  p_kind text, p_policy jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE prior turns; n_model integer; n_paid integer; n_free integer; n_decision integer; carried integer;
BEGIN
  -- Resume (2.2): only this session's turn paused for credits, by the same kind. Locked after the session (as turn_close).
  IF p_active_turn_id IS DISTINCT FROM p_resume_of THEN RAISE EXCEPTION 'TURN_RESUME_DENIED' USING ERRCODE='55000'; END IF;
  SELECT * INTO prior FROM turns WHERE actor_id = p_actor_id AND id = p_resume_of FOR UPDATE;
  IF prior.id IS NULL OR prior.state IS DISTINCT FROM 'paused' OR prior.pause_reason IS DISTINCT FROM 'waiting_credits'
    OR prior.kind <> p_kind OR prior.session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'TURN_RESUME_DENIED' USING ERRCODE='55000';
  END IF;
  -- A model call whose cost is not final yet would be lost to the carry (the paused turn is refunded in full when it closes):
  -- the resume waits until its receipt arrives. A third-party tool's unknown cost is 0 to the user (2.5.2), so it does not wait.
  IF EXISTS (SELECT 1 FROM turn_calls WHERE turn_id = p_resume_of AND call_kind = 'model'
             AND status IN ('dispatched','identified','unknown')) THEN
    RAISE EXCEPTION 'TURN_RESUME_COST_PENDING' USING ERRCODE='55000';
  END IF;
  -- What is left of the paused turn's frozen limits, counted as turn_call_begin counts them: the new turn may use no more.
  SELECT count(*) FILTER (WHERE call_kind = 'model'),
         count(*) FILTER (WHERE call_kind = 'tool' AND upper_usd > 0),
         count(*) FILTER (WHERE call_kind = 'tool' AND upper_usd = 0),
         count(*) FILTER (WHERE call_kind = 'decision')
    INTO n_model, n_paid, n_free, n_decision
  FROM turn_calls WHERE turn_id = p_resume_of AND status NOT IN ('not_sent','rejected','no_charge_402');
  IF (p_policy->'limits'->>'model')::int > (prior.policy->'limits'->>'model')::int - n_model
    OR (p_policy->'limits'->>'paidTools')::int > (prior.policy->'limits'->>'paidTools')::int - n_paid
    OR (p_policy->'limits'->>'freeTools')::int > (prior.policy->'limits'->>'freeTools')::int - n_free
    OR coalesce((p_policy->'limits'->>'decisions')::int, 0) > coalesce((prior.policy->'limits'->>'decisions')::int, 0) - n_decision THEN
    RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
  END IF;
  -- What the paused turn would charge now (D = min(N, H), N over its known receipts plus what it carried itself). It is not
  -- charged there: it is carried into the turn that continues it and settled with it, once, by that turn's rule (a fixed
  -- price stays the fixed price; an expiry refunds the whole chain).
  SELECT least(ceil((prior.policy->>'q')::numeric * coalesce(sum(nominal_usd * multiplier)
           FILTER (WHERE status = 'ok' AND call_kind <> 'decision'), 0))::integer
           + coalesce((prior.policy->>'carriedCredits')::int, 0),
         prior.reserved_credits + coalesce((prior.policy->>'carriedCredits')::int, 0))
    INTO carried
  FROM turn_calls WHERE turn_id = p_resume_of;
  RETURN carried;
END $function$;

CREATE OR REPLACE FUNCTION public.turn_open(p_actor_id uuid, p_session_id uuid, p_request_id uuid, p_kind text, p_policy jsonb, p_resume_of bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  s runtime_sessions; t turns; prof profiles; existing turns;
  v_day date := (now() AT TIME ZONE 'UTC')::date; v_bucket smallint; total numeric; band numeric;
  u_turn numeric; g integer; h integer; available integer; hold uuid; frozen jsonb; history jsonb;
  carried integer := 0;
BEGIN
  IF p_kind NOT IN ('chat','mentor','report','compare','jury','jury_adopt','review') THEN
    RAISE EXCEPTION 'TURN_KIND_INVALID' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(p_policy) <> 'object'
    OR jsonb_typeof(p_policy->'q') <> 'number' OR (p_policy->>'q')::numeric <= 0
    OR jsonb_typeof(p_policy->'uTurnUsd') <> 'number' OR (p_policy->>'uTurnUsd')::numeric < 0
    OR jsonb_typeof(p_policy->'gCredits') <> 'number' OR (p_policy->>'gCredits')::numeric <> floor((p_policy->>'gCredits')::numeric)
    OR (p_policy->>'gCredits')::numeric < 0
    OR jsonb_typeof(p_policy->'minCredits') <> 'number' OR (p_policy->>'minCredits')::numeric < 0
    OR jsonb_typeof(p_policy->'historyItems') <> 'number' OR (p_policy->>'historyItems')::numeric NOT BETWEEN 0 AND 200
    OR jsonb_typeof(p_policy->'limits') <> 'object'
    OR coalesce((p_policy->'limits'->>'model')::numeric, 0) < 1
    OR coalesce((p_policy->'limits'->>'paidTools')::numeric, -1) < 0
    OR coalesce((p_policy->'limits'->>'freeTools')::numeric, -1) < 0
    OR coalesce((p_policy->'limits'->>'decisions')::numeric, 0) < 0
    OR jsonb_typeof(p_policy->'stopLoss') <> 'object'
    OR coalesce((p_policy->'stopLoss'->>'limitUsd')::numeric, 0) <= 0
    OR coalesce((p_policy->'stopLoss'->>'p')::numeric, 0) < 1
    OR coalesce((p_policy->'stopLoss'->>'poolSize')::numeric, 0) < 1
    OR coalesce((p_policy->'stopLoss'->>'uFastUsd')::numeric, -1) < 0
    OR coalesce((p_policy->'stopLoss'->>'uBigUsd')::numeric, -1) < 0
    OR p_policy ?| ARRAY['day','bucket','holdId','heldCredits','carriedCredits'] THEN
    RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
  END IF;

  -- 1. The account row first, then the session: one turn at a time per conversation (3a). The account comes first as in the
  -- erasure functions (they hold it before the session), so an open and a deletion of the same conversation never deadlock.
  SELECT * INTO prof FROM profiles WHERE id = p_actor_id FOR UPDATE;
  SELECT * INTO s FROM runtime_sessions WHERE id = p_session_id AND actor_id = p_actor_id FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'TURN_SESSION_DENIED' USING ERRCODE='42501'; END IF;
  -- 2. The same request again: the turn it opened, unchanged.
  SELECT * INTO existing FROM turns WHERE actor_id = p_actor_id AND request_id = p_request_id;
  IF existing.id IS NOT NULL THEN
    IF existing.session_id IS DISTINCT FROM p_session_id OR existing.kind <> p_kind
      OR existing.resume_of IS DISTINCT FROM p_resume_of THEN
      RAISE EXCEPTION 'TURN_REQUEST_CONFLICT' USING ERRCODE='22023';
    END IF;
    -- A replay reads the history too: a deleted conversation or an erasing account is refused here as for a new request,
    -- so the same old request can never read back deleted content (as runtime_session_context).
    IF s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'TURN_SESSION_ERASED' USING ERRCODE='42501'; END IF;
    IF prof.id IS NULL OR prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false'
      OR EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_actor_id) THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_ERASING' USING ERRCODE='42501';
    END IF;
    t := existing;
  ELSE
    IF s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'TURN_SESSION_ERASED' USING ERRCODE='42501'; END IF;
    IF EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_actor_id) THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_ERASING' USING ERRCODE='42501';
    END IF;
    IF p_resume_of IS NULL THEN
      IF s.active_turn_id IS NOT NULL THEN RAISE EXCEPTION 'TURN_SESSION_BUSY' USING ERRCODE='55P03'; END IF;
    ELSE
      -- Resume (V2-8): the paused turn is checked, locked and priced by turn_resume_carry.
      carried := public.turn_resume_carry(p_actor_id, p_session_id, s.active_turn_id, p_resume_of, p_kind, p_policy);
    END IF;
    -- The same account check as bill2_actor: active and not deleted.
    IF prof.id IS NULL OR prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_DENIED' USING ERRCODE='42501';
    END IF;

    -- 3. Stop-loss (2.5.1): reserve U_turn on the own bucket row first, then read the day's sum, then check with the band B.
    -- On a resume the paused turn's reservation is still counted here (it is released by its close below): refusing earlier,
    -- never later.
    IF (p_policy->'stopLoss'->>'p')::int < (p_policy->'stopLoss'->>'poolSize')::int THEN
      RAISE EXCEPTION 'TURN_STOP_LOSS_CONFIG' USING ERRCODE='22023';
    END IF;
    u_turn := (p_policy->>'uTurnUsd')::numeric;
    v_bucket := CASE WHEN p_kind IN ('report','compare','jury','jury_adopt') THEN -1 ELSE abs(hashtext(p_actor_id::text)) % 16 END;
    INSERT INTO daily_spend AS d (day, bucket, reserved_usd) VALUES (v_day, v_bucket, u_turn)
      ON CONFLICT (day, bucket) DO UPDATE SET reserved_usd = d.reserved_usd + excluded.reserved_usd;
    SELECT sum(reserved_usd + spent_usd) INTO total FROM daily_spend WHERE daily_spend.day = v_day;
    band := ((p_policy->'stopLoss'->>'p')::numeric - 1) * (p_policy->'stopLoss'->>'uFastUsd')::numeric
      + (p_policy->'stopLoss'->>'uBigUsd')::numeric;
    IF total + band > (p_policy->'stopLoss'->>'limitUsd')::numeric THEN
      RAISE EXCEPTION 'STOP_LOSS_REACHED' USING ERRCODE='P0001';
    END IF;

    -- The paused turn closes before the new freeze is sized: its whole freeze comes back (refund_all; what it would have charged
    -- is carried above) and counts in the balance read below. Its receipts stay its own for the stop-loss. Not delivered, no
    -- messages: the turn that continues it saves the conversation.
    IF p_resume_of IS NOT NULL THEN
      PERFORM public.turn_close(p_actor_id, p_resume_of, 'failed', '[]'::jsonb, false, true, 'resumed');
      -- What it carries is not borne by the platform: only what the chain finally does not charge is recorded as absorbed.
      UPDATE turns SET absorbed_credits = greatest(absorbed_credits - carried, 0)
        WHERE actor_id = p_actor_id AND id = p_resume_of AND absorbed_credits IS NOT NULL;
    END IF;

    -- 4. Credits: H = min(G_turn, available); below the start threshold the turn does not open. The balance is read under the
    -- account lock taken first: two sessions of one account in different stop-loss buckets never size H on the same balance.
    -- The account is checked again here (same lock) before anything is frozen.
    SELECT * INTO prof FROM profiles WHERE id = p_actor_id;
    IF prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false'
      OR EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_actor_id) THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_ERASING' USING ERRCODE='42501';
    END IF;
    -- The freeze covers the carried credits too (the continuation settles them).
    g := (p_policy->>'gCredits')::int + carried;
    available := greatest(public.credit_available(p_actor_id), 0);
    -- The balance, not the freeze, is held against the start threshold L (as bill2_payg_claim): a balance that covers one
    -- normal turn starts it, and the freeze H may be below L when one call's bound G is (Owner 10-28, restating 10-01).
    -- On a resume the carried credits are owed already: the balance left after them must still cover one normal turn.
    IF available - carried < (p_policy->>'minCredits')::int THEN RAISE EXCEPTION 'TURN_INSUFFICIENT_CREDITS' USING ERRCODE='P0001'; END IF;
    h := least(g, available);
    IF h > 0 THEN
      SELECT pre_deduct_id INTO hold FROM public.atomic_pre_deduct(p_actor_id, h, 'AI turn freeze', p_request_id);
    END IF;

    frozen := p_policy || jsonb_build_object('day', v_day, 'bucket', v_bucket, 'holdId', hold, 'heldCredits', h)
      || CASE WHEN carried > 0 THEN jsonb_build_object('carriedCredits', carried) ELSE '{}'::jsonb END;
    INSERT INTO turns (actor_id, session_id, request_id, kind, state, resume_of, policy, reserved_credits, reserved_usd, input_bytes)
      -- reserved_credits is the freeze this turn's calls may use (turn_call_begin pauses on it); the carried part is added back
      -- at the close (turn_close), and the hold itself is the whole H (policy.heldCredits).
      VALUES (p_actor_id, p_session_id, p_request_id, p_kind, 'running', p_resume_of, frozen, h - carried, u_turn,
        (p_policy->>'inputBytes')::int)
      RETURNING * INTO t;
    UPDATE runtime_sessions SET active_turn_id = t.id WHERE id = s.id;
  END IF;

  -- 5. The visible history, newest N in order.
  SELECT coalesce(jsonb_agg(jsonb_build_object('seq', m.seq, 'role', m.role, 'content', m.content, 'contentHash', m.content_hash)
    ORDER BY m.seq), '[]'::jsonb) INTO history
  FROM (SELECT seq, role, content, content_hash FROM session_messages
        WHERE session_id = p_session_id AND visible AND deleted_at IS NULL
        ORDER BY seq DESC LIMIT (t.policy->>'historyItems')::int) m;
  -- 6. What the turn's prompt needs from the account, read here instead of in more round trips: the reply language and, for a
  -- free chat, the positioning gate (confirmed positioning; refusals in 24 hours, counted on the turns refused for it).
  RETURN jsonb_build_object('turnId', t.id, 'state', t.state, 'replay', existing.id IS NOT NULL,
    'reservedCredits', t.reserved_credits, 'reservedUsd', t.reserved_usd, 'history', history, 'resumeOf', t.resume_of,
    'replyLanguage', prof.reply_language,
    'positioning', CASE WHEN p_kind = 'chat' THEN jsonb_build_object(
      'positioned', public.opc_has_confirmed_positioning(p_actor_id),
      'refusals24h', (SELECT count(*) FROM turns r WHERE r.actor_id = p_actor_id AND r.failure_code = 'positioning_required'
        AND r.closed_at > now() - interval '24 hours')) END,
    -- Per-kind context for the prompt (2.7). Each kind reads its input from p_policy->'<kind>' and adds its own branch here
    -- (CASE p_kind WHEN '<kind>' THEN public.turn_<kind>_context(...) END); no kind has one yet.
    'kindContext', NULL::jsonb);
END $function$;

-- turn_close as of 0421 (#1512/#1516), whole, with one change: the credits a resumed turn carried (policy.carriedCredits, set
-- only by turn_open) are added to N and to H (reserved_credits leaves them out) in both the close and the settlement pass.
CREATE OR REPLACE FUNCTION public.turn_close(p_actor_id uuid, p_turn_id bigint, p_close_kind text, p_messages jsonb DEFAULT '[]'::jsonb, p_delivered boolean DEFAULT false, p_refund_all boolean DEFAULT false, p_failure_code text DEFAULT NULL::text, p_kind_result jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  t turns; s runtime_sessions; q numeric; n_total numeric; pending_upper numeric; credits integer; charge integer; h integer;
  v_kind text := p_close_kind; tomb jsonb; next_seq integer; msg jsonb; pending boolean; user_pending boolean;
  marker timestamptz;
BEGIN
  IF p_close_kind NOT IN ('completed','stopped','failed','interrupted','expired','erased') THEN
    RAISE EXCEPTION 'TURN_CLOSE_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id;
  IF t.id IS NULL THEN RAISE EXCEPTION 'TURN_DENIED' USING ERRCODE='42501'; END IF;
  -- Lock order: the profile, the session, the turn, then the stop-loss bucket (as turn_open and the erasure functions). The
  -- profile also serializes the actor's closes (the free-stop count) before the settlement locks it again.
  PERFORM 1 FROM profiles WHERE id = p_actor_id FOR UPDATE;
  IF t.session_id IS NOT NULL THEN SELECT * INTO s FROM runtime_sessions WHERE id = t.session_id FOR UPDATE; END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id FOR UPDATE;
  IF t.state = 'closed' THEN
    -- Closed with a provider cost still unknown: calling turn_close again settles what has become known since (recovery, a late
    -- receipt). The close itself (kind, messages) is kept; each receipt is counted once, by settled_at after the last pass
    -- (both stamped with clock_timestamp under this turn's row lock, so a receipt and a pass never miss each other).
    IF t.settlement = 'pending' THEN
      marker := clock_timestamp();
      SELECT coalesce(sum(nominal_usd) FILTER (WHERE status = 'ok'), 0) + coalesce(sum(actual_usd) FILTER (WHERE status = 'unusable'), 0),
             coalesce(sum(upper_usd), 0)
        INTO n_total, pending_upper
      FROM turn_calls WHERE turn_id = p_turn_id AND NOT cost_pending AND settled_at > t.updated_at;
      UPDATE daily_spend SET spent_usd = spent_usd + n_total, reserved_usd = greatest(reserved_usd - pending_upper, 0)
        WHERE day = (t.policy->>'day')::date AND bucket = (t.policy->>'bucket')::smallint;
      q := (t.policy->>'q')::numeric;
      -- The user's base is what it was at the close plus the late model receipts: a tool whose result was unknown at the close
      -- stays 0 to the user (2.5.2) however late its receipt comes; only its cost goes to the stop-loss above.
      SELECT ceil(q * coalesce(sum(nominal_usd * multiplier) FILTER (WHERE status = 'ok' AND call_kind <> 'decision'
               AND NOT (call_kind = 'tool' AND settled_at > t.closed_at)), 0))::integer,
             coalesce(bool_or(cost_pending), false), coalesce(bool_or(cost_pending AND call_kind = 'model'), false)
        INTO credits, pending, user_pending
      FROM turn_calls WHERE turn_id = p_turn_id;
      credits := credits + coalesce((t.policy->>'carriedCredits')::int, 0);
      IF t.charged_credits IS NULL AND NOT user_pending THEN
        charge := public.turn_user_charge(p_actor_id, p_turn_id, t.close_kind, t.delivered,
          coalesce((t.policy->>'closeRefundAll')::boolean, false), credits,
          t.reserved_credits + coalesce((t.policy->>'carriedCredits')::int, 0), (t.policy->>'fixedCredits')::int, t.closed_at);
        IF t.policy->>'holdId' IS NOT NULL THEN
          PERFORM public.turn_settle_credits(p_actor_id, (t.policy->>'holdId')::uuid, charge, p_turn_id);
        END IF;
        t.charged_credits := charge; t.absorbed_credits := greatest(credits - charge, 0);
      END IF;
      UPDATE turns SET charged_credits = t.charged_credits, absorbed_credits = t.absorbed_credits,
          settlement = CASE WHEN pending THEN 'pending' ELSE 'done' END, updated_at = marker
        WHERE actor_id = p_actor_id AND id = p_turn_id RETURNING * INTO t;
    END IF;
    RETURN jsonb_build_object('turnId', t.id, 'closeKind', t.close_kind, 'chargedCredits', t.charged_credits,
      'absorbedCredits', t.absorbed_credits, 'settlement', t.settlement, 'replay', true);
  END IF;
  -- Only a report can be stopped by its user (Owner 10-28).
  IF v_kind = 'stopped' AND t.kind <> 'report' THEN RAISE EXCEPTION 'TURN_STOP_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
  IF p_refund_all AND v_kind NOT IN ('failed','expired','erased') THEN RAISE EXCEPTION 'TURN_CLOSE_INVALID' USING ERRCODE='22023'; END IF;
  -- A tombstone wins: nothing is saved and the turn closes as erased.
  tomb := turn_tombstones(p_actor_id, t.session_id, t.policy);
  IF v_kind IN ('completed','stopped') AND ((tomb->>'sessionTombstoned')::boolean OR (tomb->>'accountErasing')::boolean
    OR (tomb->>'voiceSourceRevoked')::boolean) THEN v_kind := 'erased'; END IF;
  -- The per-kind hook: what a kind keeps from its result (a draft, a report, a verdict) is written in the same transaction as the
  -- close, by that kind's own function (e.g. turn_mentor_apply(t, v_kind, p_kind_result)), one branch per kind:
  --   IF t.kind = '<kind>' THEN PERFORM public.turn_<kind>_apply(...); ELSE ... END IF;
  -- No kind has one yet, so a result is refused rather than dropped.
  IF p_kind_result IS NOT NULL THEN
    RAISE EXCEPTION 'TURN_KIND_RESULT_UNSUPPORTED' USING ERRCODE='22023';
  END IF;

  -- Calls without a final receipt: their cost is unknown; it is never presumed zero and never retried (2.5.2).
  UPDATE turn_calls SET status = 'unknown', cost_pending = true
   WHERE turn_id = p_turn_id AND status IN ('dispatched','identified');
  q := (t.policy->>'q')::numeric;
  -- N = ceil(q x sum(n_i x m_i)) over the known receipts the user pays for (never the positioning check); n_total is the provider
  -- cost of every receipt, the positioning check and the platform-paid unusable results included, which the stop-loss counts.
  SELECT ceil(q * coalesce(sum(nominal_usd * multiplier) FILTER (WHERE status = 'ok' AND call_kind <> 'decision'), 0))::integer,
         coalesce(sum(nominal_usd) FILTER (WHERE status = 'ok'), 0) + coalesce(sum(actual_usd) FILTER (WHERE status = 'unusable'), 0),
         coalesce(sum(upper_usd) FILTER (WHERE cost_pending), 0),
         coalesce(bool_or(cost_pending), false),
         -- Only an unknown model call holds the user's settlement: a third-party tool whose result is unknown is 0 to the user
         -- (Owner 10-13, plan 2.5.2) and the positioning check is never theirs; both keep only the provider cost pending.
         coalesce(bool_or(cost_pending AND call_kind = 'model'), false)
    INTO credits, n_total, pending_upper, pending, user_pending
  FROM turn_calls WHERE turn_id = p_turn_id;
  -- Credits a resumed turn carried from the turn it continues (V2-8): settled here, once, under this turn's rule.
  credits := credits + coalesce((t.policy->>'carriedCredits')::int, 0);
  -- H: the whole hold, the carried credits included (reserved_credits leaves them out for the calls' own checks).
  h := t.reserved_credits + coalesce((t.policy->>'carriedCredits')::int, 0);

  -- Stop-loss: what is known is spent; the reservation of calls with an unknown cost stays until recovery settles them.
  UPDATE daily_spend SET spent_usd = spent_usd + n_total,
      reserved_usd = greatest(reserved_usd - (t.reserved_usd - pending_upper), 0)
    WHERE day = (t.policy->>'day')::date AND bucket = (t.policy->>'bucket')::smallint;

  -- What the user pays (turn_user_charge: D = min(N, H), the stop and fixed-price rules).
  -- One instant for this close, taken under the account lock: the stop count, closed_at and the settlement pass all use it, so a
  -- concurrent close of the same actor that committed first is always before it, and a later settlement counts the same.
  marker := clock_timestamp();
  charge := public.turn_user_charge(p_actor_id, p_turn_id, v_kind, p_delivered, p_refund_all, credits, h,
    (t.policy->>'fixedCredits')::int, marker);

  -- Credits: settled once; with an unknown model cost the whole freeze waits for recovery (one freeze is settled exactly once).
  -- settlement stays 'pending' while any provider cost is unknown, so recovery still settles the stop-loss; a repeated credit
  -- settlement of the same freeze returns the first one.
  IF NOT user_pending AND t.policy->>'holdId' IS NOT NULL THEN
    PERFORM public.turn_settle_credits(p_actor_id, (t.policy->>'holdId')::uuid, charge, p_turn_id);
  END IF;

  -- The messages of a delivered turn, appended in order.
  IF v_kind IN ('completed','stopped') AND t.session_id IS NOT NULL AND jsonb_typeof(p_messages) = 'array' THEN
    SELECT coalesce(max(seq), 0) INTO next_seq FROM session_messages WHERE session_id = t.session_id;
    FOR msg IN SELECT value FROM jsonb_array_elements(p_messages) LOOP
      next_seq := next_seq + 1;
      INSERT INTO session_messages (session_id, seq, role, turn_id, content, content_hash)
        VALUES (t.session_id, next_seq, msg->>'role', p_turn_id, msg->>'content', encode(sha256(convert_to(msg->>'content', 'UTF8')), 'hex'));
    END LOOP;
  END IF;

  -- updated_at marks this settlement pass (see the closed branch above); a full refund still owed is kept with the turn.
  UPDATE turns SET state = 'closed', pause_reason = NULL, close_kind = v_kind, closed_at = marker, updated_at = marker,
      policy = CASE WHEN user_pending AND p_refund_all THEN policy || '{"closeRefundAll": true}'::jsonb ELSE policy END,
      charged_credits = CASE WHEN user_pending THEN NULL ELSE charge END,
      absorbed_credits = CASE WHEN user_pending THEN NULL ELSE greatest(credits - charge, 0) END,
      settlement = CASE WHEN pending THEN 'pending' ELSE 'done' END,
      stopped_by_user = (v_kind = 'stopped'), delivered = p_delivered AND v_kind IN ('completed','stopped'),
      failure_code = p_failure_code
    WHERE actor_id = p_actor_id AND id = p_turn_id RETURNING * INTO t;
  IF s.id IS NOT NULL AND s.active_turn_id = p_turn_id THEN UPDATE runtime_sessions SET active_turn_id = NULL WHERE id = s.id; END IF;
  RETURN jsonb_build_object('turnId', t.id, 'closeKind', t.close_kind, 'chargedCredits', t.charged_credits,
    'absorbedCredits', t.absorbed_credits, 'settlement', t.settlement, 'replay', false) || tomb;
END $function$;

DO $$
DECLARE f text;
BEGIN
  -- Only the service role's recovery job runs the two new functions.
  FOREACH f IN ARRAY ARRAY['turn_recovery_claim(integer)', 'turn_recover(uuid,bigint,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated, service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
  -- The resume check is an internal helper of turn_open.
  EXECUTE 'REVOKE ALL ON FUNCTION public.turn_resume_carry(uuid,uuid,bigint,bigint,text,jsonb) FROM PUBLIC, anon, authenticated, service_role';
END $$;

COMMIT;
