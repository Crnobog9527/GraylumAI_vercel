-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-3 (number 0421 assigned by the controller): the per-turn core functions on the 0420 tables
-- (docs/launch/tasks/CORE-PATH-V2.md sections 2.2, 2.5, 2.5.1-2.5.3, 2.6, 3.3.2).
--   turn_open           lock the session, refuse tombstones, stop-loss reserve U_turn, freeze H credits, insert the turn,
--                       return the visible history; idempotent per (actor, request)
--   turn_call_begin     before a request is sent: insert the call row (dispatched) within the frozen limits, or pause the turn
--                       when the remaining freeze cannot cover the call; returns the tombstones
--   turn_call_identity  store the provider id (identified)
--   turn_call_record    the final receipt: status, cost, usage and the raw body; returns tombstones and credits_low
--   turn_close          settle once (completed, failed, interrupted, expired, erased; stopped for reports only), release the
--                       stop-loss reservation, append the messages; calls without a final receipt become unknown/cost_pending
--                       and the credit settlement waits for recovery (settlement='pending'); idempotent
--   turn_settle_credits the credit settlement of a turn's freeze: the ledger math of bill2_legacy_settle copied unchanged
--                       (without its bill2 reads), plus one net spend row in credit_transactions
-- Ledger (Fable 10-28, option A): the freeze is atomic_pre_deduct and the settlement turn_settle_credits; with credit_available,
-- credit_source_apply (and pay_dispute_overrun inside the settlement) they lock only the actor's own profile, grant and package
-- source rows and are the "ledger leaves" the closure check does not expand (plan 5.2, 7.1).
-- Locks: transaction-level row locks only, always in the order session -> daily_spend bucket -> profile (so a turn opening and
-- another turn of the same actor closing never wait on each other in a cycle); a call write locks only its own turn row.
-- No advisory locks, no SET, no temporary tables (Supavisor transaction mode, plan 3.3.2 item 6).
-- The policy is computed by Node from the catalog cache (q, multipliers, bounds, limits, stop-loss parameters) and frozen here.
-- Not here yet: resuming a paused turn (V2-8), fixed-price jury settlement (V2-7b), report stop counting beyond the 24-hour rule.
-- Compatibility: new functions only; nothing calls them until core_path_v2 is enabled (V2-4). Repeatable: CREATE OR REPLACE.
-- Recovery: drop the six functions; no existing object depends on them.
BEGIN;
SET LOCAL lock_timeout='5s';

-- The ledger math of bill2_legacy_settle (whole copy, unchanged): restore the unused freeze to the binding it came from, or eat
-- an overrun from the bound period. What is new: no bill2_runs/bill2_calls reads (this settles a turn's own freeze), a repeated
-- call returns the first settlement instead of raising, a conservation check on the profile row, and one net spend row.
CREATE OR REPLACE FUNCTION public.turn_settle_credits(p_user_id uuid, p_pre_deduct_id uuid, p_actual_credits integer, p_turn_id bigint)
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
      UPDATE subscription_credit_grants
      SET consumed_amount = consumed_amount + v_period_delta,
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
    UPDATE profiles
    SET credits = v_balance_after
    WHERE id = p_user_id;
  END IF;
  -- Conservation: the profile row now holds exactly the computed balance.
  IF (SELECT credits FROM profiles WHERE id = p_user_id) IS DISTINCT FROM v_balance_after THEN
    RAISE EXCEPTION 'TURN_SETTLE_CONSERVATION' USING ERRCODE='XX000';
  END IF;

  -- One net row in the user's credit records: what this turn actually cost (the freeze itself is never listed, 10-25).
  IF p_actual_credits > 0 THEN
    INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,
     idempotency_key,balance_before,balance_after,metadata)
    VALUES(p_user_id,-p_actual_credits,'consumption','AI turn','spend','turn_spend','ai_task',p_turn_id::text,
     'turn:'||p_turn_id||':spend',v_balance_after+p_actual_credits,v_balance_after,
     jsonb_build_object('turnId',p_turn_id,'preDeductId',p_pre_deduct_id))
    RETURNING id INTO v_spend;
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

