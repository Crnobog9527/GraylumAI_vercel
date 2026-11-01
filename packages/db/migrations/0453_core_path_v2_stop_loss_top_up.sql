-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 stop-loss top-up (number 0453 = staging's highest + 1 with #1582's 0452 taken). Owner 11-01: "同意两项". A chat turn's U_turn
-- (11 calls x 2.83 USD + tools = 31.3) reserved at the open let only 2 to 3 turns run under staging's daily limit of 100. Same idea as 0451:
-- a chat or mentor turn opens with holdUsd (one model call, the largest paid tool, the positioning check) and turn_call_begin reserves more.
--   turn_open         reserves holdUsd or U_turn; refuses holdUsd above uFastUsd (TURN_STOP_LOSS_CONFIG): U_fast now bounds what one transaction adds.
--   turn_call_begin   when the reservation left does not cover this call's bound: own bucket, the day's sum, turn_open's check. Over the limit:
--                     STOP_LOSS_REACHED, the begin rolls back, the turn closes failed with everything refunded (Node).
-- turns.reserved_usd is now what the turn reserved so far: turn_close and turn_resume_close release it unchanged, since every call was covered.
-- Only when the reservation moves: the limit check itself is the same. Fixed-price kinds and plan carry no holdUsd.
-- Compatible: a turn without holdUsd behaves as before (old code, turns open across the apply). uFastUsd must be raised before this applies,
-- and the Node code sending holdUsd comes after it. Repeatable: CREATE OR REPLACE. Recovery: stop sending holdUsd (Node), then re-apply 0451's
-- two functions; a turn already open with holdUsd then simply stops topping up and its close still releases what it reserved.
BEGIN;
SET LOCAL lock_timeout='5s';

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
  IF p_kind NOT IN ('chat','mentor','report','plan','compare','jury','jury_adopt','review') THEN
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
    -- holdCredits: only a chat or mentor turn freezes less than G and tops up (turn_call_begin); a fixed-price kind keeps H = G.
    OR (p_policy ? 'holdCredits' AND (p_kind NOT IN ('chat','mentor') OR jsonb_typeof(p_policy->'holdCredits') <> 'number'
      OR (p_policy->>'holdCredits')::numeric <> floor((p_policy->>'holdCredits')::numeric)
      OR (p_policy->>'holdCredits')::numeric < 1 OR (p_policy->>'holdCredits')::numeric > (p_policy->>'gCredits')::numeric))
    -- holdUsd: the same for the stop-loss; only with holdCredits, never above U_turn.
    OR (p_policy ? 'holdUsd' AND (NOT p_policy ? 'holdCredits' OR jsonb_typeof(p_policy->'holdUsd') <> 'number'
      OR (p_policy->>'holdUsd')::numeric < 0 OR (p_policy->>'holdUsd')::numeric > (p_policy->>'uTurnUsd')::numeric))
    OR p_policy ?| ARRAY['day','bucket','holdId','heldCredits','carriedCredits','topUps'] THEN
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
      -- A jury (or its adoption) runs on the report's draft conversation without occupying it (V2-7b): the conversation stays
      -- usable while a review advances or waits, as before; one review per user is the review record's own rule.
      IF s.active_turn_id IS NOT NULL AND p_kind NOT IN ('jury','jury_adopt') THEN RAISE EXCEPTION 'TURN_SESSION_BUSY' USING ERRCODE='55P03'; END IF;
      -- V2-5c: the mentor's read before this turn is bound to it: a turn that closed since then makes that read stale (it could pay
      -- again for what that turn fetched, or use a grant it spent). Under this session's lock, so no close can slip in after it.
      IF p_kind = 'mentor' AND p_policy->'mentor'->>'preparedAt' IS NOT NULL AND EXISTS (SELECT 1 FROM turns x
          WHERE x.actor_id = p_actor_id AND x.session_id = p_session_id AND x.closed_at > (p_policy->'mentor'->>'preparedAt')::timestamptz) THEN
        RAISE EXCEPTION 'TURN_PREPARE_STALE' USING ERRCODE='55P03';
      END IF;
      -- V2-10b: a topic turn's request id admitted on the old path, under this session's lock (runtime_admit refuses the other way).
      -- V2-12 drops this with the old table.
      IF p_kind = 'chat' AND p_policy ? 'topic' AND EXISTS (SELECT 1 FROM runtime_executions e
          WHERE e.actor_id = p_actor_id AND e.request_id = p_request_id) THEN
        RAISE EXCEPTION 'TURN_TOPIC_REQUEST_CONFLICT' USING ERRCODE='22023';
      END IF;
    ELSE
      -- Resume (V2-8): the paused turn is checked, locked and priced by turn_resume_carry.
      carried := public.turn_resume_carry(p_actor_id, p_session_id, s.active_turn_id, p_resume_of, p_kind, p_policy);
    END IF;
    -- The same account check as bill2_actor: active and not deleted.
    IF prof.id IS NULL OR prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_DENIED' USING ERRCODE='42501';
    END IF;

    -- 3. Stop-loss (2.5.1): reserve the first reservation (U_turn, or one call's holdUsd where the turn tops up, Owner 11-01) on the
    -- own bucket row first, then read the day's sum, then check with the band B.
    -- On a resume the paused turn's reservation is still counted here (it is released by its close below): refusing earlier,
    -- never later.
    -- The band's proof needs U_fast to bound what one transaction adds, so a holdUsd above it is a configuration fault.
    IF (p_policy->'stopLoss'->>'p')::int < (p_policy->'stopLoss'->>'poolSize')::int
      OR coalesce((p_policy->>'holdUsd')::numeric, 0) > (p_policy->'stopLoss'->>'uFastUsd')::numeric THEN
      RAISE EXCEPTION 'TURN_STOP_LOSS_CONFIG' USING ERRCODE='22023';
    END IF;
    u_turn := coalesce((p_policy->>'holdUsd')::numeric, (p_policy->>'uTurnUsd')::numeric);
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
      PERFORM public.turn_resume_close(p_actor_id, p_resume_of, carried);
    END IF;

    -- 4. Credits: H = min(the first freeze, available), the first freeze being G_turn, or one call's bound where the turn tops up
    -- (Owner 11-01: "选 A 补冻"); below the start threshold the turn does not open. The balance is read under the
    -- account lock taken first: two sessions of one account in different stop-loss buckets never size H on the same balance.
    -- The account is checked again here (same lock) before anything is frozen.
    SELECT * INTO prof FROM profiles WHERE id = p_actor_id;
    IF prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false'
      OR EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_actor_id) THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_ERASING' USING ERRCODE='42501';
    END IF;
    -- The freeze covers the carried credits too (the continuation settles them).
    IF p_kind = 'report' THEN PERFORM public.turn_report_admit(p_actor_id, p_session_id, p_policy); END IF;
    g := coalesce((p_policy->>'holdCredits')::int, (p_policy->>'gCredits')::int) + carried;
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
    IF p_kind NOT IN ('jury','jury_adopt') THEN UPDATE runtime_sessions SET active_turn_id = t.id WHERE id = s.id; END IF;
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
      'positioned', public.turn_positioned(p_actor_id),
      'refusals24h', (SELECT count(*) FROM turns r WHERE r.actor_id = p_actor_id AND r.failure_code = 'positioning_required'
        AND r.closed_at > now() - interval '24 hours')) END,
    -- Per-kind context for the prompt (2.7). Each kind reads its input from p_policy->'<kind>' and adds its own branch here
    -- (CASE p_kind WHEN '<kind>' THEN public.turn_<kind>_context(...) END); no kind has one yet.
    'kindContext', CASE p_kind WHEN 'mentor' THEN public.turn_mentor_context(p_actor_id, p_session_id, p_policy->'mentor')
      WHEN 'plan' THEN public.turn_plan_context(p_actor_id, p_session_id, p_policy) END);
