-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-10, read only: two reads of what the receipts already hold. No table, no write.
--   turn_resume_read  a turn paused for credits: what its limits leave and its receipts, oldest first, through the paused turns it
--                     itself continued. A resume replays those receipts instead of calling the model or a supplier again, so the
--                     work is done and charged once ("断点续跑不重复收费"). Reusing turn_call_raw needs no checkpoint table: a model
--                     receipt is the whole completion, a paid tool's is what its suppliers returned, and a free tool costs nothing
--                     to run again. Nothing is written at the pause.
--   turn_session_view adds `calls`: the paid tool calls behind the shown replies, so a reload keeps the work rows.
--   turn_resume_carry counts a benchmark call's rows against limits.toolRows, as turn_call_begin does; by paidTools alone a mentor
--                     paused after one could never be resumed. It also carries nothing from the first receipt that cannot be
--                     replayed (a cost the recovery lookup finished holds no completion): that call is made again, and the user
--                     pays for it once. What was spent on the first attempt is the platform's, recorded in absorbed_credits.
--   turn_pause_save   written once, only at a pause: what the user asked, as a hidden message of the paused turn, so a resume needs
--                     nothing from the browser (another device can continue). session_messages goes with the conversation and
--                     the account; turn_resume_close and turn_close remove the row when the paused turn ends (resume or 24-hour expiry).
CREATE OR REPLACE FUNCTION public.turn_session_view(p_actor_id uuid, p_session_id uuid, p_after_seq integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions; a turns; l turns;
BEGIN
  -- A disabled or deleted account reads nothing, as every other read (bill2_actor) and turn_open refuse it.
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_actor_id AND status = 'active' AND is_deleted::text = 'false') THEN
    RAISE EXCEPTION 'TURN_ACCOUNT_DENIED' USING ERRCODE='42501';
  END IF;
  SELECT * INTO s FROM runtime_sessions WHERE id = p_session_id AND actor_id = p_actor_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'TURN_SESSION_DENIED' USING ERRCODE='42501'; END IF;
  IF s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'TURN_SESSION_ERASED' USING ERRCODE='42501'; END IF;
  -- The conversation's whole scope is session_view_allowed, called first by Node (view.ts); a draft revoked since then is refused
  -- here, in the same snapshot as the messages.
  IF s.scope->>'kind' = 'positioning_draft' AND NOT (turn_mentor_draft_allowed(p_actor_id, (s.scope->>'draftId')::uuid)
      AND turn_mentor_source_live((s.scope->>'draftId')::uuid)) THEN
    RAISE EXCEPTION 'TURN_SESSION_DENIED' USING ERRCODE='42501';
  END IF;
  IF s.active_turn_id IS NOT NULL THEN SELECT * INTO a FROM turns WHERE actor_id = p_actor_id AND id = s.active_turn_id; END IF;
  SELECT * INTO l FROM turns WHERE session_id = p_session_id AND actor_id = p_actor_id AND state = 'closed'
    ORDER BY opened_at DESC LIMIT 1;
  RETURN jsonb_build_object(
    'activeTurn', CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('turnId', a.id, 'kind', a.kind, 'state', a.state,
      'pauseReason', a.pause_reason, 'openedAt', a.opened_at, 'updatedAt', a.updated_at) END,
    'lastTurn', CASE WHEN l.id IS NULL THEN NULL ELSE jsonb_build_object('turnId', l.id, 'kind', l.kind, 'closeKind', l.close_kind,
      'failureCode', l.failure_code, 'settlement', l.settlement, 'chargedCredits', l.charged_credits, 'closedAt', l.closed_at) END,
    'messages', (SELECT coalesce(jsonb_agg(jsonb_build_object('seq', m.seq, 'role', m.role, 'turnId', m.turn_id, 'content', m.content)
        ORDER BY m.seq), '[]'::jsonb)
      FROM (SELECT seq, role, turn_id, content FROM session_messages
            WHERE session_id = p_session_id AND visible AND deleted_at IS NULL AND seq > greatest(coalesce(p_after_seq, 0), 0)
            ORDER BY seq LIMIT 50) m),
    -- The paid tool calls behind those replies, for the work rows a reload shows again (Owner 10-02): a reply's own turn and the
    -- paused turns it continued. What was asked is the tool call in the model receipt just before; a receipt that holds none
    -- gives null. Owner's key only; nothing is written.
    'calls', (WITH RECURSIVE shown AS (
        SELECT DISTINCT m.turn_id AS reply, m.turn_id AS id FROM (SELECT seq, turn_id FROM session_messages
            WHERE session_id = p_session_id AND visible AND deleted_at IS NULL AND seq > greatest(coalesce(p_after_seq, 0), 0)
            ORDER BY seq LIMIT 50) m
        UNION ALL
        SELECT x.reply, t.resume_of FROM shown x JOIN turns t ON t.actor_id = p_actor_id AND t.id = x.id WHERE t.resume_of IS NOT NULL)
      SELECT coalesce(jsonb_agg(jsonb_build_object('turnId', x.reply, 'seq', c.seq, 'toolName', c.tool_name, 'status', c.status,
          'usage', c.usage, 'q', t.policy->'q', 'multiplier', c.multiplier,
          -- The model call that asked: a benchmark lookup settles in several rows, so not always the row just before.
          'arguments', (SELECT r.body::jsonb #>> '{choices,0,message,tool_calls,0,function,arguments}' FROM turn_call_raw r
            JOIN turn_calls m ON m.turn_id = r.turn_id AND m.seq = r.seq
            WHERE r.turn_id = c.turn_id AND r.seq < c.seq AND m.call_kind = 'model' ORDER BY r.seq DESC LIMIT 1)) ORDER BY t.id, c.seq), '[]'::jsonb)
      FROM shown x JOIN turns t ON t.actor_id = p_actor_id AND t.id = x.id AND t.session_id = p_session_id
      JOIN turn_calls c ON c.turn_id = t.id AND c.call_kind = 'tool' AND c.upper_usd > 0 AND c.status IN ('ok', 'unusable')));
