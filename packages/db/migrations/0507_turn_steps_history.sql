BEGIN;
SET LOCAL lock_timeout='5s';

-- TURN-STEPS history (Owner 2026-11-04): a reply's step list ("已读取「分镜脚本」方法", "已搜索，找到 6 条结果") stays above the reply after
-- a reload. What is kept is only a tool kind, an end state, a Skill's public catalog name, a count of results and a fixed reason: no
-- argument, no search words, no result or Skill text (so nothing of what the user wrote is kept here, and account erasure has nothing
-- more to clear: the column lives on the turn row, which erasure already treats as a money record without content).
--
--   turns.steps              jsonb array, NULL until the reply's close; at most 16 steps and 4096 bytes.
--   turn_chat_steps_apply    the shape check and the write, called only by turn_close (revoked from every role, as 0503's
--                            turn_chat_screenshots_apply): the actor's own turn, set once, never raises for a bad shape (it answers false).
--   turn_close               the whole function again, as 0503 defines it: ONE changed branch, `t.kind = 'chat'`: a chat result may now
--                            hold `steps` beside `coachScreenshots`, applied for a delivered completed turn inside its own savepoint, so a
--                            failure there cannot change the close, the settlement or the charge. Every other line is byte-for-byte
--                            0503's. The signature, the output and every other branch are unchanged; a chat close without a kind result,
--                            or with only `coachScreenshots`, behaves exactly as before. The steps are written in the close's own
--                            transaction (the turn's three writes stay three: open, receipt, close).
--   turn_session_view        the whole function again (the view a reload reads): each assistant message also carries its turn's steps.
--
-- Repeatable: the column is IF NOT EXISTS, the constraint is guarded, the functions are CREATE OR REPLACE. Compatibility: old code never
-- passes `steps`; the new view only adds a key. Recovery: put turn_close back to 0503's text and turn_session_view to 0450's, then DROP
-- FUNCTION public.turn_chat_steps_apply(uuid,bigint,jsonb) and (if the data is to go too) `ALTER TABLE public.turns DROP COLUMN IF EXISTS steps;`.

ALTER TABLE public.turns ADD COLUMN IF NOT EXISTS steps jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.turns'::regclass AND conname = 'turns_steps_check') THEN
    ALTER TABLE public.turns ADD CONSTRAINT turns_steps_check
      CHECK (steps IS NULL OR (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) <= 16 AND octet_length(steps::text) <= 4096)) NOT VALID;
  END IF;
END $$;

-- NOT VALID then VALIDATE: the check on the existing rows (all NULL) runs without holding writers off the turns table.
ALTER TABLE public.turns VALIDATE CONSTRAINT turns_steps_check;