END $function$;;

CREATE OR REPLACE FUNCTION public.turn_call_begin(p_actor_id uuid, p_turn_id bigint, p_seq integer, p_call_kind text, p_model_id uuid, p_tool_name text, p_paid boolean, p_request_hash text, p_upper_usd numeric, p_multiplier numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; c turn_calls; q numeric; used integer; need integer; n_model integer; n_paid integer; n_free integer;
  n_decision integer; bound integer; held boolean := false; step integer; hold uuid; spent numeric; usd_step numeric; total numeric;
BEGIN
  -- A turn that tops up (holdCredits): looked at first without any lock. Only a call the freeze does not cover takes the account,
  -- so in turn_close's order (profile, session, turn); every other call never touches the profile.
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id;
  IF t.policy ? 'holdCredits' AND t.state = 'running' AND p_call_kind <> 'decision' AND public.turn_hold_short(t, p_upper_usd, p_multiplier) THEN
    PERFORM 1 FROM profiles WHERE id = p_actor_id FOR UPDATE;
    PERFORM 1 FROM runtime_sessions WHERE id = t.session_id FOR UPDATE;
    held := true;
  END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id FOR UPDATE;
  IF t.id IS NULL THEN RAISE EXCEPTION 'TURN_DENIED' USING ERRCODE='42501'; END IF;
  SELECT * INTO c FROM turn_calls WHERE turn_id = p_turn_id AND seq = p_seq;
  IF c.turn_id IS NOT NULL THEN
    IF c.request_hash <> p_request_hash THEN RAISE EXCEPTION 'TURN_CALL_CONFLICT' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('state', t.state, 'status', c.status, 'replay', true) || turn_tombstones(p_actor_id, t.session_id, t.policy);
  END IF;
  IF t.state <> 'running' THEN RAISE EXCEPTION 'TURN_NOT_RUNNING' USING ERRCODE='55000'; END IF;
  IF p_seq <> coalesce((SELECT max(seq) FROM turn_calls WHERE turn_id = p_turn_id), 0) + 1 THEN
    RAISE EXCEPTION 'TURN_CALL_SEQUENCE' USING ERRCODE='22023';
  END IF;
  IF (p_call_kind = 'tool') IS DISTINCT FROM (p_paid IS NOT NULL) THEN RAISE EXCEPTION 'TURN_CALL_INVALID' USING ERRCODE='22023'; END IF;
  -- A model whose cost went above its bound is blocked until an administrator has checked its price and metering (BILL2).
  IF p_call_kind = 'model' AND EXISTS (SELECT 1 FROM turn_calls WHERE model_id = p_model_id AND budget_conflict
      AND conflict_reviewed_at IS NULL) THEN
    RAISE EXCEPTION 'TURN_MODEL_METERING_BLOCKED' USING ERRCODE='P0001';
  END IF;
  -- Frozen limits (2.5.3): attempts that certainly cost nothing (not_sent, rejected, 402) do not count against them. M counts
  -- the model calls the user pays for; the positioning check (decision) is its own limit outside M (Fable 10-28).
  SELECT count(*) FILTER (WHERE call_kind = 'model'),
         count(*) FILTER (WHERE call_kind = 'tool' AND upper_usd > 0),
         count(*) FILTER (WHERE call_kind = 'tool' AND upper_usd = 0),
         count(*) FILTER (WHERE call_kind = 'decision')
    INTO n_model, n_paid, n_free, n_decision
  FROM turn_calls WHERE turn_id = p_turn_id AND status NOT IN ('not_sent','rejected','no_charge_402');
  IF (p_call_kind = 'model' AND n_model >= (t.policy->'limits'->>'model')::int)
    OR (p_call_kind = 'decision' AND n_decision >= coalesce((t.policy->'limits'->>'decisions')::int, 0))
    OR (p_call_kind = 'tool' AND p_paid AND n_paid >= coalesce((t.policy->'limits'->>'toolRows')::int, (t.policy->'limits'->>'paidTools')::int))
    OR (p_call_kind = 'tool' AND NOT p_paid AND n_free >= (t.policy->'limits'->>'freeTools')::int)
    OR (p_call_kind = 'tool' AND NOT p_paid AND p_upper_usd <> 0) OR (p_paid AND p_upper_usd <= 0) THEN
    RAISE EXCEPTION 'TURN_CALL_LIMIT' USING ERRCODE='22023';
  END IF;
  -- The remaining freeze must cover min(G_i, L): this call's bound G_i = ceil(q x U_i x m_i), or the start threshold L when the
  -- freeze was capped by the balance (H = min(G, A), Owner 10-01 and 10-28: a balance that covers one normal turn starts it; the
  -- part of a call above the freeze is the platform's, E = N - D). Below that the turn waits for credits. The positioning check
  -- is never charged to the user (Owner 10-12): it needs no freeze; its upper bound counts in U_turn and the stop-loss only.
  q := (t.policy->>'q')::numeric;
  IF t.kind = 'jury' THEN
    -- A jury pays its fixed price whatever its calls cost (Owner 10-17); the freeze above it is the temporary bound of the group
    -- in flight (10-13): only calls still in flight count against it, a finished group's bound is free again (V2-7b). A call
    -- whose answer is saved and judged has finished, with only its cost pending: it does not hold the next group back.
    SELECT coalesce((t.policy->>'fixedCredits')::int, 0) + coalesce(sum(ceil(q * k.upper_usd * k.multiplier)), 0) INTO used
    FROM turn_calls k WHERE k.turn_id = p_turn_id AND k.call_kind <> 'decision' AND k.status IN ('dispatched','identified')
      AND NOT EXISTS (SELECT 1 FROM fusion_turn_outputs o WHERE o.turn_id = k.turn_id AND o.seq = k.seq);
  ELSE
    SELECT coalesce(sum(CASE WHEN status = 'ok' THEN ceil(q * nominal_usd * multiplier)
                             WHEN status IN ('dispatched','identified','unknown') THEN ceil(q * upper_usd * multiplier)
                             ELSE 0 END), 0) INTO used
    FROM turn_calls WHERE turn_id = p_turn_id AND call_kind <> 'decision';
  END IF;
  -- A jury adoption is free to the user (10-20): nothing is frozen and nothing needs to be.
  need := CASE WHEN p_call_kind = 'decision' OR t.kind = 'jury_adopt' THEN 0
    ELSE least(ceil(q * p_upper_usd * p_multiplier), coalesce((t.policy->>'minCredits')::numeric, ceil(q * p_upper_usd * p_multiplier))) END;
  -- The freeze does not cover this call's bound G_i: freeze more, only what the balance holds and never beyond G_turn. One top-up per
  -- call, named by its turn and seq; a repeated begin returned above. Only what is still short after it pauses, as before.
  IF t.policy ? 'holdCredits' AND p_call_kind <> 'decision' THEN
    bound := ceil(q * p_upper_usd * p_multiplier);
    IF t.reserved_credits - used < bound THEN
      -- A call between the look above and this lock used the freeze: the caller asks again, with the account taken first.
      IF NOT held THEN RAISE EXCEPTION 'TURN_HOLD_RETRY' USING ERRCODE='40001'; END IF;
      step := least(greatest(bound - (t.reserved_credits - used), (t.policy->>'holdCredits')::int),
        greatest((t.policy->>'gCredits')::int - t.reserved_credits, 0), greatest(public.credit_available(p_actor_id), 0));
      IF step > 0 THEN
        SELECT pre_deduct_id INTO hold FROM public.atomic_pre_deduct(p_actor_id, step, 'AI turn freeze top-up',
          md5('turn-top-up:'||p_actor_id||':'||p_turn_id||':'||p_seq)::uuid);
        UPDATE turns SET reserved_credits = reserved_credits + step,
            policy = jsonb_set(policy, '{topUps}', coalesce(policy->'topUps', '[]'::jsonb) || jsonb_build_object('holdId', hold, 'credits', step))
          WHERE actor_id = p_actor_id AND id = p_turn_id RETURNING * INTO t;
      END IF;
    END IF;
  END IF;
  IF t.reserved_credits - used < need THEN
    UPDATE turns SET state = 'paused', pause_reason = 'waiting_credits', updated_at = now() WHERE actor_id = p_actor_id AND id = p_turn_id;
    RETURN jsonb_build_object('state', 'paused', 'paused', true) || turn_tombstones(p_actor_id, t.session_id, t.policy);
  END IF;
  -- The stop-loss the same way (2.5.1, Owner 11-01): every call's bound is reserved before it is sent. Last before the insert: the
  -- bucket row is held shortest, turn then bucket as turn_close. Own bucket first, then the day's sum, then the check of turn_open;
  -- the refusal rolls this begin back (no call row, no freeze). The row of the turn's open day, as its close releases.
  IF t.policy ? 'holdUsd' AND p_upper_usd > 0 THEN
    SELECT coalesce(sum(CASE WHEN status = 'ok' THEN turn_call_spent_usd(call_kind, nominal_usd, actual_usd)
                             WHEN status = 'unusable' THEN coalesce(actual_usd, 0)
                             WHEN status IN ('dispatched','identified','unknown') THEN upper_usd ELSE 0 END), 0) INTO spent
    FROM turn_calls WHERE turn_id = p_turn_id;
    IF t.reserved_usd - spent < p_upper_usd THEN
      usd_step := greatest(p_upper_usd - (t.reserved_usd - spent),
        least((t.policy->>'holdUsd')::numeric, greatest((t.policy->>'uTurnUsd')::numeric - t.reserved_usd, 0)));
      UPDATE daily_spend SET reserved_usd = reserved_usd + usd_step
        WHERE day = (t.policy->>'day')::date AND bucket = (t.policy->>'bucket')::smallint;
      SELECT sum(reserved_usd + spent_usd) INTO total FROM daily_spend WHERE day = (t.policy->>'day')::date;
      IF total + ((t.policy->'stopLoss'->>'p')::numeric - 1) * (t.policy->'stopLoss'->>'uFastUsd')::numeric
          + (t.policy->'stopLoss'->>'uBigUsd')::numeric > (t.policy->'stopLoss'->>'limitUsd')::numeric THEN
        RAISE EXCEPTION 'STOP_LOSS_REACHED' USING ERRCODE='P0001';
      END IF;
      UPDATE turns SET reserved_usd = reserved_usd + usd_step WHERE actor_id = p_actor_id AND id = p_turn_id;
    END IF;
  END IF;
  INSERT INTO turn_calls (actor_id, turn_id, seq, call_kind, model_id, tool_name, request_hash, upper_usd, multiplier)
    VALUES (p_actor_id, p_turn_id, p_seq, p_call_kind, p_model_id, p_tool_name, p_request_hash, p_upper_usd, p_multiplier);
  UPDATE turns SET updated_at = now() WHERE actor_id = p_actor_id AND id = p_turn_id;
  RETURN jsonb_build_object('state', 'running', 'status', 'dispatched', 'replay', false) || turn_tombstones(p_actor_id, t.session_id, t.policy);
END $function$;;

COMMIT;