END $function$;

CREATE OR REPLACE FUNCTION public.turn_resume_break(p_actor_id uuid, p_turn_id bigint)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE found_at integer;
BEGIN
  -- The first call of this turn a resume cannot answer from its receipt (none: 2147483647). Each turn of a chain has its own: what a
  -- turn made after an earlier turn's break is exactly the calls that break made again, so it follows that turn's good receipts.
  SELECT min(c.seq) INTO found_at FROM turn_calls c LEFT JOIN turn_call_raw r ON r.turn_id = c.turn_id AND r.seq = c.seq
   WHERE c.turn_id = p_turn_id AND c.status IN ('ok','unusable') AND c.call_kind IN ('model','tool')
     AND NOT (c.call_kind = 'tool' AND c.upper_usd = 0)
     AND NOT coalesce(CASE c.call_kind WHEN 'model' THEN position('"choices"' IN r.body) > 0 ELSE r.body LIKE '[%' END, false);
  RETURN coalesce(found_at, 2147483647);
END $function$;

CREATE OR REPLACE FUNCTION public.turn_pause_save(p_actor_id uuid, p_turn_id bigint, p_input jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; s runtime_sessions; body text := p_input::text; next_seq integer;
BEGIN
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id;
  IF t.id IS NULL OR t.session_id IS NULL THEN RETURN false; END IF;
  SELECT * INTO s FROM runtime_sessions WHERE id = t.session_id AND actor_id = p_actor_id FOR UPDATE;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id;
  IF s.id IS NULL OR s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL OR t.state IS DISTINCT FROM 'paused'
    OR t.pause_reason IS DISTINCT FROM 'waiting_credits' THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM session_messages WHERE session_id = s.id AND turn_id = t.id AND NOT visible) THEN RETURN true; END IF;
  SELECT coalesce(max(seq), 0) + 1 INTO next_seq FROM session_messages WHERE session_id = s.id;
  INSERT INTO session_messages (session_id, seq, role, turn_id, content, content_hash, visible)
    VALUES (s.id, next_seq, 'user', t.id, body, encode(sha256(convert_to(body, 'UTF8')), 'hex'), false);
  RETURN true;
END $function$;

