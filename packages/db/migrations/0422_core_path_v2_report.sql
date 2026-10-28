-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-7a (placeholder number; the controller assigns the real one before it goes to the database): kind=report on the
-- turn core (docs/launch/tasks/CORE-PATH-V2.md 2.2, 2.5, 2.7, 4.1, 4.4; Owner 10-17 fixed price, 10-27 stop rule, 10-28 only
-- reports can be stopped). The report's logic is in its own functions; turn_open and turn_close only dispatch to them (the 0421
-- per-kind hook), rebuilt whole on their latest text:
--   turn_report_admit       turn_open, new report: switch, today's fixed price (acceptedCredits), one-call shape, the round's
--                           module, membership, confirmed source, benchmarks, one paid report per round; its result is the
--                           report's kindContext (source and benchmark table)
--   turn_stop               the user's stop of a running report: first two in 24 hours free; from the third it asks, and once
--                           confirmed charges what was generated (at most the fixed price); the decision is frozen on the turn
--   turn_report_close_kind  turn_close: a stopping report closes as stopped however the run ended
--   turn_report_apply       turn_close's kind result: the report text, hidden from history, cut to what the user saw on a stop
--   turn_report_settlement  turn_close: what the user pays and whether it waits for an unknown cost (only a charged stop does)
--   turn_report_read        the report turn of a round (or one turn) with its saved text
-- Compatibility: nothing calls kind=report until the page switches (V2-10); other kinds are unchanged; the old report path is
-- untouched. Repeatable: CREATE OR REPLACE throughout. Recovery: re-apply 0421's turn_open and turn_close, drop the new functions.
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
  -- The stop's frozen fields are written by turn_stop only.
  IF rep IS NULL OR jsonb_typeof(rep) <> 'object' OR p_policy ?| ARRAY['stoppedAt','stopChargeable','stopAt'] THEN
    RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
  END IF;
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
    'source', source, 'benchmarks', public.research_benchmark_rows(p_actor_id, p_session_id));
END $function$;

