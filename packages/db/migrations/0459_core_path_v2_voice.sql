-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-12 B7 (number set by the controller): kind=voice, "学习我的文风" on the turn core instead of a sessionless BILL2 run.
-- Same product as the old path (voice_generation_*, admitVoiceRun): one organizer-model call on the account's corpus, no tools, no
-- estimate shown; the user pays what the call cost only when a usable profile was saved, otherwise the whole freeze comes back.
-- A voice generation belongs to the account, not to a conversation (turns.session_id is nullable already), so turn_open takes no
-- session for it and the missing session is not a tombstone. The kind's logic is in its own functions; turn_open, turn_close,
-- turn_tombstones and turn_user_charge only dispatch to them, rebuilt whole on their text as staging has it after 0456.
--   turns_kind_check      adds 'voice'
--   turn_voice_context    turn_open's per-kind context: the frozen policy shape, and whether the version is still generating
--   turn_voice_apply      turn_close's kind result: the parsed profile, written to the version in the close's transaction
--   turn_voice_revoked    whether a voice turn's version is deleted or no longer generating (a separate plpgsql function so no other kind
--                         pays a relation lock for it)
--   turn_tombstones       a voice turn's source is its version: that reads as voiceSourceRevoked
--   turn_user_charge      a voice turn that saved no profile pays nothing
--   turn_call_record      a receipt arriving after a voice version was deleted does not store its answer
--   voice_delete_versions also deletes the call receipts a generation of the deleted versions saved, and locks its open turn
-- Compatibility: nothing calls kind=voice until the code deploys (apply this first); the old voice path and every other kind are
-- unchanged, and old code reads the wider CHECK as before.
-- Repeatable: DROP CONSTRAINT IF EXISTS then ADD, CREATE OR REPLACE throughout.
-- Recovery: stop calling kind=voice; re-apply 0456's state of turn_open, turn_close, turn_tombstones, turn_user_charge and
-- voice_delete_versions (packages/db/functions at that commit), drop the two voice functions, and restore the CHECK after deleting any
-- kind='voice' rows (staging test data only; no production database has this yet). A saved profile lives in voice_profile_versions
-- and needs no restoring.

BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE public.turns DROP CONSTRAINT IF EXISTS turns_kind_check;
ALTER TABLE public.turns ADD CONSTRAINT turns_kind_check
  CHECK (kind IN ('chat','mentor','report','plan','compare','jury','jury_adopt','review','voice'));

