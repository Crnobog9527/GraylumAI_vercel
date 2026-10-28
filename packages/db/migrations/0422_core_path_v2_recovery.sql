-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-8 (number provisional until the controller assigns it): pause, resume and the recovery job on the 0420 turns
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
--   turn_recover        one turn, one short transaction: locks session then turn (as turn_close), re-checks under the locks that
--                       the work is still due (a resume, a late write or another instance may have moved it), then calls
--                       turn_close, the only function that changes a turn's state: interrupted (stopped for a report that was
--                       stopping), expired (paused 24 hours: D = 0, the whole freeze back), or the closed-turn settlement pass
--                       of #1512 (what became known since, counted once). Idempotent: anything not due is skipped.
--   turn_open           resume_of (2.2, 2.5 "充值后继续"): a turn paused for credits continues as a new turn of the same session and
--                       kind. In one transaction: the stop-loss reserves the new bound, the paused turn closes (interrupted,
--                       failure_code resumed) and settles its known receipts (the work already done is charged once, the rest
--                       of its freeze comes back), the new turn freezes H = min(G, available) for what is left of the paused
--                       turn's call limits (never more), and the session moves to it. Anything refused (credits still short,
--                       stop-loss) rolls the whole resume back: the turn stays paused. Everything else in turn_open is unchanged.
-- Unknown costs past 24 hours: unchanged rules (BILL2 0.3): a model call with no final receipt is never presumed free or retried;
-- the job keeps looking it up by provider id (every 10 minutes for a day, then every 6 hours) and a call without a provider id
-- waits for review. A third-party tool's unknown cost is 0 to the user already at the close (#1512); its stop-loss share sits on
-- the opening day's row, which no longer counts once the day is over, so nothing more is released after 24 hours.
-- Locks: transaction-level row locks only (no advisory locks, no SET, no temporary tables). The claim never waits (SKIP LOCKED);
-- turn_recover and turn_close lock session -> turn -> daily_spend bucket -> profile; a resume locks session -> paused turn ->
-- today's bucket -> the paused turn's bucket (same row unless it opened on an earlier day) -> profile.
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
DECLARE live jsonb; settle jsonb; n integer;
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
  -- 2. Closed turns still settling (partial index turns_settlement_pending), least recently tried first: a final receipt that
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
        'model', (SELECT a.model_id FROM ai_models a WHERE a.id = k.model_id), 'upperUsd', k.upper_usd) ORDER BY k.seq), '[]'::jsonb)
      FROM turn_calls k WHERE k.turn_id = l.id AND k.cost_pending AND k.provider_id IS NOT NULL AND k.call_kind = 'model'))),
    '[]'::jsonb)
  INTO settle FROM leased l;
  RETURN live || settle;
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
  -- Lock order as turn_close: session, then the turn.
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

CREATE OR REPLACE FUNCTION public.turn_open(p_actor_id uuid, p_session_id uuid, p_request_id uuid, p_kind text, p_policy jsonb,
  p_resume_of bigint DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  s runtime_sessions; t turns; prof profiles; existing turns; prior turns;
  v_day date := (now() AT TIME ZONE 'UTC')::date; v_bucket smallint; total numeric; band numeric;
  u_turn numeric; g integer; h integer; available integer; hold uuid; frozen jsonb; history jsonb;
  n_model integer; n_paid integer; n_free integer; n_decision integer;
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
    OR p_policy ?| ARRAY['day','bucket','holdId','heldCredits'] THEN
    RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
  END IF;

  -- 1. The session, locked: one turn at a time per conversation (3a).
  SELECT * INTO s FROM runtime_sessions WHERE id = p_session_id AND actor_id = p_actor_id FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'TURN_SESSION_DENIED' USING ERRCODE='42501'; END IF;
  SELECT * INTO prof FROM profiles WHERE id = p_actor_id;
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
      -- Resume (2.2): only this session's turn paused for credits, by the same kind. Locked after the session (as turn_close).
      IF s.active_turn_id IS DISTINCT FROM p_resume_of THEN RAISE EXCEPTION 'TURN_RESUME_DENIED' USING ERRCODE='55000'; END IF;
      SELECT * INTO prior FROM turns WHERE actor_id = p_actor_id AND id = p_resume_of FOR UPDATE;
      IF prior.id IS NULL OR prior.state IS DISTINCT FROM 'paused' OR prior.pause_reason IS DISTINCT FROM 'waiting_credits'
        OR prior.kind <> p_kind OR prior.session_id IS DISTINCT FROM p_session_id THEN
        RAISE EXCEPTION 'TURN_RESUME_DENIED' USING ERRCODE='55000';
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

    -- The paused turn closes before the new freeze is sized: its known receipts are charged once (the work done before the
    -- pause), the rest of its freeze comes back and counts in the balance read below. Not delivered, no messages: the turn that
    -- continues it saves the conversation.
    IF p_resume_of IS NOT NULL THEN
      PERFORM public.turn_close(p_actor_id, p_resume_of, 'interrupted', '[]'::jsonb, false, false, 'resumed');
    END IF;

    -- 4. Credits: H = min(G_turn, available); below the start threshold the turn does not open. The account row is locked before
    -- the balance is read: two sessions of one account in different stop-loss buckets would otherwise both size H on the same
    -- balance, and the second would be refused instead of freezing what is left. Order: session, bucket, account (as turn_close).
    -- Re-checked under the lock: an erasure that held it (account_erasure_confirm) may have committed while this waited.
    SELECT * INTO prof FROM profiles WHERE id = p_actor_id FOR UPDATE;
    IF prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false'
      OR EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_actor_id) THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_ERASING' USING ERRCODE='42501';
    END IF;
    g := (p_policy->>'gCredits')::int;
    available := greatest(public.credit_available(p_actor_id), 0);
    h := least(g, available);
    IF h < (p_policy->>'minCredits')::int THEN RAISE EXCEPTION 'TURN_INSUFFICIENT_CREDITS' USING ERRCODE='P0001'; END IF;
    IF h > 0 THEN
      SELECT pre_deduct_id INTO hold FROM public.atomic_pre_deduct(p_actor_id, h, 'AI turn freeze', p_request_id);
    END IF;

    frozen := p_policy || jsonb_build_object('day', v_day, 'bucket', v_bucket, 'holdId', hold, 'heldCredits', h);
    INSERT INTO turns (actor_id, session_id, request_id, kind, state, resume_of, policy, reserved_credits, reserved_usd, input_bytes)
      VALUES (p_actor_id, p_session_id, p_request_id, p_kind, 'running', p_resume_of, frozen, h, u_turn,
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

DO $$
DECLARE f text;
BEGIN
  -- Only the service role's recovery job runs the two new functions.
  FOREACH f IN ARRAY ARRAY['turn_recovery_claim(integer)', 'turn_recover(uuid,bigint,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated, service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;

COMMIT;
