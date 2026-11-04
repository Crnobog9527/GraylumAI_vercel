-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PUBLISH-MONITOR (the file carries the placeholder number 9999 until the controller assigns the real one): the numbers a coach reads from
-- the user's back-office screenshots in a free chat are saved as per-post diagnoses for the weekly review (Owner 2026-11-04,
-- "B 存下截图里的数字"). The image is never kept; only the numbers, the label as read, and which screenshot of the message.
--   * turn_chat_screenshots_apply(actor, items): one diagnosis row per post and UTC day (a correction on a later day carries the earlier screenshot's other numbers forward) in social_post_diagnostics (source
--     'screenshot'). A second save of the same post on the same day merges by metric, the newest value wins, and confirmed_at is
--     the correction time (created_at stays the first save). An item whose post is not the actor's, or that fails a column CHECK, is
--     skipped on its own; it never raises.
--   * turn_close (whole function, as 0459 defines it): ONE new branch, `t.kind = 'chat'`, applies p_kind_result->'coachScreenshots'
--     for a delivered completed turn, inside a savepoint so a failure there cannot change the close, the settlement or the charge.
--     Every other line of the function is byte-for-byte 0459's. A chat close without a kind result behaves exactly as before.
-- Compatibility: new function; turn_close keeps its signature, output and every existing branch; old code never passes a chat kind
-- result. Repeatable: CREATE OR REPLACE plus REVOKE. Recovery: re-apply turn_close as 0459 defines it and DROP the new function; the
-- saved rows are ordinary social_post_diagnostics rows the weekly review already reads (source 'screenshot' is allowed since 0457).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.turn_chat_screenshots_apply(p_actor_id uuid, p_items jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  it jsonb; v_post uuid; v_biz uuid; v_platform text; v_rates jsonb; v_raw jsonb; v_text text; v_video integer; v_drop integer; prev social_post_diagnostics;
  v_day date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) > 6 THEN RETURN; END IF;
  FOR it IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    BEGIN
      IF jsonb_typeof(it) IS DISTINCT FROM 'object' OR jsonb_typeof(it->'rates') IS DISTINCT FROM 'object'
        OR it->>'postId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN CONTINUE; END IF;
      v_post := (it->>'postId')::uuid;
      v_rates := it->'rates';
      IF (SELECT count(*) FROM jsonb_each(v_rates)) NOT BETWEEN 1 AND 30
        OR EXISTS (SELECT 1 FROM jsonb_each(v_rates) WHERE jsonb_typeof(value) IS DISTINCT FROM 'number') THEN CONTINUE; END IF;
      v_raw := CASE WHEN jsonb_typeof(it->'raw') = 'object' THEN it->'raw' END;
      v_text := CASE WHEN jsonb_typeof(it->'openingText') = 'string' THEN left(it->>'openingText', 2000) END;
      v_video := CASE WHEN jsonb_typeof(it->'videoSeconds') = 'number' THEN (it->>'videoSeconds')::integer END;
      v_drop := CASE WHEN jsonb_typeof(it->'dropSecond') = 'number' THEN (it->>'dropSecond')::integer END;
      SELECT c.business_id, c.platform INTO v_biz, v_platform FROM social_posts sp JOIN social_connections c ON c.id = sp.connection_id
       WHERE sp.id = v_post AND sp.actor_id = p_actor_id AND c.role = 'own';
      IF NOT FOUND OR v_biz IS NULL THEN CONTINUE; END IF;
      -- A correction a day or more after the screenshot carries the other numbers of that screenshot forward (the newest pack row of
      -- a post is the one the review reads, so a row holding only the corrected number would hide the rest). Only a screenshot
      -- diagnosis from the last 7 days is carried; the same UTC day is merged by the conflict clause below.
      SELECT * INTO prev FROM social_post_diagnostics d WHERE d.post_id = v_post AND d.source = 'screenshot'
         AND d.captured_on < v_day AND d.captured_on >= v_day - 7 ORDER BY d.captured_on DESC LIMIT 1;
      IF FOUND THEN
        v_rates := coalesce(prev.rates, '{}'::jsonb) || v_rates;
        v_raw := CASE WHEN prev.rates_raw IS NULL AND v_raw IS NULL THEN NULL ELSE coalesce(prev.rates_raw, '{}'::jsonb) || coalesce(v_raw, '{}'::jsonb) END;
        v_text := coalesce(v_text, prev.opening_text); v_video := coalesce(v_video, prev.video_seconds); v_drop := coalesce(v_drop, prev.drop_second);
      END IF;
      INSERT INTO social_post_diagnostics(actor_id, business_id, post_id, platform, source, rates, rates_raw, opening_text,
          video_seconds, drop_second, captured_on, confirmed_at)
        VALUES (p_actor_id, v_biz, v_post, v_platform, 'screenshot', v_rates, v_raw, v_text, v_video, v_drop, v_day, clock_timestamp())
        ON CONFLICT (post_id, captured_on) DO UPDATE SET
          rates = social_post_diagnostics.rates || EXCLUDED.rates,
          rates_raw = CASE WHEN EXCLUDED.rates_raw IS NULL THEN social_post_diagnostics.rates_raw
            ELSE coalesce(social_post_diagnostics.rates_raw, '{}'::jsonb) || EXCLUDED.rates_raw END,
          opening_text = coalesce(EXCLUDED.opening_text, social_post_diagnostics.opening_text),
          video_seconds = coalesce(EXCLUDED.video_seconds, social_post_diagnostics.video_seconds),
          drop_second = coalesce(EXCLUDED.drop_second, social_post_diagnostics.drop_second),
          source = 'screenshot', confirmed_at = clock_timestamp();
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'turn_chat_screenshots_apply skipped an item: %', SQLERRM;
    END;
  END LOOP;
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
    ELSIF t.kind = 'chat' THEN
      -- PUBLISH-MONITOR: the numbers the coach read from the user's screenshots in this reply. Best effort: a failure here never
      -- touches the close or the settlement below (the savepoint rolls back only the diagnostics), and only a delivered completed
      -- turn saves them (an erased or failed one saves nothing). Any other chat result is still refused, as before.
      IF jsonb_typeof(p_kind_result) IS DISTINCT FROM 'object' OR NOT p_kind_result ? 'coachScreenshots'
        OR (SELECT count(*) FROM jsonb_object_keys(p_kind_result)) <> 1 THEN
        RAISE EXCEPTION 'TURN_KIND_RESULT_UNSUPPORTED' USING ERRCODE='22023';
      END IF;
      IF v_kind = 'completed' AND p_delivered THEN
        BEGIN
          PERFORM public.turn_chat_screenshots_apply(p_actor_id, p_kind_result->'coachScreenshots');
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'turn_chat_screenshots_apply failed: %', SQLERRM;
        END;
      END IF;
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

REVOKE ALL ON FUNCTION public.turn_chat_screenshots_apply(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