-- Tombstones a call write must stop on: the conversation deleted, the account being erased, the frozen voice source revoked.
CREATE OR REPLACE FUNCTION public.turn_tombstones(p_actor_id uuid, p_session_id uuid, p_policy jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT jsonb_build_object(
  'sessionTombstoned', p_session_id IS NULL OR NOT EXISTS (SELECT 1 FROM runtime_sessions s WHERE s.id = p_session_id
    AND s.actor_id = p_actor_id AND s.content_deleted_at IS NULL AND s.erased_at IS NULL),
  'accountErasing', EXISTS (SELECT 1 FROM account_erasure_requests r WHERE r.profile_id = p_actor_id),
  'voiceSourceRevoked', p_policy ? 'voiceVersionId' AND NOT EXISTS (SELECT 1 FROM voice_profiles v WHERE v.actor_id = p_actor_id
    AND v.enabled AND v.confirmed_version_id::text = p_policy->>'voiceVersionId'))
$function$;

CREATE OR REPLACE FUNCTION public.turn_open(p_actor_id uuid, p_session_id uuid, p_request_id uuid, p_kind text, p_policy jsonb,
  p_resume_of bigint DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  s runtime_sessions; t turns; prof profiles; existing turns;
  v_day date := (now() AT TIME ZONE 'UTC')::date; v_bucket smallint; total numeric; band numeric;
  u_turn numeric; g integer; h integer; available integer; hold uuid; frozen jsonb; history jsonb;
BEGIN
  IF p_kind NOT IN ('chat','mentor','report','compare','jury','jury_adopt','review') THEN
    RAISE EXCEPTION 'TURN_KIND_INVALID' USING ERRCODE='22023';
  END IF;
  IF p_resume_of IS NOT NULL THEN RAISE EXCEPTION 'TURN_RESUME_NOT_SUPPORTED' USING ERRCODE='0A000'; END IF;
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
    IF existing.session_id IS DISTINCT FROM p_session_id OR existing.kind <> p_kind THEN
      RAISE EXCEPTION 'TURN_REQUEST_CONFLICT' USING ERRCODE='22023';
    END IF;
    t := existing;
  ELSE
    IF s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'TURN_SESSION_ERASED' USING ERRCODE='42501'; END IF;
    IF EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_actor_id) THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_ERASING' USING ERRCODE='42501';
    END IF;
    IF s.active_turn_id IS NOT NULL THEN RAISE EXCEPTION 'TURN_SESSION_BUSY' USING ERRCODE='55P03'; END IF;
    -- The same account check as bill2_actor: active and not deleted.
    IF prof.id IS NULL OR prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_DENIED' USING ERRCODE='42501';
    END IF;

    -- 3. Stop-loss (2.5.1): reserve U_turn on the own bucket row first, then read the day's sum, then check with the band B.
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

    -- 4. Credits: H = min(G_turn, available); below the start threshold the turn does not open. The account row is locked before
    -- the balance is read: two sessions of one account in different stop-loss buckets would otherwise both size H on the same
    -- balance, and the second would be refused instead of freezing what is left. Order: session, bucket, account (as turn_close).
    PERFORM 1 FROM profiles WHERE id = p_actor_id FOR UPDATE;
    g := (p_policy->>'gCredits')::int;
    available := greatest(public.credit_available(p_actor_id), 0);
    h := least(g, available);
    IF h < (p_policy->>'minCredits')::int THEN RAISE EXCEPTION 'TURN_INSUFFICIENT_CREDITS' USING ERRCODE='P0001'; END IF;
    IF h > 0 THEN
      SELECT pre_deduct_id INTO hold FROM public.atomic_pre_deduct(p_actor_id, h, 'AI turn freeze', p_request_id);
    END IF;

    frozen := p_policy || jsonb_build_object('day', v_day, 'bucket', v_bucket, 'holdId', hold, 'heldCredits', h);
    INSERT INTO turns (actor_id, session_id, request_id, kind, state, policy, reserved_credits, reserved_usd, input_bytes)
      VALUES (p_actor_id, p_session_id, p_request_id, p_kind, 'running', frozen, h, u_turn,
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
    'reservedCredits', t.reserved_credits, 'reservedUsd', t.reserved_usd, 'history', history,
    'replyLanguage', prof.reply_language,
    'positioning', CASE WHEN p_kind = 'chat' THEN jsonb_build_object(
      'positioned', public.opc_has_confirmed_positioning(p_actor_id),
      'refusals24h', (SELECT count(*) FROM turns r WHERE r.actor_id = p_actor_id AND r.failure_code = 'positioning_required'
        AND r.closed_at > now() - interval '24 hours')) END);
END $function$;

CREATE OR REPLACE FUNCTION public.turn_call_begin(p_actor_id uuid, p_turn_id bigint, p_seq integer, p_call_kind text,
  p_model_id uuid, p_tool_name text, p_paid boolean, p_request_hash text, p_upper_usd numeric, p_multiplier numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; c turn_calls; q numeric; used integer; need integer; n_model integer; n_paid integer; n_free integer;
  n_decision integer;
BEGIN
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
    OR (p_call_kind = 'tool' AND p_paid AND n_paid >= (t.policy->'limits'->>'paidTools')::int)
    OR (p_call_kind = 'tool' AND NOT p_paid AND n_free >= (t.policy->'limits'->>'freeTools')::int)
    OR (p_call_kind = 'tool' AND NOT p_paid AND p_upper_usd <> 0) OR (p_paid AND p_upper_usd <= 0) THEN
    RAISE EXCEPTION 'TURN_CALL_LIMIT' USING ERRCODE='22023';
  END IF;
  -- The remaining freeze must cover this call's bound G_i = ceil(q x U_i x m_i); otherwise the turn waits for credits. The
  -- positioning check is never charged to the user (Owner 10-12): it needs no freeze; its upper bound counts in U_turn and the
  -- stop-loss reservation only.
  q := (t.policy->>'q')::numeric;
  SELECT coalesce(sum(CASE WHEN status = 'ok' THEN ceil(q * nominal_usd * multiplier)
                           WHEN status IN ('dispatched','identified','unknown') THEN ceil(q * upper_usd * multiplier)
                           ELSE 0 END), 0) INTO used
  FROM turn_calls WHERE turn_id = p_turn_id AND call_kind <> 'decision';
  need := CASE WHEN p_call_kind = 'decision' THEN 0 ELSE ceil(q * p_upper_usd * p_multiplier) END;
  IF t.reserved_credits - used < need THEN
    UPDATE turns SET state = 'paused', pause_reason = 'waiting_credits', updated_at = now() WHERE actor_id = p_actor_id AND id = p_turn_id;
    RETURN jsonb_build_object('state', 'paused', 'paused', true) || turn_tombstones(p_actor_id, t.session_id, t.policy);
  END IF;
  INSERT INTO turn_calls (actor_id, turn_id, seq, call_kind, model_id, tool_name, request_hash, upper_usd, multiplier)
    VALUES (p_actor_id, p_turn_id, p_seq, p_call_kind, p_model_id, p_tool_name, p_request_hash, p_upper_usd, p_multiplier);
  UPDATE turns SET updated_at = now() WHERE actor_id = p_actor_id AND id = p_turn_id;
  RETURN jsonb_build_object('state', 'running', 'status', 'dispatched', 'replay', false) || turn_tombstones(p_actor_id, t.session_id, t.policy);
END $function$;

CREATE OR REPLACE FUNCTION public.turn_call_identity(p_actor_id uuid, p_turn_id bigint, p_seq integer, p_provider_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE c turn_calls;
BEGIN
  -- Serialized with turn_close and the other call writes of this turn on the turn row (the only lock a call write takes).
  PERFORM 1 FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id FOR UPDATE;
  SELECT * INTO c FROM turn_calls WHERE actor_id = p_actor_id AND turn_id = p_turn_id AND seq = p_seq;
  IF c.turn_id IS NULL THEN RAISE EXCEPTION 'TURN_CALL_DENIED' USING ERRCODE='42501'; END IF;
  IF c.status = 'dispatched' THEN
    UPDATE turn_calls SET provider_id = p_provider_id, status = 'identified' WHERE turn_id = p_turn_id AND seq = p_seq RETURNING * INTO c;
  ELSIF c.status = 'unknown' AND c.provider_id IS NULL THEN
    -- The turn closed first (crash or timeout); the id still helps recovery find the cost.
    UPDATE turn_calls SET provider_id = p_provider_id WHERE turn_id = p_turn_id AND seq = p_seq RETURNING * INTO c;
  ELSIF c.provider_id IS DISTINCT FROM p_provider_id THEN
    RAISE EXCEPTION 'TURN_CALL_CONFLICT' USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object('status', c.status);
END $function$;

CREATE OR REPLACE FUNCTION public.turn_call_record(p_actor_id uuid, p_turn_id bigint, p_seq integer, p_status text,
  p_nominal_usd numeric, p_actual_usd numeric, p_usage jsonb, p_provider_id text, p_payload_hash text, p_raw text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; c turn_calls; q numeric; used integer; next_need integer; tomb jsonb;
BEGIN
  IF p_status NOT IN ('ok','not_sent','rejected','no_charge_402','unusable') THEN RAISE EXCEPTION 'TURN_CALL_INVALID' USING ERRCODE='22023'; END IF;
  -- Lock the turn row before reading the call: turn_close may be marking it unknown, or the same receipt may arrive twice.
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id FOR UPDATE;
  SELECT * INTO c FROM turn_calls WHERE actor_id = p_actor_id AND turn_id = p_turn_id AND seq = p_seq;
  IF c.turn_id IS NULL THEN RAISE EXCEPTION 'TURN_CALL_DENIED' USING ERRCODE='42501'; END IF;
  tomb := turn_tombstones(p_actor_id, t.session_id, t.policy);
  -- A final receipt that arrives after turn_close marked the call unknown is the cost evidence recovery would look up: kept.
  IF c.status = 'unknown' AND c.cost_pending AND p_status IN ('ok','no_charge_402','unusable') THEN
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
        actual_usd = CASE WHEN p_status = 'ok' THEN p_actual_usd END,
        usage = coalesce(p_usage, '{}'::jsonb), provider_id = coalesce(c.provider_id, p_provider_id),
        payload_hash = p_payload_hash, settled_at = now(), cost_pending = false
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
  next_need := coalesce((t.policy->>'uModelCredits')::int, 0);
  RETURN jsonb_build_object('status', p_status, 'creditsLow', t.reserved_credits - used < next_need) || tomb;
END $function$;

CREATE OR REPLACE FUNCTION public.turn_close(p_actor_id uuid, p_turn_id bigint, p_close_kind text, p_messages jsonb DEFAULT '[]'::jsonb,
  p_delivered boolean DEFAULT false, p_refund_all boolean DEFAULT false, p_failure_code text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  t turns; s runtime_sessions; q numeric; n_total numeric; pending_upper numeric; credits integer; charge integer; h integer;
  v_kind text := p_close_kind; tomb jsonb; stops integer; next_seq integer; msg jsonb; pending boolean;
BEGIN
  IF p_close_kind NOT IN ('completed','stopped','failed','interrupted','expired','erased') THEN
    RAISE EXCEPTION 'TURN_CLOSE_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id;
  IF t.id IS NULL THEN RAISE EXCEPTION 'TURN_DENIED' USING ERRCODE='42501'; END IF;
  -- Lock order: session, then the turn, then the stop-loss bucket, then the profile (as turn_open: session, bucket, profile).
  IF t.session_id IS NOT NULL THEN SELECT * INTO s FROM runtime_sessions WHERE id = t.session_id FOR UPDATE; END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id FOR UPDATE;
  IF t.state = 'closed' THEN
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

  -- Calls without a final receipt: their cost is unknown; it is never presumed zero and never retried (2.5.2).
  UPDATE turn_calls SET status = 'unknown', cost_pending = true
   WHERE turn_id = p_turn_id AND status IN ('dispatched','identified');
  q := (t.policy->>'q')::numeric;
  -- N = ceil(q x sum(n_i x m_i)) over the known receipts the user pays for (never the positioning check); n_total is the provider
  -- cost of every receipt, the positioning check included, which the stop-loss counts as spent.
  SELECT ceil(q * coalesce(sum(nominal_usd * multiplier) FILTER (WHERE status = 'ok' AND call_kind <> 'decision'), 0))::integer,
         coalesce(sum(nominal_usd) FILTER (WHERE status = 'ok'), 0),
         coalesce(sum(upper_usd) FILTER (WHERE cost_pending), 0),
         coalesce(bool_or(cost_pending), false)
    INTO credits, n_total, pending_upper, pending
  FROM turn_calls WHERE turn_id = p_turn_id;
  h := t.reserved_credits;

  -- Stop-loss: what is known is spent; the reservation of calls with an unknown cost stays until recovery settles them.
  UPDATE daily_spend SET spent_usd = spent_usd + n_total,
      reserved_usd = greatest(reserved_usd - (t.reserved_usd - pending_upper), 0)
    WHERE day = (t.policy->>'day')::date AND bucket = (t.policy->>'bucket')::smallint;
  -- The account row: serializes the actor's closes (the free-stop count below) before the settlement locks it again.
  PERFORM 1 FROM profiles WHERE id = p_actor_id FOR UPDATE;

  -- What the user pays (BILL-PAYG v7: D = min(N, H); the rest E = N - D is absorbed by the platform).
  IF p_refund_all OR (v_kind = 'expired' AND NOT p_delivered) THEN
    charge := 0;
  ELSIF v_kind = 'stopped' THEN
    -- 10-27: the first two stops within 24 hours are free; from the third, what was generated, at most the fixed price.
    SELECT count(*) INTO stops FROM turns r WHERE r.actor_id = p_actor_id AND r.kind = 'report' AND r.stopped_by_user
      AND closed_at > now() - interval '24 hours';
    charge := CASE WHEN stops < 2 THEN 0 ELSE least(credits, h, coalesce((t.policy->>'fixedCredits')::int, h)) END;
  ELSIF v_kind = 'completed' AND t.policy ? 'fixedCredits' THEN
    charge := CASE WHEN p_delivered THEN least((t.policy->>'fixedCredits')::int, h) ELSE 0 END;
  ELSE
    charge := least(credits, h);
  END IF;

  -- Credits: settled once; with an unknown cost the whole freeze waits for recovery (one freeze is settled exactly once).
  IF NOT pending AND t.policy->>'holdId' IS NOT NULL THEN
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

  UPDATE turns SET state = 'closed', pause_reason = NULL, close_kind = v_kind, closed_at = now(), updated_at = now(),
      charged_credits = CASE WHEN pending THEN NULL ELSE charge END,
      absorbed_credits = CASE WHEN pending THEN NULL ELSE greatest(credits - charge, 0) END,
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
  FOREACH f IN ARRAY ARRAY[
    'turn_settle_credits(uuid,uuid,integer,bigint)', 'turn_tombstones(uuid,uuid,jsonb)',
    'turn_open(uuid,uuid,uuid,text,jsonb,bigint)',
    'turn_call_begin(uuid,bigint,integer,text,uuid,text,boolean,text,numeric,numeric)',
    'turn_call_identity(uuid,bigint,integer,text)',
    'turn_call_record(uuid,bigint,integer,text,numeric,numeric,jsonb,text,text,text)',
    'turn_close(uuid,bigint,text,jsonb,boolean,boolean,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
  -- The internal helpers stay unexposed; the five turn steps are the service role's.
  FOREACH f IN ARRAY ARRAY[
    'turn_open(uuid,uuid,uuid,text,jsonb,bigint)',
    'turn_call_begin(uuid,bigint,integer,text,uuid,text,boolean,text,numeric,numeric)',
    'turn_call_identity(uuid,bigint,integer,text)',
    'turn_call_record(uuid,bigint,integer,text,numeric,numeric,jsonb,text,text,text)',
    'turn_close(uuid,bigint,text,jsonb,boolean,boolean,text)'] LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;

COMMIT;
