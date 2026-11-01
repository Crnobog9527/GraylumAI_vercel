-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 turn hold top-up (number 0451 = staging's highest + 1). Owner 11-01: "选 A 补冻", replacing 10-28's one freeze at the open: each
-- paid call freezes only its own bound. A chat or mentor turn opens with holdCredits (one model call plus the largest paid tool) and
-- turn_call_begin freezes more when a call's bound is not covered; it pauses only when the balance cannot.
--   turn_open             H = min(holdCredits or G, available); holdCredits only for chat and mentor. L is held against the balance as before.
--   turn_call_begin       looks without a lock (turn_hold_short); only a call that needs a top-up takes profile, session, turn, in that order.
--                         A top-up is atomic_pre_deduct, named by turn and seq; policy.topUps lists them; reserved_credits rises. TURN_HOLD_RETRY
--                         (40001): a concurrent call used the freeze after the look; nothing was written, the caller asks again.
--   turn_settle_holds     the charge fills the first freeze, then the top-ups in order; every freeze settles, an unused one returns in full.
--   turn_settle_credits   p_part: a top-up's rows have their own idempotency keys (turn:<id>:part<n>:spend); part 0 keeps the old keys.
--   turn_close, turn_resume_close   settle through turn_settle_holds. turn_call_record: creditsLow also counts the balance.
-- Fixed-price kinds (report, compare, jury, jury_adopt) and plan carry no holdCredits: their paths do not change.
-- Compatible: turns without holdCredits behave as before; old code sends none. Repeatable: DROP of the old signature, CREATE OR REPLACE.
-- Recovery: stop sending holdCredits (Node), then re-apply the previous functions once no open turn has policy.topUps.
BEGIN;
SET LOCAL lock_timeout='5s';

DROP FUNCTION IF EXISTS public.turn_settle_credits(uuid, uuid, integer, bigint);

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
END $function$;

CREATE OR REPLACE FUNCTION public.turn_settle_credits(p_user_id uuid, p_pre_deduct_id uuid, p_actual_credits integer, p_turn_id bigint, p_part integer DEFAULT 0)
 RETURNS TABLE(actual_credits integer, difference integer, balance_after integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_dispute_period integer:=0; v_dispute_other integer:=0;
  v_pre_deducted INTEGER;
  v_pre_meta JSONB;
  v_difference INTEGER;
  v_current_balance INTEGER;
  v_balance_after INTEGER;
  v_existing_settle UUID;
  v_existing_meta JSONB;
  v_charged_grant_id UUID;
  v_period_key TEXT;
  v_to_period INTEGER := 0;
  v_to_other INTEGER := 0;
  v_grant_status TEXT;
  v_grant_granted INTEGER;
  v_grant_consumed INTEGER;
  v_grant_terminated BOOLEAN;
  v_intercepted BOOLEAN;
  v_balance_delta INTEGER;
  v_period_delta INTEGER := 0;
  v_overrun INTEGER;
  v_intercepted_overrun INTEGER := 0;
  v_intercepted_restoration INTEGER := 0;
  v_spend uuid;
  -- A turn's first freeze keeps the keys it always had; a top-up settles under its own, so each part repeats safely.
  v_key text := 'turn:'||p_turn_id||CASE WHEN p_part>0 THEN ':part'||p_part ELSE '' END;
BEGIN
  IF p_actual_credits IS NULL OR p_actual_credits < 0 THEN RAISE EXCEPTION 'TURN_SETTLE_INVALID' USING ERRCODE='22023'; END IF;
  SELECT ABS(amount), metadata INTO v_pre_deducted, v_pre_meta
  FROM billing_history
  WHERE id = p_pre_deduct_id
    AND user_id = p_user_id
    AND operation_type = 'pre_deduct';
  IF NOT FOUND THEN
    RAISE EXCEPTION '预扣记录不存在: %', p_pre_deduct_id;
  END IF;
  v_difference := v_pre_deducted - p_actual_credits;

  -- 锁定用户行 (锁序: profile -> grant)
  SELECT credits INTO v_current_balance
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '用户不存在: %', p_user_id;
  END IF;

  -- Repeated settlement of the same freeze: return the first result (it must have charged the same amount).
  SELECT id, metadata INTO v_existing_settle, v_existing_meta
  FROM billing_history
  WHERE operation_type = 'settle'
    AND metadata->>'preDeductId' = p_pre_deduct_id::TEXT
  LIMIT 1;
  IF v_existing_settle IS NOT NULL THEN
    IF (v_existing_meta->>'actualCredits')::integer IS DISTINCT FROM p_actual_credits THEN
      RAISE EXCEPTION 'TURN_SETTLE_CONFLICT' USING ERRCODE='22023';
    END IF;
    RETURN QUERY SELECT p_actual_credits, (v_existing_meta->>'difference')::integer, v_current_balance;
    RETURN;
  END IF;

  v_balance_delta := v_difference;

  -- REFUND-1B: 复用预扣绑定 (跨周期也在原绑定上操作), 状态在持锁下重读。
  v_charged_grant_id := NULLIF(v_pre_meta->>'chargedGrantId', '')::UUID;
  IF v_charged_grant_id IS NOT NULL THEN
    v_period_key := v_pre_meta->>'chargedPeriodKey';
    v_to_period := COALESCE(NULLIF(v_pre_meta->>'amountToPeriod', '')::INTEGER, 0);
    v_to_other := COALESCE(NULLIF(v_pre_meta->>'amountToOther', '')::INTEGER, 0);

    SELECT g.status, g.credits_granted, g.consumed_amount,
           (us.credit_release_terminated_at IS NOT NULL) AS terminated
    INTO v_grant_status, v_grant_granted, v_grant_consumed, v_grant_terminated
    FROM subscription_credit_grants AS g
    JOIN user_subscriptions AS us
      ON (us.id = g.subscription_id OR (g.subscription_id IS NULL AND us.stripe_subscription_id = g.stripe_subscription_id))
     AND us.user_id = p_user_id
    WHERE g.id = v_charged_grant_id
      AND g.user_id = p_user_id
      AND g.grant_period_key = v_period_key
    FOR UPDATE OF g;
    IF NOT FOUND THEN
      RAISE EXCEPTION '绑定积分发放记录缺失: %', v_charged_grant_id;
    END IF;
    IF v_grant_status NOT IN ('granted', 'reversed') THEN
      RAISE EXCEPTION '绑定积分发放记录状态异常: % (%)', v_charged_grant_id, v_grant_status;
    END IF;

    v_intercepted := (v_grant_status = 'reversed') OR v_grant_terminated;
    IF v_intercepted THEN
      IF v_difference >= 0 THEN
        v_balance_delta := LEAST(v_difference, GREATEST(v_to_other, 0));
        v_intercepted_restoration := LEAST(GREATEST(v_difference - GREATEST(v_to_other, 0), 0), v_to_period);
      ELSE
        v_balance_delta := 0;
        v_intercepted_overrun := p_actual_credits - v_pre_deducted;
      END IF;
    ELSE
      IF v_difference >= 0 THEN
        v_balance_delta := v_difference;
        v_period_delta := -LEAST(GREATEST(v_difference - GREATEST(v_to_other, 0), 0), v_to_period);
      ELSE
        v_overrun := p_actual_credits - v_pre_deducted;
        v_balance_delta := -v_overrun;
        v_period_delta := LEAST(v_overrun, GREATEST(v_grant_granted - v_grant_consumed, 0));
      END IF;
    END IF;

    IF v_period_delta <> 0 THEN
      UPDATE subscription_credit_grants SET consumed_amount = consumed_amount + v_period_delta,
          updated_at = now()
      WHERE id = v_charged_grant_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION '积分发放记录消耗更新未命中: %', v_charged_grant_id;
      END IF;
    END IF;
  END IF;

  IF v_balance_delta<0 THEN
    SELECT period_taken,other_taken INTO v_dispute_period,v_dispute_other
    FROM pay_dispute_overrun(p_user_id,p_pre_deduct_id,v_charged_grant_id,v_period_delta,-v_balance_delta);
    v_balance_delta:=v_balance_delta+v_dispute_period+v_dispute_other;
  END IF;
  v_balance_after := v_current_balance + v_balance_delta;

  IF v_balance_after < 0 THEN
    RAISE EXCEPTION '积分不足: 结算将导致负余额 (当前 %, 变动 %)', v_current_balance, v_balance_delta;
  END IF;
  IF v_balance_delta <> 0 THEN
    UPDATE profiles SET credits = v_balance_after
    WHERE id = p_user_id;
  END IF;
  -- Conservation: the profile row now holds exactly the computed balance.
  IF (SELECT credits FROM profiles WHERE id = p_user_id) IS DISTINCT FROM v_balance_after THEN
    RAISE EXCEPTION 'TURN_SETTLE_CONSERVATION' USING ERRCODE='XX000';
  END IF;

  -- One net row in the user's credit records: what this turn actually cost (the freeze itself is never listed, 10-25). When the
  -- subscription the freeze came from was refunded or ended meanwhile, the unused part is not returned (intercepted): one more
  -- row, not a spend, keeps the records equal to the balance (as bill2 release rows and billing_reconcile_day count it).
  -- D <= H, so a turn never overruns its freeze (v_intercepted_overrun stays 0).
  IF p_actual_credits > 0 THEN
    INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,
     idempotency_key,balance_before,balance_after,metadata)
    VALUES(p_user_id,-p_actual_credits,'consumption','AI turn','spend','turn_spend','ai_task',p_turn_id::text,
     v_key||':spend',v_balance_after+p_actual_credits+v_intercepted_restoration,v_balance_after+v_intercepted_restoration,
     jsonb_build_object('turnId',p_turn_id,'preDeductId',p_pre_deduct_id))
    RETURNING id INTO v_spend;
  END IF;
  IF v_intercepted_restoration > 0 THEN
    INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,
     idempotency_key,balance_before,balance_after,metadata)
    VALUES(p_user_id,-v_intercepted_restoration,'adjustment','AI turn freeze not returned (subscription refunded or ended)',
     'adjustment','turn_intercepted','ai_task',p_turn_id::text,v_key||':intercepted',
     v_balance_after+v_intercepted_restoration,v_balance_after,
     jsonb_build_object('turnId',p_turn_id,'preDeductId',p_pre_deduct_id,'chargedGrantId',v_charged_grant_id));
  END IF;

  INSERT INTO billing_history (user_id, operation_type, amount, reason, metadata, transaction_id)
  VALUES (p_user_id, 'settle', -p_actual_credits, 'AI 对话结算',
    jsonb_build_object(
      'preDeductId', p_pre_deduct_id,
      'turnId', p_turn_id,
      'preDeductedAmount', v_pre_deducted,
      'actualCredits', p_actual_credits,
      'difference', v_balance_delta,
      'requestedDifference', v_difference,
      'chargedGrantId', v_charged_grant_id,
      'chargedPeriodKey', v_period_key,
      'amountToPeriod', v_to_period,
      'amountToOther', v_to_other,
      'periodConsumedDelta', v_period_delta,
      'refundInterceptedOverrun', v_intercepted_overrun,
      'refundInterceptedRestoration', v_intercepted_restoration,
      'timestamp', NOW()::TEXT
    ), v_spend);

  PERFORM credit_source_apply(p_user_id, p_pre_deduct_id, -v_balance_delta - v_period_delta + v_dispute_period, 'settle');
  RETURN QUERY SELECT p_actual_credits, v_balance_delta, v_balance_after;