CREATE OR REPLACE FUNCTION public.turn_resume_read(p_actor_id uuid, p_session_id uuid, p_turn_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions; t turns; n_model integer; n_paid integer; n_free integer; n_decision integer; broke integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_actor_id AND status = 'active' AND is_deleted::text = 'false') THEN
    RAISE EXCEPTION 'TURN_ACCOUNT_DENIED' USING ERRCODE='42501';
  END IF;
  SELECT * INTO s FROM runtime_sessions WHERE id = p_session_id AND actor_id = p_actor_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'TURN_SESSION_DENIED' USING ERRCODE='42501'; END IF;
  IF s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'TURN_SESSION_ERASED' USING ERRCODE='42501'; END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id AND session_id = p_session_id;
  -- As turn_resume_carry, which checks all of this again under the locks.
  IF t.id IS NULL OR s.active_turn_id IS DISTINCT FROM t.id OR t.state IS DISTINCT FROM 'paused'
    OR t.pause_reason IS DISTINCT FROM 'waiting_credits' THEN RAISE EXCEPTION 'TURN_RESUME_DENIED' USING ERRCODE='55000'; END IF;
  -- A call that will be made again does not use up the limits (turn_resume_carry counts the same way).
  broke := public.turn_resume_break(p_actor_id, t.id);
  SELECT count(*) FILTER (WHERE call_kind = 'model'), count(*) FILTER (WHERE call_kind = 'tool' AND upper_usd > 0),
         count(*) FILTER (WHERE call_kind = 'tool' AND upper_usd = 0), count(*) FILTER (WHERE call_kind = 'decision')
    INTO n_model, n_paid, n_free, n_decision
  FROM turn_calls WHERE turn_id = t.id AND status NOT IN ('not_sent','rejected','no_charge_402') AND (seq < broke OR call_kind = 'decision');
  RETURN jsonb_build_object('kind', t.kind,
    'limits', jsonb_build_object('model', (t.policy->'limits'->>'model')::int - n_model,
      'paidTools', coalesce((t.policy->'limits'->>'toolRows')::int, (t.policy->'limits'->>'paidTools')::int) - n_paid, 'freeTools', (t.policy->'limits'->>'freeTools')::int - n_free,
      'decisions', greatest(coalesce((t.policy->'limits'->>'decisions')::int, 0) - n_decision, 0)),
    'decided', EXISTS (SELECT 1 FROM turn_calls WHERE turn_id = t.id AND call_kind = 'decision' AND status = 'ok'),
    'input', (SELECT m.content::jsonb FROM session_messages m WHERE m.session_id = s.id AND m.turn_id = t.id AND NOT m.visible LIMIT 1),
    'calls', (WITH RECURSIVE chain AS (
        SELECT t.id AS id, t.resume_of AS previous
        UNION ALL
        SELECT x.id, x.resume_of FROM chain c JOIN turns x ON x.actor_id = p_actor_id AND x.id = c.previous)
      SELECT coalesce(jsonb_agg(jsonb_build_object('seq', c.seq, 'callKind', c.call_kind, 'toolName', c.tool_name, 'status', c.status,
          'body', r.body) ORDER BY c.turn_id, c.seq), '[]'::jsonb)
      FROM chain x JOIN turn_calls c ON c.turn_id = x.id AND c.call_kind IN ('model', 'tool') AND c.status IN ('ok', 'unusable')
        AND NOT (c.call_kind = 'tool' AND c.upper_usd = 0) AND c.seq < public.turn_resume_break(p_actor_id, c.turn_id)
      LEFT JOIN turn_call_raw r ON r.turn_id = c.turn_id AND r.seq = c.seq));
END $function$;