CREATE OR REPLACE FUNCTION public.turn_chat_steps_apply(p_actor_id uuid, p_turn_id bigint, p_steps jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE item jsonb; k text;
BEGIN
  IF p_steps IS NULL OR jsonb_typeof(p_steps) <> 'array' OR jsonb_array_length(p_steps) NOT BETWEEN 1 AND 16
     OR octet_length(p_steps::text) > 4096 THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_steps) LOOP
    IF jsonb_typeof(item) <> 'object' OR NOT (item ? 'id' AND item ? 'tool' AND item ? 'state') THEN RETURN false; END IF;
    FOR k IN SELECT jsonb_object_keys(item) LOOP
      IF k NOT IN ('id', 'tool', 'state', 'label', 'count', 'reason') THEN RETURN false; END IF;
    END LOOP;
    -- A saved step has ended: "running" is never kept.
    IF jsonb_typeof(item->'id') <> 'string' OR char_length(item->>'id') > 8
       OR jsonb_typeof(item->'tool') <> 'string' OR (item->>'tool') NOT IN ('load_skill', 'research', 'read_source', 'coach_review', 'other')
       OR jsonb_typeof(item->'state') <> 'string' OR (item->>'state') NOT IN ('done', 'failed', 'skipped') THEN RETURN false; END IF;
    IF item ? 'label' AND (jsonb_typeof(item->'label') <> 'string' OR char_length(item->>'label') > 80) THEN RETURN false; END IF;
    IF item ? 'count' AND (jsonb_typeof(item->'count') <> 'number' OR (item->>'count') !~ '^[0-9]{1,6}$') THEN RETURN false; END IF;
    IF item ? 'reason' AND (jsonb_typeof(item->'reason') <> 'string' OR (item->>'reason') <> 'no_brand') THEN RETURN false; END IF;
  END LOOP;
  UPDATE public.turns SET steps = p_steps WHERE actor_id = p_actor_id AND id = p_turn_id AND steps IS NULL;
  RETURN FOUND;
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
      -- PUBLISH-MONITOR: the numbers the coach read from the user's screenshots in this reply, and TURN-STEPS: the steps the reply
      -- showed (a tool kind, an end state, a Skill's public name, a count). Both are best effort: a failure in either never touches
      -- the close or the settlement below (each has its own savepoint that rolls back only itself), and only a delivered completed
      -- turn saves them (an erased or failed one saves nothing). A chat result holds at most these two keys; any other is still
      -- refused, as before.
      IF jsonb_typeof(p_kind_result) IS DISTINCT FROM 'object' OR p_kind_result = '{}'::jsonb
        OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_kind_result) AS k(key) WHERE k.key NOT IN ('coachScreenshots', 'steps')) THEN
        RAISE EXCEPTION 'TURN_KIND_RESULT_UNSUPPORTED' USING ERRCODE='22023';
      END IF;
      IF v_kind = 'completed' AND p_delivered AND p_kind_result ? 'coachScreenshots' THEN
        BEGIN
          PERFORM public.turn_chat_screenshots_apply(p_actor_id, p_kind_result->'coachScreenshots');
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'turn_chat_screenshots_apply failed: %', SQLERRM;
        END;
      END IF;
      IF v_kind = 'completed' AND p_delivered AND p_kind_result ? 'steps' THEN
        BEGIN
          PERFORM public.turn_chat_steps_apply(p_actor_id, p_turn_id, p_kind_result->'steps');
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'turn_chat_steps_apply failed: %', SQLERRM;
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
    'messages', (SELECT coalesce(jsonb_agg(jsonb_build_object('seq', m.seq, 'role', m.role, 'turnId', m.turn_id, 'content', m.content,
          -- The page's handle of a topic reply (V2-10b): its turn's request id, what the topic draft and the adoption name.
          'requestId', (SELECT r.request_id FROM turns r WHERE r.actor_id = p_actor_id AND r.id = m.turn_id),
          -- A Skill reply of a work item (V2-10b C2): what the page offers to adopt.
          'workSkill', (SELECT r.policy ? 'workSkill' FROM turns r WHERE r.actor_id = p_actor_id AND r.id = m.turn_id),
          -- The request a resumed turn continues: what a video package is named by.
          'rootRequestId', opc_turn_root_request(p_actor_id, m.turn_id),
          -- The steps the reply showed while it was written (turn_chat_steps_apply, called by turn_close): only a tool kind, an end state, a Skill's public name
          -- and a count. Of the assistant's message only; NULL for a reply written before steps were kept.
          'steps', CASE WHEN m.role = 'assistant' THEN (SELECT r.steps FROM turns r WHERE r.actor_id = p_actor_id AND r.id = m.turn_id) END)
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
          -- Along the resume chain: a resumed turn's first real call may follow the model receipt of the turn it continued.
          'arguments', (WITH RECURSIVE up AS (SELECT t.id AS id, 0 AS depth, t.resume_of AS previous
              UNION ALL SELECT p.id, u.depth + 1, p.resume_of FROM up u JOIN turns p ON p.actor_id = p_actor_id AND p.id = u.previous)
            SELECT r.body::jsonb #>> '{choices,0,message,tool_calls,0,function,arguments}' FROM up u
              JOIN turn_calls m ON m.turn_id = u.id AND m.call_kind = 'model' AND (u.depth > 0 OR m.seq < c.seq)
              JOIN turn_call_raw r ON r.turn_id = m.turn_id AND r.seq = m.seq
              ORDER BY u.depth, m.seq DESC LIMIT 1)) ORDER BY t.id, c.seq), '[]'::jsonb)
      FROM shown x JOIN turns t ON t.actor_id = p_actor_id AND t.id = x.id AND t.session_id = p_session_id
      JOIN turn_calls c ON c.turn_id = t.id AND c.call_kind = 'tool' AND c.upper_usd > 0 AND c.status IN ('ok', 'unusable')));
END $function$;

REVOKE ALL ON FUNCTION public.turn_chat_steps_apply(uuid, bigint, jsonb) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