END;
$function$;

CREATE OR REPLACE FUNCTION public.turn_settle_holds(p_actor_id uuid, t turns, p_charge integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE left_charge integer := p_charge; part integer; idx integer := 0; hold jsonb;
BEGIN
 -- The charge fills the first freeze, then each top-up in order: the same split every time, so a repeat settles the same parts.
 IF t.policy->>'holdId' IS NOT NULL THEN
  part := least(left_charge, (t.policy->>'heldCredits')::int);
  PERFORM public.turn_settle_credits(p_actor_id, (t.policy->>'holdId')::uuid, part, t.id, 0);
  left_charge := left_charge - part;
 END IF;
 FOR hold IN SELECT value FROM jsonb_array_elements(coalesce(t.policy->'topUps', '[]'::jsonb)) LOOP
  idx := idx + 1;
  part := least(left_charge, (hold->>'credits')::int);
  PERFORM public.turn_settle_credits(p_actor_id, (hold->>'holdId')::uuid, part, t.id, idx);
  left_charge := left_charge - part;
 END LOOP;
 IF left_charge > 0 THEN RAISE EXCEPTION 'TURN_SETTLE_INVALID' USING ERRCODE='22023'; END IF; -- D <= H, always
END $function$;

CREATE OR REPLACE FUNCTION public.turn_hold_short(t turns, p_upper_usd numeric, p_multiplier numeric)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT t.reserved_credits - coalesce(sum(CASE WHEN status = 'ok' THEN ceil((t.policy->>'q')::numeric * nominal_usd * multiplier)
     WHEN status IN ('dispatched','identified','unknown') THEN ceil((t.policy->>'q')::numeric * upper_usd * multiplier) ELSE 0 END), 0)
   < ceil((t.policy->>'q')::numeric * p_upper_usd * p_multiplier)
 FROM turn_calls WHERE turn_id = t.id AND call_kind <> 'decision'
$function$;

CREATE OR REPLACE FUNCTION public.turn_call_begin(p_actor_id uuid, p_turn_id bigint, p_seq integer, p_call_kind text, p_model_id uuid, p_tool_name text, p_paid boolean, p_request_hash text, p_upper_usd numeric, p_multiplier numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; c turn_calls; q numeric; used integer; need integer; n_model integer; n_paid integer; n_free integer;
  n_decision integer; bound integer; held boolean := false; step integer; hold uuid;
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
  INSERT INTO turn_calls (actor_id, turn_id, seq, call_kind, model_id, tool_name, request_hash, upper_usd, multiplier)
    VALUES (p_actor_id, p_turn_id, p_seq, p_call_kind, p_model_id, p_tool_name, p_request_hash, p_upper_usd, p_multiplier);
  UPDATE turns SET updated_at = now() WHERE actor_id = p_actor_id AND id = p_turn_id;
  RETURN jsonb_build_object('state', 'running', 'status', 'dispatched', 'replay', false) || turn_tombstones(p_actor_id, t.session_id, t.policy);
END $function$;

CREATE OR REPLACE FUNCTION public.turn_close(p_actor_id uuid, p_turn_id bigint, p_close_kind text, p_messages jsonb DEFAULT '[]'::jsonb, p_delivered boolean DEFAULT false, p_refund_all boolean DEFAULT false, p_failure_code text DEFAULT NULL::text, p_kind_result jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  t turns; s runtime_sessions; q numeric; n_total numeric; pending_upper numeric; credits integer; charge integer; h integer;
  v_kind text := p_close_kind; tomb jsonb; next_seq integer; msg jsonb; pending boolean; user_pending boolean;
  marker timestamptz; kind_result jsonb;
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
      SELECT coalesce(sum(turn_call_spent_usd(call_kind, nominal_usd, actual_usd)) FILTER (WHERE status = 'ok'), 0) + coalesce(sum(actual_usd) FILTER (WHERE status = 'unusable'), 0),
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
        charge := CASE WHEN t.kind = 'report' THEN (public.turn_report_settlement(t, t.close_kind, t.delivered, credits,
            t.reserved_credits + coalesce((t.policy->>'carriedCredits')::int, 0), t.closed_at)).charge
          ELSE public.turn_user_charge(p_actor_id, p_turn_id, t.close_kind, t.delivered,
          coalesce((t.policy->>'closeRefundAll')::boolean, false), credits,
          t.reserved_credits + coalesce((t.policy->>'carriedCredits')::int, 0), (t.policy->>'fixedCredits')::int, t.closed_at) END;
        PERFORM public.turn_settle_holds(p_actor_id, t, charge);
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
  IF t.kind = 'report' THEN v_kind := public.turn_report_close_kind(t, v_kind); END IF;
  tomb := turn_tombstones(p_actor_id, t.session_id, t.policy);
  IF v_kind IN ('completed','stopped') AND ((tomb->>'sessionTombstoned')::boolean OR (tomb->>'accountErasing')::boolean
    OR (tomb->>'voiceSourceRevoked')::boolean) THEN v_kind := 'erased'; END IF;
  -- The per-kind hook: what a kind keeps from its result (a draft, a report, a verdict) is written in the same transaction as the
  -- close, by that kind's own function (e.g. turn_mentor_apply(t, v_kind, p_kind_result)), one branch per kind:
  --   IF t.kind = '<kind>' THEN PERFORM public.turn_<kind>_apply(...); ELSE ... END IF;
  -- A kind without a branch has its result refused rather than dropped.
  IF p_kind_result IS NOT NULL THEN
    IF t.kind = 'mentor' THEN
      -- V2-5c: what this turn's research made, on any close that saves anything (paid lookups stay paid when the reply failed).
      IF v_kind <> 'erased' AND p_kind_result ? 'research' THEN PERFORM public.research_turn_apply(p_actor_id, t, p_kind_result->'research'); END IF;
      -- V2-5: the organizer's checklist patches; only a delivered completed turn applies them (an erased one saves nothing).
      IF v_kind = 'completed' AND p_delivered AND p_kind_result ? 'organizerInput' THEN kind_result := public.turn_mentor_apply(p_actor_id, p_turn_id, p_kind_result); END IF;
    ELSIF t.kind = 'report' THEN
      PERFORM public.turn_report_apply(t, v_kind, p_kind_result);
    ELSIF t.kind = 'plan' THEN
      PERFORM public.turn_plan_apply(t, v_kind, p_kind_result);
    ELSE
      RAISE EXCEPTION 'TURN_KIND_RESULT_UNSUPPORTED' USING ERRCODE='22023';
    END IF;
  END IF;

  -- Calls without a final receipt: their cost is unknown; it is never presumed zero and never retried (2.5.2).
  UPDATE turn_calls SET status = 'unknown', cost_pending = true
   WHERE turn_id = p_turn_id AND status IN ('dispatched','identified');
  q := (t.policy->>'q')::numeric;
  -- N = ceil(q x sum(n_i x m_i)) over the known receipts the user pays for (never the positioning check); n_total is the provider
  -- cost of every receipt, the positioning check and the platform-paid unusable results included, which the stop-loss counts; a
  -- tool receipt counts its whole known supplier cost (turn_call_spent_usd), the subcalls the user does not pay for included.
  SELECT ceil(q * coalesce(sum(nominal_usd * multiplier) FILTER (WHERE status = 'ok' AND call_kind <> 'decision'), 0))::integer,
         coalesce(sum(turn_call_spent_usd(call_kind, nominal_usd, actual_usd)) FILTER (WHERE status = 'ok'), 0) + coalesce(sum(actual_usd) FILTER (WHERE status = 'unusable'), 0),
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
  IF t.kind = 'report' THEN
    SELECT r.charge, user_pending AND NOT r.settle_now INTO charge, user_pending FROM public.turn_report_settlement(t, v_kind, p_delivered, credits, h, marker) r;
  ELSE
    charge := public.turn_user_charge(p_actor_id, p_turn_id, v_kind, p_delivered, p_refund_all, credits, h,
      (t.policy->>'fixedCredits')::int, marker);
  END IF;

  -- Credits: settled once, each freeze of the turn exactly once; with an unknown model cost they all wait for recovery.
  -- settlement stays 'pending' while any provider cost is unknown, so recovery still settles the stop-loss; a repeated credit
  -- settlement of the same freeze returns the first one.
  IF NOT user_pending THEN PERFORM public.turn_settle_holds(p_actor_id, t, charge); END IF;

  -- What a paused turn kept for its resume ends with it (the 24-hour expiry closes here).
  IF t.state = 'paused' THEN DELETE FROM session_messages WHERE session_id = t.session_id AND turn_id = p_turn_id AND NOT visible; END IF;

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
    'absorbedCredits', t.absorbed_credits, 'settlement', t.settlement, 'replay', false, 'kindResult', kind_result) || tomb;
END $function$;

CREATE OR REPLACE FUNCTION public.turn_resume_close(p_actor_id uuid, p_turn_id bigint, p_carried integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; credits integer; n_total numeric; pending_upper numeric; pending boolean; marker timestamptz;
BEGIN
  -- The profile, the session and this turn are locked already (turn_open, turn_resume_carry).
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id;
  -- Keep in step with turn_close: the turn-core recovery suite compares this close with turn_close's on the same paused turn.
  UPDATE turn_calls SET status = 'unknown', cost_pending = true
   WHERE turn_id = p_turn_id AND status IN ('dispatched','identified');
  SELECT ceil((t.policy->>'q')::numeric * coalesce(sum(nominal_usd * multiplier) FILTER (WHERE status = 'ok' AND call_kind <> 'decision'), 0))::integer,
         coalesce(sum(turn_call_spent_usd(call_kind, nominal_usd, actual_usd)) FILTER (WHERE status = 'ok'), 0) + coalesce(sum(actual_usd) FILTER (WHERE status = 'unusable'), 0),
         coalesce(sum(upper_usd) FILTER (WHERE cost_pending), 0),
         coalesce(bool_or(cost_pending), false)
    INTO credits, n_total, pending_upper, pending
  FROM turn_calls WHERE turn_id = p_turn_id;
  credits := credits + coalesce((t.policy->>'carriedCredits')::int, 0);
  UPDATE daily_spend SET spent_usd = spent_usd + n_total,
      reserved_usd = greatest(reserved_usd - (t.reserved_usd - pending_upper), 0)
    WHERE day = (t.policy->>'day')::date AND bucket = (t.policy->>'bucket')::smallint;
  marker := clock_timestamp();
  PERFORM public.turn_settle_holds(p_actor_id, t, 0);
  -- What it carries is not borne by the platform: only what the chain finally does not charge is recorded as absorbed.
  UPDATE turns SET state = 'closed', pause_reason = NULL, close_kind = 'failed', closed_at = marker, updated_at = marker,
      charged_credits = 0, absorbed_credits = greatest(credits - p_carried, 0),
      settlement = CASE WHEN pending THEN 'pending' ELSE 'done' END,
      stopped_by_user = false, delivered = false, failure_code = 'resumed'
    WHERE actor_id = p_actor_id AND id = p_turn_id;
  DELETE FROM session_messages WHERE session_id = t.session_id AND turn_id = p_turn_id AND NOT visible;
  UPDATE runtime_sessions SET active_turn_id = NULL
    WHERE id = t.session_id AND actor_id = p_actor_id AND active_turn_id = p_turn_id;
END $function$;

CREATE OR REPLACE FUNCTION public.turn_call_record(p_actor_id uuid, p_turn_id bigint, p_seq integer, p_status text, p_nominal_usd numeric, p_actual_usd numeric, p_usage jsonb, p_provider_id text, p_payload_hash text, p_raw text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; c turn_calls; q numeric; used integer; next_need integer; tomb jsonb; more integer := 0;
BEGIN
  IF p_status NOT IN ('ok','not_sent','rejected','no_charge_402','unusable') THEN RAISE EXCEPTION 'TURN_CALL_INVALID' USING ERRCODE='22023'; END IF;
  -- Lock the turn row before reading the call: turn_close may be marking it unknown, or the same receipt may arrive twice.
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id FOR UPDATE;
  SELECT * INTO c FROM turn_calls WHERE actor_id = p_actor_id AND turn_id = p_turn_id AND seq = p_seq;
  IF c.turn_id IS NULL THEN RAISE EXCEPTION 'TURN_CALL_DENIED' USING ERRCODE='42501'; END IF;
  tomb := turn_tombstones(p_actor_id, t.session_id, t.policy);
  -- A final receipt that arrives after turn_close marked the call unknown is the cost evidence recovery would look up: kept. So is
  -- a late proof that the request was never billed (not_sent, rejected), under the same no-provider-id check below; it frees the
  -- freeze and the stop-loss share at the next settlement.
  IF c.status = 'unknown' AND c.cost_pending AND p_status IN ('ok','no_charge_402','unusable','not_sent','rejected') THEN
    c.status := 'identified';
  END IF;
  IF c.status IN ('dispatched','identified') THEN
    IF p_status = 'ok' AND (p_nominal_usd IS NULL OR p_nominal_usd < 0) THEN RAISE EXCEPTION 'TURN_CALL_INVALID' USING ERRCODE='22023'; END IF;
    -- not_sent and rejected are only for requests the provider certainly never billed: no provider id, no cost.
    IF p_status IN ('not_sent','rejected') AND (c.provider_id IS NOT NULL OR p_provider_id IS NOT NULL) THEN
      RAISE EXCEPTION 'TURN_CALL_INVALID' USING ERRCODE='22023';
    END IF;
    UPDATE turn_calls SET status = p_status,
        nominal_usd = CASE WHEN p_status = 'ok' THEN p_nominal_usd ELSE 0 END,
        -- unusable: the provider charged for a result that cannot be used; the user's base is 0, the platform's cost is kept.
        actual_usd = CASE WHEN p_status IN ('ok','unusable') THEN p_actual_usd END,
        usage = coalesce(p_usage, '{}'::jsonb), provider_id = coalesce(c.provider_id, p_provider_id),
        payload_hash = p_payload_hash, settled_at = clock_timestamp(), cost_pending = false,
        -- Above the frozen bound: the estimate failed (price or metering); the model is blocked for new calls (turn_call_begin).
        budget_conflict = c.call_kind = 'model' AND p_status = 'ok'
          AND (coalesce(p_actual_usd, 0) > c.upper_usd OR coalesce(p_nominal_usd, 0) > c.upper_usd)
      WHERE turn_id = p_turn_id AND seq = p_seq;
    -- The billing fields are kept; the response text is not stored once the conversation is deleted or the account is being
    -- erased (a late receipt would otherwise bring user content back after the erasure scrub). Race-free with the scrub: it runs
    -- only after account_erasure_barrier, so any receipt still writing then started after the request and sees it here.
    IF p_raw IS NOT NULL AND NOT (tomb->>'sessionTombstoned')::boolean AND NOT (tomb->>'accountErasing')::boolean THEN
      INSERT INTO turn_call_raw (turn_id, seq, body) VALUES (p_turn_id, p_seq, p_raw);
    END IF;
  ELSIF c.status <> p_status OR c.payload_hash IS DISTINCT FROM p_payload_hash THEN
    RAISE EXCEPTION 'TURN_CALL_CONFLICT' USING ERRCODE='22023';
  END IF;
  -- credits_low: the remaining freeze cannot cover one more model call of this turn.
  q := (t.policy->>'q')::numeric;
  SELECT coalesce(sum(CASE WHEN status = 'ok' THEN ceil(q * nominal_usd * multiplier)
                           WHEN status IN ('dispatched','identified','unknown') THEN ceil(q * upper_usd * multiplier)
                           ELSE 0 END), 0) INTO used
  FROM turn_calls WHERE turn_id = p_turn_id AND call_kind <> 'decision';
  -- credits_low: the same rule that pauses the next call (turn_call_begin): the remaining freeze below the start threshold L.
  next_need := coalesce((t.policy->>'minCredits')::int, (t.policy->>'uModelCredits')::int, 0);
  -- A turn that tops up can still freeze the balance: what is low is the two together. Never in the way of a receipt.
  IF t.policy ? 'holdCredits' THEN
    BEGIN more := greatest(public.credit_available(p_actor_id), 0); EXCEPTION WHEN raise_exception THEN more := 0; END;
  END IF;
  RETURN jsonb_build_object('status', p_status, 'creditsLow', t.reserved_credits + more - used < next_need) || tomb;
END $function$;

REVOKE ALL ON FUNCTION public.turn_settle_credits(uuid,uuid,integer,bigint,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.turn_settle_holds(uuid,turns,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.turn_hold_short(turns,numeric,numeric) FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