CREATE OR REPLACE FUNCTION public.turn_resume_carry(p_actor_id uuid, p_session_id uuid, p_active_turn_id bigint, p_resume_of bigint, p_kind text, p_policy jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE prior turns; n_model integer; n_paid integer; n_free integer; n_decision integer; carried integer; broke integer;
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
  -- What is left of the paused turn's frozen limits, counted as turn_call_begin counts them: the new turn may use no more. From the
  -- first receipt that cannot be replayed the calls are made again: they use no limit and carry no charge.
  broke := public.turn_resume_break(p_actor_id, p_resume_of);
  SELECT count(*) FILTER (WHERE call_kind = 'model'),
         count(*) FILTER (WHERE call_kind = 'tool' AND upper_usd > 0),
         count(*) FILTER (WHERE call_kind = 'tool' AND upper_usd = 0),
         count(*) FILTER (WHERE call_kind = 'decision')
    INTO n_model, n_paid, n_free, n_decision
  FROM turn_calls WHERE turn_id = p_resume_of AND status NOT IN ('not_sent','rejected','no_charge_402') AND (seq < broke OR call_kind = 'decision');
  IF (p_policy->'limits'->>'model')::int > (prior.policy->'limits'->>'model')::int - n_model
    -- Rows, not calls: a benchmark call settles in several (limits.toolRows, as turn_call_begin counts them).
    OR coalesce((p_policy->'limits'->>'toolRows')::int, (p_policy->'limits'->>'paidTools')::int)
       > coalesce((prior.policy->'limits'->>'toolRows')::int, (prior.policy->'limits'->>'paidTools')::int) - n_paid
    OR (p_policy->'limits'->>'freeTools')::int > (prior.policy->'limits'->>'freeTools')::int - n_free
    OR coalesce((p_policy->'limits'->>'decisions')::int, 0) > coalesce((prior.policy->'limits'->>'decisions')::int, 0) - n_decision THEN
    RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
  END IF;
  -- What the paused turn would charge now (D = min(N, H), N over its known receipts plus what it carried itself). It is not
  -- charged there: it is carried into the turn that continues it and settled with it, once, by that turn's rule (a fixed
  -- price stays the fixed price; an expiry refunds the whole chain).
  SELECT least(ceil((prior.policy->>'q')::numeric * coalesce(sum(nominal_usd * multiplier)
           FILTER (WHERE status = 'ok' AND call_kind <> 'decision' AND seq < broke), 0))::integer
           + coalesce((prior.policy->>'carriedCredits')::int, 0),
         prior.reserved_credits + coalesce((prior.policy->>'carriedCredits')::int, 0))
    INTO carried
  FROM turn_calls WHERE turn_id = p_resume_of;
  RETURN carried;
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
  -- A kind without a branch has its result refused rather than dropped.
  IF p_kind_result IS NOT NULL THEN
    IF t.kind = 'mentor' THEN
      -- V2-5c: what this turn's research made, on any close that saves anything (paid lookups stay paid when the reply failed).
      IF v_kind <> 'erased' AND p_kind_result ? 'research' THEN PERFORM public.research_turn_apply(p_actor_id, t, p_kind_result->'research'); END IF;
      -- V2-5: the organizer's checklist patches; only a delivered completed turn applies them (an erased one saves nothing).
      IF v_kind = 'completed' AND p_delivered AND p_kind_result ? 'organizerInput' THEN kind_result := public.turn_mentor_apply(p_actor_id, p_turn_id, p_kind_result); END IF;
    ELSIF t.kind = 'report' THEN
      PERFORM public.turn_report_apply(t, v_kind, p_kind_result);
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

  -- Credits: settled once; with an unknown model cost the whole freeze waits for recovery (one freeze is settled exactly once).
  -- settlement stays 'pending' while any provider cost is unknown, so recovery still settles the stop-loss; a repeated credit
  -- settlement of the same freeze returns the first one.
  IF NOT user_pending AND t.policy->>'holdId' IS NOT NULL THEN
    PERFORM public.turn_settle_credits(p_actor_id, (t.policy->>'holdId')::uuid, charge, p_turn_id);
  END IF;

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
  IF t.policy->>'holdId' IS NOT NULL THEN
    PERFORM public.turn_settle_credits(p_actor_id, (t.policy->>'holdId')::uuid, 0, p_turn_id);
  END IF;
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

REVOKE ALL ON FUNCTION public.turn_resume_break(uuid,bigint) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.turn_resume_read(uuid,uuid,bigint), public.turn_pause_save(uuid,bigint,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.turn_resume_read(uuid,uuid,bigint), public.turn_pause_save(uuid,bigint,jsonb) TO service_role;
