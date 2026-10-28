-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-7a (number to be assigned by the controller): kind=report on the turn core (docs/launch/tasks/CORE-PATH-V2.md
-- sections 2.2, 2.5, 2.7, 4.1, 4.4; Owner 10-17 fixed price, 10-27 stop rule, 10-28 only reports can be stopped).
--   turn_report_admit  inside turn_open, for a new report: the switch, the fixed price the button showed is today's price, the
--                      one-call shape, membership, the confirmed source (report_source), an active module, the benchmark gate
--                      and one paid report per round; returns the frozen report identity, the source and the benchmark table
--   turn_open          the report branch above (whole function, otherwise unchanged)
--   turn_stop          the user's stop of a running report: within 24 hours the first two are free, from the third the stop
--                      waits for the user's confirmation and then charges what was generated (at most the fixed price); the
--                      decision is frozen on the turn, so the close charges what the user was told; state -> stopping
--   turn_close         report rules only (whole function, otherwise unchanged): a stopping turn closes as stopped however
--                      the run ended, its saved text cut to what the user saw; a stop charges its frozen decision; a report
--                      that is not complete or stopped pays nothing (failed, interrupted, expired, erased: Owner 10-17); every
--                      report except a charged stop settles the user at once even while the provider cost is unknown; a
--                      report's text is stored hidden from the conversation history (visible=false), found by its turn;
--                      and (all kinds) the close's moment is read under the account lock, so two stops closing at once count
--                      each other (0421 compared against the transaction's start time and could miss the other close)
--   turn_report_read   the report turn of a round (or one turn): state, close, charge, stop decision and the saved text
-- Compatibility: nothing calls kind=report until the page switches (V2-10); the old report path is untouched.
-- Repeatable: CREATE OR REPLACE throughout. Recovery: re-apply 0421's turn_open and turn_close, drop the three new functions.
BEGIN;
SET LOCAL lock_timeout='5s';

-- Called only from turn_open, after the session, stop-loss bucket and account rows are locked (report_membership_check locks the
-- account row again, which this transaction already holds).
CREATE OR REPLACE FUNCTION public.turn_report_admit(p_actor_id uuid, p_session_id uuid, p_policy jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE flag jsonb; rep jsonb := p_policy->'report'; source jsonb; spec jsonb; item jsonb; scope jsonb; required integer;
  fixed integer;
BEGIN
  SELECT value::jsonb INTO flag FROM system_settings WHERE key = 'runtime_report_generation';
  IF flag IS DISTINCT FROM '{"enabled":true}'::jsonb THEN RAISE EXCEPTION 'REPORT_DISABLED' USING ERRCODE='P0001'; END IF;
  IF jsonb_typeof(rep) <> 'object' OR rep->>'projectId' !~ '^[0-9a-f-]{36}$' OR rep->>'roundId' !~ '^[0-9a-f-]{36}$'
    OR rep->>'moduleId' !~ '^[0-9a-f-]{36}$' THEN
    RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
  END IF;
  -- The price the button showed (acceptedCredits, checked by Node against fixedCredits) must be today's price.
  fixed := public.report_fixed_price();
  IF jsonb_typeof(p_policy->'fixedCredits') <> 'number' OR (p_policy->>'fixedCredits')::numeric <> fixed THEN
    RAISE EXCEPTION 'REPORT_PRICE_CHANGED' USING ERRCODE='P0001';
  END IF;
  -- One model call, no tools, no history; the whole price and the call's bound are frozen or nothing opens (0295 REPORT_CREDITS).
  IF (p_policy->'limits'->>'model')::int <> 1 OR (p_policy->'limits'->>'paidTools')::int <> 0
    OR (p_policy->'limits'->>'freeTools')::int <> 0 OR coalesce((p_policy->'limits'->>'decisions')::int, 0) <> 0
    OR (p_policy->>'historyItems')::int <> 0 OR (p_policy->>'gCredits')::int < fixed
    OR (p_policy->>'minCredits')::int <> (p_policy->>'gCredits')::int THEN
    RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM public.report_membership_check(p_actor_id);
  source := public.report_source(p_actor_id, p_session_id, (rep->>'projectId')::uuid, (rep->>'roundId')::uuid);
  spec := source#>'{workflow,reportGeneration}';
  IF spec IS NULL THEN RAISE EXCEPTION 'REPORT_MANIFEST_REQUIRED' USING ERRCODE='P0001'; END IF;
  FOR item IN SELECT value FROM jsonb_each(source#>'{snapshot,steps}') LOOP
    IF item->>'valid' IS DISTINCT FROM 'true' OR item->>'confirmationId' IS NULL OR item->>'body' IS NULL
      OR item->>'available' = 'false' THEN RAISE EXCEPTION 'REPORT_CONFIRMATION_REQUIRED' USING ERRCODE='P0001'; END IF;
  END LOOP;
  -- The model, and so the call's bound, was chosen for the module Node named; it must be the round's, and still offered (the
  -- Skill text is read from the process cache by package hash).
  IF source->>'moduleId' IS DISTINCT FROM rep->>'moduleId' OR NOT EXISTS (SELECT 1 FROM modules m WHERE m.id = (source->>'moduleId')::uuid AND m.active) THEN
    RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT' USING ERRCODE='P0001';
  END IF;
  -- 0268 benchmark gate, or the user's frozen "generate" choice (0320), as report_admission_check.
  SELECT s.scope INTO scope FROM runtime_sessions s WHERE s.id = p_session_id;
  required := public.research_benchmark_required(scope, spec);
  IF public.research_benchmark_qualified(p_actor_id, p_session_id) < required
    AND NOT public.research_benchmark_shortfall_accepted(p_actor_id, p_session_id, required) THEN
    RAISE EXCEPTION 'REPORT_BENCHMARKS_REQUIRED' USING ERRCODE='P0001';
  END IF;
  -- One paid report per round: one still going, or a complete one delivered, blocks a new start (a stopped, failed or cut-off
  -- one does not: a new start pays again, Owner 10-17).
  IF EXISTS (SELECT 1 FROM turns r WHERE r.session_id = p_session_id AND r.actor_id = p_actor_id AND r.kind = 'report'
      AND r.policy#>>'{report,roundId}' = rep->>'roundId'
      AND (r.state <> 'closed' OR (r.close_kind = 'completed' AND r.delivered))) THEN
    RAISE EXCEPTION 'REPORT_ALREADY_EXISTS' USING ERRCODE='P0001';
  END IF;
  RETURN jsonb_build_object(
    'frozen', jsonb_build_object('projectId', rep->>'projectId', 'roundId', rep->>'roundId',
      'moduleId', source->>'moduleId', 'snapshotHash', source->>'snapshotHash',
      'sections', spec->'sections', 'maxCharacters', spec->'maxCharacters'),
    'source', source, 'benchmarks', public.research_benchmark_rows(p_actor_id, p_session_id));
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
  u_turn numeric; g integer; h integer; available integer; hold uuid; frozen jsonb; history jsonb; report jsonb;
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
    OR p_policy ?| ARRAY['day','bucket','holdId','heldCredits','stoppedAt','stopChargeable','stopAt']
    OR (p_kind = 'report') <> (p_policy ? 'report') THEN
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

    -- 4. Credits: H = min(G_turn, available); below the start threshold the turn does not open. The account row is locked before
    -- the balance is read: two sessions of one account in different stop-loss buckets would otherwise both size H on the same
    -- balance, and the second would be refused instead of freezing what is left. Order: session, bucket, account (as turn_close).
    -- Re-checked under the lock: an erasure that held it (account_erasure_confirm) may have committed while this waited.
    SELECT * INTO prof FROM profiles WHERE id = p_actor_id FOR UPDATE;
    IF prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false'
      OR EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_actor_id) THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_ERASING' USING ERRCODE='42501';
    END IF;
    -- A report is admitted here, under the same locks as its freeze (V2-7a): price, membership, source, one per round.
    IF p_kind = 'report' THEN report := public.turn_report_admit(p_actor_id, p_session_id, p_policy); END IF;
    g := (p_policy->>'gCredits')::int;
    available := greatest(public.credit_available(p_actor_id), 0);
    h := least(g, available);
    IF h < (p_policy->>'minCredits')::int THEN RAISE EXCEPTION 'TURN_INSUFFICIENT_CREDITS' USING ERRCODE='P0001'; END IF;
    IF h > 0 THEN
      SELECT pre_deduct_id INTO hold FROM public.atomic_pre_deduct(p_actor_id, h, 'AI turn freeze', p_request_id);
    END IF;

    frozen := p_policy || jsonb_build_object('day', v_day, 'bucket', v_bucket, 'holdId', hold, 'heldCredits', h)
      || CASE WHEN report IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('report', report->'frozen') END;
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
  -- free chat, the positioning gate (confirmed positioning; refusals in 24 hours, counted on the turns refused for it); for a new
  -- report, its frozen identity, confirmed source and benchmark table (a replay runs nothing, so it gets none).
  RETURN jsonb_build_object('turnId', t.id, 'state', t.state, 'replay', existing.id IS NOT NULL,
    'reservedCredits', t.reserved_credits, 'reservedUsd', t.reserved_usd, 'history', history,
    'replyLanguage', prof.reply_language,
    'positioning', CASE WHEN p_kind = 'chat' THEN jsonb_build_object(
      'positioned', public.opc_has_confirmed_positioning(p_actor_id),
      'refusals24h', (SELECT count(*) FROM turns r WHERE r.actor_id = p_actor_id AND r.failure_code = 'positioning_required'
        AND r.closed_at > now() - interval '24 hours')) END,
    'report', CASE WHEN report IS NULL THEN NULL
      ELSE jsonb_build_object('frozen', report->'frozen', 'source', report->'source', 'benchmarks', report->'benchmarks') END);
END $function$;

-- The user's stop of a running report (Owner 10-27, 10-28). Lock order as turn_close: session, turn, account.
CREATE OR REPLACE FUNCTION public.turn_stop(p_actor_id uuid, p_turn_id bigint, p_confirmed boolean, p_stop_at integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; n integer;
BEGIN
  IF p_stop_at IS NOT NULL AND p_stop_at < 0 THEN RAISE EXCEPTION 'TURN_STOP_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id;
  IF t.id IS NULL THEN RAISE EXCEPTION 'TURN_DENIED' USING ERRCODE='42501'; END IF;
  IF t.kind <> 'report' THEN RAISE EXCEPTION 'TURN_STOP_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
  IF t.session_id IS NOT NULL THEN PERFORM 1 FROM runtime_sessions WHERE id = t.session_id FOR UPDATE; END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id FOR UPDATE;
  -- Pressed again, or the report ended first: what happened, unchanged.
  IF t.state IN ('stopping','closed') THEN
    RETURN jsonb_build_object('turnId', t.id, 'state', t.state, 'closeKind', t.close_kind, 'chargedCredits', t.charged_credits,
      'chargeable', coalesce((t.policy->>'stopChargeable')::boolean, false), 'replay', true);
  END IF;
  IF t.state <> 'running' THEN RAISE EXCEPTION 'TURN_NOT_RUNNING' USING ERRCODE='55000'; END IF;
  -- The account row serializes this account's stops, so two stops at once never both count as free.
  PERFORM 1 FROM profiles WHERE id = p_actor_id FOR UPDATE;
  SELECT count(*) INTO n FROM turns r WHERE r.actor_id = p_actor_id AND r.kind = 'report' AND r.stopped_by_user AND r.id <> p_turn_id
    AND coalesce(r.closed_at, (r.policy->>'stoppedAt')::timestamptz) > now() - interval '24 hours';
  IF n >= 2 AND NOT coalesce(p_confirmed, false) THEN
    RETURN jsonb_build_object('turnId', t.id, 'state', 'confirmation_required', 'chargeable', true,
      'fixedCredits', (t.policy->>'fixedCredits')::int, 'replay', false);
  END IF;
  UPDATE turns SET state = 'stopping', stopped_by_user = true, updated_at = now(),
      policy = policy || jsonb_build_object('stoppedAt', now(), 'stopChargeable', n >= 2)
        || CASE WHEN p_stop_at IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('stopAt', p_stop_at) END
    WHERE actor_id = p_actor_id AND id = p_turn_id;
  RETURN jsonb_build_object('turnId', t.id, 'state', 'stopping', 'closeKind', NULL, 'chargedCredits', NULL,
    'chargeable', n >= 2, 'replay', false);
END $function$;

CREATE OR REPLACE FUNCTION public.turn_close(p_actor_id uuid, p_turn_id bigint, p_close_kind text, p_messages jsonb DEFAULT '[]'::jsonb, p_delivered boolean DEFAULT false, p_refund_all boolean DEFAULT false, p_failure_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  t turns; s runtime_sessions; q numeric; n_total numeric; pending_upper numeric; credits integer; charge integer; h integer;
  v_kind text := p_close_kind; tomb jsonb; next_seq integer; msg jsonb; pending boolean; user_pending boolean;
  marker timestamptz; body text;
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
      PERFORM 1 FROM profiles WHERE id = p_actor_id FOR UPDATE;
      q := (t.policy->>'q')::numeric;
      SELECT ceil(q * coalesce(sum(nominal_usd * multiplier) FILTER (WHERE status = 'ok' AND call_kind <> 'decision'), 0))::integer,
             coalesce(bool_or(cost_pending), false), coalesce(bool_or(cost_pending AND call_kind = 'model'), false)
        INTO credits, pending, user_pending
      FROM turn_calls WHERE turn_id = p_turn_id;
      IF t.charged_credits IS NULL AND NOT user_pending THEN
        -- A user stop charges what the user was told when they stopped (turn_stop's frozen decision).
        charge := CASE WHEN t.close_kind = 'stopped' AND t.policy ? 'stopChargeable'
          THEN CASE WHEN (t.policy->>'stopChargeable')::boolean
            THEN least(credits, t.reserved_credits, coalesce((t.policy->>'fixedCredits')::int, t.reserved_credits)) ELSE 0 END
          ELSE public.turn_user_charge(p_actor_id, p_turn_id, t.close_kind, t.delivered,
            coalesce((t.policy->>'closeRefundAll')::boolean, false), credits, t.reserved_credits, (t.policy->>'fixedCredits')::int,
            t.closed_at) END;
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
  -- The user stopped it (turn_stop): however the run ended (the reply finished first, the aborted stream, recovery), it is the
  -- stopped report. A failure that refunds everything keeps its full refund.
  IF t.state = 'stopping' AND v_kind IN ('completed','interrupted') THEN v_kind := 'stopped'; END IF;
  -- A tombstone wins: nothing is saved and the turn closes as erased.
  tomb := turn_tombstones(p_actor_id, t.session_id, t.policy);
  IF v_kind IN ('completed','stopped') AND ((tomb->>'sessionTombstoned')::boolean OR (tomb->>'accountErasing')::boolean
    OR (tomb->>'voiceSourceRevoked')::boolean) THEN v_kind := 'erased'; END IF;

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
  h := t.reserved_credits;
  -- A report's charge depends on its provider cost only for a charged stop (Owner 10-17: complete pays the fixed price, failed,
  -- cut off, interrupted or deleted pays nothing; 10-27: a free stop pays nothing): every other report settles the user now,
  -- even while the provider cost is unknown; only the platform's cost and the stop-loss wait for recovery.
  IF t.kind = 'report' AND NOT (v_kind = 'stopped' AND coalesce((t.policy->>'stopChargeable')::boolean, true)) THEN
    user_pending := false;
  END IF;

  -- Stop-loss: what is known is spent; the reservation of calls with an unknown cost stays until recovery settles them.
  UPDATE daily_spend SET spent_usd = spent_usd + n_total,
      reserved_usd = greatest(reserved_usd - (t.reserved_usd - pending_upper), 0)
    WHERE day = (t.policy->>'day')::date AND bucket = (t.policy->>'bucket')::smallint;
  -- The account row: serializes the actor's closes (the free-stop count below) before the settlement locks it again.
  PERFORM 1 FROM profiles WHERE id = p_actor_id FOR UPDATE;
  -- The close's moment, read under the account lock: another close of this account that held the lock has committed its
  -- closed_at before it, so the 24-hour stop count sees it (now() is this transaction's start and could be earlier, #1512 race).
  marker := clock_timestamp();

  -- What the user pays (turn_user_charge: D = min(N, H), the stop and fixed-price rules); a user stop pays what turn_stop said;
  -- a report that is neither complete nor stopped pays nothing.
  charge := CASE WHEN t.kind = 'report' AND v_kind NOT IN ('completed','stopped') THEN 0
    WHEN v_kind = 'stopped' AND t.policy ? 'stopChargeable'
    THEN CASE WHEN (t.policy->>'stopChargeable')::boolean THEN least(credits, h, coalesce((t.policy->>'fixedCredits')::int, h)) ELSE 0 END
    ELSE public.turn_user_charge(p_actor_id, p_turn_id, v_kind, p_delivered, p_refund_all, credits, h,
      (t.policy->>'fixedCredits')::int, marker) END;

  -- Credits: settled once; with an unknown model cost the whole freeze waits for recovery (one freeze is settled exactly once).
  -- settlement stays 'pending' while any provider cost is unknown, so recovery still settles the stop-loss; a repeated credit
  -- settlement of the same freeze returns the first one.
  IF NOT user_pending AND t.policy->>'holdId' IS NOT NULL THEN
    PERFORM public.turn_settle_credits(p_actor_id, (t.policy->>'holdId')::uuid, charge, p_turn_id);
  END IF;

  -- The messages of a delivered turn, appended in order. A report's text is not conversation history (visible=false, found by
  -- its turn); a stopped report keeps what the user saw (turn_stop's stopAt, in characters).
  IF v_kind IN ('completed','stopped') AND t.session_id IS NOT NULL AND jsonb_typeof(p_messages) = 'array' THEN
    SELECT coalesce(max(seq), 0) INTO next_seq FROM session_messages WHERE session_id = t.session_id;
    FOR msg IN SELECT value FROM jsonb_array_elements(p_messages) LOOP
      next_seq := next_seq + 1;
      body := CASE WHEN v_kind = 'stopped' AND msg->>'role' = 'assistant' AND t.policy ? 'stopAt'
        THEN left(msg->>'content', (t.policy->>'stopAt')::int) ELSE msg->>'content' END;
      INSERT INTO session_messages (session_id, seq, role, turn_id, content, content_hash, visible)
        VALUES (t.session_id, next_seq, msg->>'role', p_turn_id, body, encode(sha256(convert_to(body, 'UTF8')), 'hex'),
          t.kind <> 'report');
    END LOOP;
  END IF;

  -- updated_at marks this settlement pass (see the closed branch above); a full refund still owed is kept with the turn.
  UPDATE turns SET state = 'closed', pause_reason = NULL, close_kind = v_kind, closed_at = marker, updated_at = clock_timestamp(),
      policy = CASE WHEN user_pending AND p_refund_all THEN policy || '{"closeRefundAll": true}'::jsonb ELSE policy END,
      charged_credits = CASE WHEN user_pending THEN NULL ELSE charge END,
      absorbed_credits = CASE WHEN user_pending THEN NULL ELSE greatest(credits - charge, 0) END,
      settlement = CASE WHEN pending THEN 'pending' ELSE 'done' END,
      -- A stopped report is never a delivered (complete) report.
      stopped_by_user = (v_kind = 'stopped'), delivered = p_delivered AND v_kind = 'completed',
      failure_code = p_failure_code
    WHERE actor_id = p_actor_id AND id = p_turn_id RETURNING * INTO t;
  IF s.id IS NOT NULL AND s.active_turn_id = p_turn_id THEN UPDATE runtime_sessions SET active_turn_id = NULL WHERE id = s.id; END IF;
  RETURN jsonb_build_object('turnId', t.id, 'closeKind', t.close_kind, 'chargedCredits', t.charged_credits,
    'absorbedCredits', t.absorbed_credits, 'settlement', t.settlement, 'replay', false) || tomb;
END $function$;

-- The newest report turn of a round in a session (p_turn_id NULL), or one report turn; its text unless the conversation was deleted.
CREATE OR REPLACE FUNCTION public.turn_report_read(p_actor_id uuid, p_session_id uuid, p_round_id uuid, p_turn_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; body text; visible boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM runtime_sessions s WHERE s.id = p_session_id AND s.actor_id = p_actor_id) THEN
    RAISE EXCEPTION 'TURN_SESSION_DENIED' USING ERRCODE='42501';
  END IF;
  SELECT * INTO t FROM turns r WHERE r.session_id = p_session_id AND r.actor_id = p_actor_id AND r.kind = 'report'
      AND (p_turn_id IS NULL OR r.id = p_turn_id) AND (p_round_id IS NULL OR r.policy#>>'{report,roundId}' = p_round_id::text)
    ORDER BY r.opened_at DESC, r.id DESC LIMIT 1;
  IF t.id IS NULL THEN RETURN NULL; END IF;
  visible := NOT (turn_tombstones(p_actor_id, p_session_id, '{}'::jsonb)->>'sessionTombstoned')::boolean
    AND NOT (turn_tombstones(p_actor_id, p_session_id, '{}'::jsonb)->>'accountErasing')::boolean;
  IF visible THEN
    SELECT m.content INTO body FROM session_messages m
     WHERE m.session_id = p_session_id AND m.turn_id = t.id AND m.role = 'assistant' AND m.deleted_at IS NULL
     ORDER BY m.seq DESC LIMIT 1;
  END IF;
  RETURN jsonb_build_object('turnId', t.id, 'state', t.state, 'closeKind', t.close_kind, 'delivered', t.delivered,
    'chargedCredits', t.charged_credits, 'settlement', t.settlement, 'fixedCredits', (t.policy->>'fixedCredits')::int,
    'stopChargeable', (t.policy->>'stopChargeable')::boolean, 'report', t.policy->'report', 'body', body,
    'openedAt', t.opened_at, 'closedAt', t.closed_at);
END $function$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'turn_report_admit(uuid,uuid,jsonb)', 'turn_open(uuid,uuid,uuid,text,jsonb,bigint)',
    'turn_stop(uuid,bigint,boolean,integer)', 'turn_close(uuid,bigint,text,jsonb,boolean,boolean,text)',
    'turn_report_read(uuid,uuid,uuid,bigint)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
  -- turn_report_admit stays internal (turn_open's report branch).
  FOREACH f IN ARRAY ARRAY[
    'turn_open(uuid,uuid,uuid,text,jsonb,bigint)', 'turn_stop(uuid,bigint,boolean,integer)',
    'turn_close(uuid,bigint,text,jsonb,boolean,boolean,text)', 'turn_report_read(uuid,uuid,uuid,bigint)'] LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;

COMMIT;
