-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 start threshold (number 0496 assigned by the controller; Owner 2026-10-28 restating 10-01: "按 10-01 的决定：余额够
-- 一轮正常费用就能开始，冻结取上限和余额的较小值，不够时中途暂停提示充值。"). The turn's policy carries minCredits = L, the start
-- threshold of BILL-PAYG (max(1, ceil(typicalUsd x q x m)) per model and purpose, billing_payg_start_thresholds). What changes:
--   turn_open         the available balance (not the freeze) is held against L, as bill2_payg_claim; the freeze stays
--                     H = min(G_turn, A), which may be below L when the turn's bound is
--   turn_call_begin   a call pauses the turn only when the remaining freeze is below min(G_i, L), so a turn whose freeze was
--                     capped by the balance still sends its call; the part above the freeze is absorbed by the platform
--   turn_call_record  credits_low uses the same threshold
-- Compatibility: a policy without minCredits keeps the earlier rule (G_i). Repeatable: whole CREATE OR REPLACE of the three
-- functions (from 0421 as applied). Recovery: re-run 0421's definitions of these three functions; no data changes.
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

  -- 1. The account row first, then the session: one turn at a time per conversation (3a). The account comes first as in the
  -- erasure functions (they hold it before the session), so an open and a deletion of the same conversation never deadlock.
  SELECT * INTO prof FROM profiles WHERE id = p_actor_id FOR UPDATE;
  SELECT * INTO s FROM runtime_sessions WHERE id = p_session_id AND actor_id = p_actor_id FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'TURN_SESSION_DENIED' USING ERRCODE='42501'; END IF;
  -- 2. The same request again: the turn it opened, unchanged.
  SELECT * INTO existing FROM turns WHERE actor_id = p_actor_id AND request_id = p_request_id;
  IF existing.id IS NOT NULL THEN
    IF existing.session_id IS DISTINCT FROM p_session_id OR existing.kind <> p_kind THEN
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

    -- 4. Credits: H = min(G_turn, available); below the start threshold the turn does not open. The balance is read under the
    -- account lock taken first: two sessions of one account in different stop-loss buckets never size H on the same balance.
    -- The account is checked again here (same lock) before anything is frozen.
    SELECT * INTO prof FROM profiles WHERE id = p_actor_id;
    IF prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false'
      OR EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_actor_id) THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_ERASING' USING ERRCODE='42501';
    END IF;
    g := (p_policy->>'gCredits')::int;
    available := greatest(public.credit_available(p_actor_id), 0);
    -- The balance, not the freeze, is held against the start threshold L (as bill2_payg_claim): a balance that covers one
    -- normal turn starts it, and the freeze H may be below L when one call's bound G is (Owner 10-28, restating 10-01).
    IF available < (p_policy->>'minCredits')::int THEN RAISE EXCEPTION 'TURN_INSUFFICIENT_CREDITS' USING ERRCODE='P0001'; END IF;
    h := least(g, available);
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
        AND r.closed_at > now() - interval '24 hours')) END,
    -- Per-kind context for the prompt (2.7). Each kind reads its input from p_policy->'<kind>' and adds its own branch here
    -- (CASE p_kind WHEN '<kind>' THEN public.turn_<kind>_context(...) END); no kind has one yet.
    'kindContext', NULL::jsonb);
END $function$;

CREATE OR REPLACE FUNCTION public.turn_call_begin(p_actor_id uuid, p_turn_id bigint, p_seq integer, p_call_kind text, p_model_id uuid, p_tool_name text, p_paid boolean, p_request_hash text, p_upper_usd numeric, p_multiplier numeric)
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
  -- The remaining freeze must cover min(G_i, L): this call's bound G_i = ceil(q x U_i x m_i), or the start threshold L when the
  -- freeze was capped by the balance (H = min(G, A), Owner 10-01 and 10-28: a balance that covers one normal turn starts it; the
  -- part of a call above the freeze is the platform's, E = N - D). Below that the turn waits for credits. The positioning check
  -- is never charged to the user (Owner 10-12): it needs no freeze; its upper bound counts in U_turn and the stop-loss only.
  q := (t.policy->>'q')::numeric;
  SELECT coalesce(sum(CASE WHEN status = 'ok' THEN ceil(q * nominal_usd * multiplier)
                           WHEN status IN ('dispatched','identified','unknown') THEN ceil(q * upper_usd * multiplier)
                           ELSE 0 END), 0) INTO used
  FROM turn_calls WHERE turn_id = p_turn_id AND call_kind <> 'decision';
  need := CASE WHEN p_call_kind = 'decision' THEN 0
    ELSE least(ceil(q * p_upper_usd * p_multiplier), coalesce((t.policy->>'minCredits')::numeric, ceil(q * p_upper_usd * p_multiplier))) END;
  IF t.reserved_credits - used < need THEN
    UPDATE turns SET state = 'paused', pause_reason = 'waiting_credits', updated_at = now() WHERE actor_id = p_actor_id AND id = p_turn_id;
    RETURN jsonb_build_object('state', 'paused', 'paused', true) || turn_tombstones(p_actor_id, t.session_id, t.policy);
  END IF;
  INSERT INTO turn_calls (actor_id, turn_id, seq, call_kind, model_id, tool_name, request_hash, upper_usd, multiplier)
    VALUES (p_actor_id, p_turn_id, p_seq, p_call_kind, p_model_id, p_tool_name, p_request_hash, p_upper_usd, p_multiplier);
  UPDATE turns SET updated_at = now() WHERE actor_id = p_actor_id AND id = p_turn_id;
  RETURN jsonb_build_object('state', 'running', 'status', 'dispatched', 'replay', false) || turn_tombstones(p_actor_id, t.session_id, t.policy);
END $function$;

CREATE OR REPLACE FUNCTION public.turn_call_record(p_actor_id uuid, p_turn_id bigint, p_seq integer, p_status text, p_nominal_usd numeric, p_actual_usd numeric, p_usage jsonb, p_provider_id text, p_payload_hash text, p_raw text)
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
        payload_hash = p_payload_hash, settled_at = clock_timestamp(), cost_pending = false
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
  RETURN jsonb_build_object('status', p_status, 'creditsLow', t.reserved_credits - used < next_need) || tomb;
END $function$;

COMMIT;