-- A report's close kind: a stop the user asked for (turn_stop) is honoured however the run ended (the reply finished first, the
-- aborted stream, recovery); a failure that refunds everything keeps its full refund.
CREATE OR REPLACE FUNCTION public.turn_report_close_kind(t turns, p_kind text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN t.state = 'stopping' AND p_kind IN ('completed','interrupted') THEN 'stopped' ELSE p_kind END
$function$;

-- What a report keeps from its result (the per-kind hook of turn_close): its text, hidden from the conversation history
-- (visible=false, found by its turn); a stopped report keeps what the user saw (turn_stop's stopAt, in characters). Nothing is
-- kept for a report that did not complete or stop (failed, interrupted, erased).
CREATE OR REPLACE FUNCTION public.turn_report_apply(t turns, p_kind text, p_result jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE body text; next_seq integer;
BEGIN
  IF jsonb_typeof(p_result) <> 'object' OR jsonb_typeof(p_result->'body') <> 'string' OR (SELECT count(*) FROM jsonb_object_keys(p_result)) <> 1 THEN
    RAISE EXCEPTION 'TURN_KIND_RESULT_INVALID' USING ERRCODE='22023';
  END IF;
  IF p_kind NOT IN ('completed','stopped') OR t.session_id IS NULL THEN RETURN; END IF;
  body := CASE WHEN p_kind = 'stopped' AND t.policy ? 'stopAt' THEN left(p_result->>'body', (t.policy->>'stopAt')::int)
    ELSE p_result->>'body' END;
  SELECT coalesce(max(seq), 0) + 1 INTO next_seq FROM session_messages WHERE session_id = t.session_id;
  INSERT INTO session_messages (session_id, seq, role, turn_id, content, content_hash, visible)
    VALUES (t.session_id, next_seq, 'assistant', t.id, body, encode(sha256(convert_to(body, 'UTF8')), 'hex'), false);
END $function$;

-- What the user pays for a report and whether that waits for an unknown provider cost (Owner 10-17: a complete report pays the
-- fixed price; cut off, failed, interrupted, expired or deleted pays nothing; 10-27: a stop pays what turn_stop told the user).
-- Only a charged stop depends on the provider cost; every other report settles the user at once. A stop closed without
-- turn_stop's decision keeps the 24-hour count of turn_user_charge.
CREATE OR REPLACE FUNCTION public.turn_report_settlement(t turns, p_kind text, p_delivered boolean, p_credits integer,
  p_held integer, p_at timestamp with time zone, OUT charge integer, OUT settle_now boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE fixed integer := coalesce((t.policy->>'fixedCredits')::int, p_held); chargeable boolean := (t.policy->>'stopChargeable')::boolean;
BEGIN
  IF p_kind = 'completed' THEN charge := CASE WHEN p_delivered THEN least(fixed, p_held) ELSE 0 END; settle_now := true;
  ELSIF p_kind <> 'stopped' THEN charge := 0; settle_now := true;
  ELSIF chargeable IS NULL THEN
    charge := public.turn_user_charge(t.actor_id, t.id, 'stopped', false, false, p_credits, p_held, fixed, p_at); settle_now := false;
  ELSE charge := CASE WHEN chargeable THEN least(p_credits, p_held, fixed) ELSE 0 END; settle_now := NOT chargeable;
  END IF;
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
    IF p_kind = 'report' THEN report := public.turn_report_admit(p_actor_id, p_session_id, p_policy); END IF;
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
        AND r.closed_at > now() - interval '24 hours')) END,
    -- Per-kind context for the prompt (2.7). Each kind reads its input from p_policy->'<kind>' and adds its own branch here
    -- (CASE p_kind WHEN '<kind>' THEN public.turn_<kind>_context(...) END); no kind has one yet.
    'kindContext', CASE WHEN p_kind = 'report' THEN report END);
END $function$;

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
  -- Lock order as turn_open, turn_close and the erasure functions: the account, the session, the turn. The account row also
  -- serializes this account's stops, so two stops at once never both count as free.
  PERFORM 1 FROM profiles WHERE id = p_actor_id FOR UPDATE;
  IF t.session_id IS NOT NULL THEN PERFORM 1 FROM runtime_sessions WHERE id = t.session_id FOR UPDATE; END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id FOR UPDATE;
  -- Pressed again, or the report ended first: what happened, unchanged.
  IF t.state IN ('stopping','closed') THEN
    RETURN jsonb_build_object('turnId', t.id, 'state', t.state, 'closeKind', t.close_kind, 'chargedCredits', t.charged_credits,
      'chargeable', coalesce((t.policy->>'stopChargeable')::boolean, false), 'replay', true);
  END IF;
  IF t.state <> 'running' THEN RAISE EXCEPTION 'TURN_NOT_RUNNING' USING ERRCODE='55000'; END IF;
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
      IF t.charged_credits IS NULL AND NOT user_pending THEN
        charge := CASE WHEN t.kind = 'report' THEN (public.turn_report_settlement(t, t.close_kind, t.delivered, credits, t.reserved_credits, t.closed_at)).charge
          ELSE public.turn_user_charge(p_actor_id, p_turn_id, t.close_kind, t.delivered,
          coalesce((t.policy->>'closeRefundAll')::boolean, false), credits, t.reserved_credits, (t.policy->>'fixedCredits')::int, t.closed_at) END;
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
  IF t.kind = 'report' THEN v_kind := public.turn_report_close_kind(t, v_kind); END IF;
  tomb := turn_tombstones(p_actor_id, t.session_id, t.policy);
  IF v_kind IN ('completed','stopped') AND ((tomb->>'sessionTombstoned')::boolean OR (tomb->>'accountErasing')::boolean
    OR (tomb->>'voiceSourceRevoked')::boolean) THEN v_kind := 'erased'; END IF;
  -- The per-kind hook: what a kind keeps from its result (a draft, a report, a verdict) is written in the same transaction as the
  -- close, by that kind's own function (e.g. turn_mentor_apply(t, v_kind, p_kind_result)), one branch per kind:
  --   IF t.kind = '<kind>' THEN PERFORM public.turn_<kind>_apply(...); ELSE ... END IF;
  -- No kind has one yet, so a result is refused rather than dropped.
  IF t.kind = 'report' AND p_kind_result IS NOT NULL THEN PERFORM public.turn_report_apply(t, v_kind, p_kind_result);
  ELSIF p_kind_result IS NOT NULL THEN
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
  h := t.reserved_credits;

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
  RETURN jsonb_build_object('turnId', t.id, 'state', t.state, 'closeKind', t.close_kind, 'delivered', t.delivered AND t.close_kind = 'completed',
    'chargedCredits', t.charged_credits, 'settlement', t.settlement, 'fixedCredits', (t.policy->>'fixedCredits')::int,
    'stopChargeable', (t.policy->>'stopChargeable')::boolean, 'report', t.policy->'report', 'body', body,
    'openedAt', t.opened_at, 'closedAt', t.closed_at);
END $function$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'turn_report_admit(uuid,uuid,jsonb)', 'turn_report_close_kind(turns,text)', 'turn_report_apply(turns,text,jsonb)',
    'turn_report_settlement(turns,text,boolean,integer,integer,timestamp with time zone)',
    'turn_open(uuid,uuid,uuid,text,jsonb,bigint)', 'turn_stop(uuid,bigint,boolean,integer)',
    'turn_close(uuid,bigint,text,jsonb,boolean,boolean,text,jsonb)', 'turn_report_read(uuid,uuid,uuid,bigint)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
  -- The report helpers stay internal (turn_open's and turn_close's dispatch).
  FOREACH f IN ARRAY ARRAY[
    'turn_open(uuid,uuid,uuid,text,jsonb,bigint)', 'turn_stop(uuid,bigint,boolean,integer)',
    'turn_close(uuid,bigint,text,jsonb,boolean,boolean,text,jsonb)', 'turn_report_read(uuid,uuid,uuid,bigint)'] LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;

COMMIT;