CREATE OR REPLACE FUNCTION public.turn_voice_context(p_actor_id uuid, p_policy jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE voice jsonb := p_policy->'voice';
BEGIN
  -- One model call and no tools; the version being written is the only thing the policy names.
  IF jsonb_typeof(voice) IS DISTINCT FROM 'object' OR jsonb_typeof(voice->'versionId') IS DISTINCT FROM 'string'
    OR (SELECT count(*) FROM jsonb_object_keys(voice)) <> 1
    OR voice->>'versionId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR (p_policy->'limits'->>'model')::int <> 1 OR (p_policy->'limits'->>'paidTools')::int <> 0
    OR (p_policy->'limits'->>'freeTools')::int <> 0 OR coalesce((p_policy->'limits'->>'decisions')::int, 0) <> 0
    -- Metered by usage, no fixed price (the old path's rule for a voice run).
    OR p_policy ? 'fixedCredits' THEN
    RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
  END IF;
  -- generating is false for a repeat of a finished request (the caller reads the first one's result by its version) and for a
  -- version deleted meanwhile (nothing starts; a tombstone ends one that did).
  RETURN jsonb_build_object('generating', EXISTS (SELECT 1 FROM voice_profile_versions v WHERE v.actor_id = p_actor_id
    AND v.id = (voice->>'versionId')::uuid AND v.status = 'generating'));
END $function$;

-- plpgsql on purpose: a SQL function body (or a subquery inside turn_tombstones itself) is planned, and its tables locked, by every
-- turn of every kind; here the table is touched only by a voice turn (the turn budget counts relation locks per call).
CREATE OR REPLACE FUNCTION public.turn_voice_revoked(p_actor_id uuid, p_policy jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN NOT EXISTS (SELECT 1 FROM voice_profile_versions v WHERE v.actor_id = p_actor_id
    AND v.id::text = p_policy->'voice'->>'versionId' AND v.status = 'generating');
END $function$;

CREATE OR REPLACE FUNCTION public.turn_voice_apply(t turns, p_kind text, p_result jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- {versionId, profile}: the profile the caller parsed and checked against the corpus (voice.ts); nothing else is accepted.
  IF jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR jsonb_typeof(p_result->'profile') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_result->'versionId') IS DISTINCT FROM 'string' OR (SELECT count(*) FROM jsonb_object_keys(p_result)) <> 2
    OR p_result->>'versionId' IS DISTINCT FROM t.policy->'voice'->>'versionId' THEN
    RAISE EXCEPTION 'TURN_KIND_RESULT_INVALID' USING ERRCODE='22023';
  END IF;
  -- Only a completed close saves the profile; an erased one (the version was deleted, the account is leaving) saves nothing.
  IF p_kind <> 'completed' THEN RETURN; END IF;
  UPDATE voice_profile_versions SET profile = p_result->'profile', failure = NULL, billing_settled = true,
      status = CASE WHEN corpus = voice_current_corpus(t.actor_id) THEN 'draft' ELSE 'stale' END, updated_at = clock_timestamp()
    WHERE id = (p_result->>'versionId')::uuid AND actor_id = t.actor_id AND status = 'generating';
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
  IF p_kind NOT IN ('chat','mentor','report','plan','compare','jury','jury_adopt','review','voice') THEN
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
  -- A voice generation (V2-12 B7) belongs to the account, not to a conversation: it has no session, and one is refused.
  IF p_kind = 'voice' THEN
    IF p_session_id IS NOT NULL THEN RAISE EXCEPTION 'TURN_SESSION_DENIED' USING ERRCODE='42501'; END IF;
  ELSE
    SELECT * INTO s FROM runtime_sessions WHERE id = p_session_id AND actor_id = p_actor_id FOR UPDATE;
    IF s.id IS NULL THEN RAISE EXCEPTION 'TURN_SESSION_DENIED' USING ERRCODE='42501'; END IF;
  END IF;
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
    IF p_kind NOT IN ('jury','jury_adopt','voice') THEN UPDATE runtime_sessions SET active_turn_id = t.id WHERE id = s.id; END IF;
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
      WHEN 'plan' THEN public.turn_plan_context(p_actor_id, p_session_id, p_policy)
      WHEN 'voice' THEN public.turn_voice_context(p_actor_id, p_policy) END);
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
    ELSIF t.kind = 'voice' THEN
      PERFORM public.turn_voice_apply(t, v_kind, p_kind_result);
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

CREATE OR REPLACE FUNCTION public.turn_tombstones(p_actor_id uuid, p_session_id uuid, p_policy jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT jsonb_build_object(
  -- A voice generation has no conversation (V2-12 B7), so the missing session is not a tombstone.
  'sessionTombstoned', CASE WHEN p_policy ? 'voice' THEN false ELSE p_session_id IS NULL OR NOT EXISTS (SELECT 1 FROM runtime_sessions s
    WHERE s.id = p_session_id AND s.actor_id = p_actor_id AND s.content_deleted_at IS NULL AND s.erased_at IS NULL) END,
  'accountErasing', EXISTS (SELECT 1 FROM account_erasure_requests r WHERE r.profile_id = p_actor_id),
  -- For a voice generation the source is the version being written: deleted (or no longer generating) means the work is void.
  'voiceSourceRevoked', CASE WHEN p_policy ? 'voice' THEN public.turn_voice_revoked(p_actor_id, p_policy)
    ELSE p_policy ? 'voiceVersionId' AND NOT EXISTS (SELECT 1 FROM voice_profiles v WHERE v.actor_id = p_actor_id
      AND v.enabled AND v.confirmed_version_id::text = p_policy->>'voiceVersionId') END)
$function$;

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

CREATE OR REPLACE FUNCTION public.voice_delete_versions(a uuid, ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE n integer;
BEGIN
 INSERT INTO voice_billing_scrubs(run_id,actor_id,outcome)
 SELECT billing_run_id,a,CASE WHEN profile IS NULL THEN 'confirmed_failure' ELSE 'cancelled' END
 FROM voice_profile_versions WHERE actor_id=a AND id=ANY(ids) AND billing_run_id IS NOT NULL
 ON CONFLICT(run_id) DO NOTHING;
 DELETE FROM voice_profile_versions WHERE actor_id=a AND id=ANY(ids);
 GET DIAGNOSTICS n=ROW_COUNT;
 -- CORE-PATH-V2: replies written with a deleted version leave the visible history (Owner 10-23: effective at once). The
 -- open turns bound to it are locked first, so a turn that closes waits for this commit, re-reads its tombstones, closes
 -- erased and saves nothing. The callers hold the account row (library_actor), which turn_close takes before its turn row,
 -- so a turn row held here is only ever held by a call write (turn row only): waiting on it cannot deadlock.
 PERFORM 1 FROM turns WHERE actor_id=a AND state<>'closed' AND ((policy ? 'voiceVersionId' AND policy->>'voiceVersionId'=ANY(ids::text[]))
   OR (kind='voice' AND policy->'voice'->>'versionId'=ANY(ids::text[]))) ORDER BY id FOR UPDATE;
 -- V2-12 B7: what a generation of these versions saved on its receipts (the model's answer, derived from the user's own documents).
 DELETE FROM turn_call_raw r USING turns t WHERE t.actor_id=a AND t.kind='voice' AND t.policy->'voice'->>'versionId'=ANY(ids::text[])
  AND r.turn_id=t.id;
 UPDATE session_messages m SET visible=false FROM turns t
  WHERE t.actor_id=a AND t.policy ? 'voiceVersionId' AND t.policy->>'voiceVersionId'=ANY(ids::text[])
   AND m.session_id=t.session_id AND m.turn_id=t.id AND m.visible;
 RETURN n;
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
    -- A voice generation's answer quotes the user's own documents: once its version is deleted (voiceSourceRevoked) a receipt that
    -- arrives later is not stored either (V2-12 B7; voice_delete_versions removes what was stored before).
    IF p_raw IS NOT NULL AND NOT (tomb->>'sessionTombstoned')::boolean AND NOT (tomb->>'accountErasing')::boolean
      AND NOT (t.policy ? 'voice' AND (tomb->>'voiceSourceRevoked')::boolean) THEN
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

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['turn_voice_context(uuid,jsonb)','turn_voice_apply(turns,text,jsonb)','turn_voice_revoked(uuid,jsonb)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
END $$;

COMMIT;
