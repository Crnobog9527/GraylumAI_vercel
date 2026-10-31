-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-10, read only: two reads of what the receipts already hold. No table, no write.
--   turn_resume_read  a turn paused for credits: what its limits leave and its receipts, oldest first, through the paused turns it
--                     itself continued. A resume replays those receipts instead of calling the model or a supplier again, so the
--                     work is done and charged once ("断点续跑不重复收费"). Reusing turn_call_raw needs no checkpoint table: a model
--                     receipt is the whole completion, a paid tool's is what its suppliers returned, and a free tool costs nothing
--                     to run again. Nothing is written at the pause.
--   turn_session_view adds `calls`: the paid tool calls behind the shown replies, so a reload keeps the work rows.
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
          'arguments', (SELECT r.body::jsonb #>> '{choices,0,message,tool_calls,0,function,arguments}' FROM turn_call_raw r
            WHERE r.turn_id = c.turn_id AND r.seq = c.seq - 1)) ORDER BY t.id, c.seq), '[]'::jsonb)
      FROM shown x JOIN turns t ON t.actor_id = p_actor_id AND t.id = x.id AND t.session_id = p_session_id
      JOIN turn_calls c ON c.turn_id = t.id AND c.call_kind = 'tool' AND c.upper_usd > 0 AND c.status IN ('ok', 'unusable')));
END $function$;

CREATE OR REPLACE FUNCTION public.turn_resume_read(p_actor_id uuid, p_session_id uuid, p_turn_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions; t turns; n_model integer; n_paid integer; n_free integer; n_decision integer;
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
  SELECT count(*) FILTER (WHERE call_kind = 'model'), count(*) FILTER (WHERE call_kind = 'tool' AND upper_usd > 0),
         count(*) FILTER (WHERE call_kind = 'tool' AND upper_usd = 0), count(*) FILTER (WHERE call_kind = 'decision')
    INTO n_model, n_paid, n_free, n_decision
  FROM turn_calls WHERE turn_id = t.id AND status NOT IN ('not_sent','rejected','no_charge_402');
  RETURN jsonb_build_object('kind', t.kind,
    'limits', jsonb_build_object('model', (t.policy->'limits'->>'model')::int - n_model,
      'paidTools', (t.policy->'limits'->>'paidTools')::int - n_paid, 'freeTools', (t.policy->'limits'->>'freeTools')::int - n_free,
      'decisions', greatest(coalesce((t.policy->'limits'->>'decisions')::int, 0) - n_decision, 0)),
    'decided', EXISTS (SELECT 1 FROM turn_calls WHERE turn_id = t.id AND call_kind = 'decision' AND status = 'ok'),
    'calls', (WITH RECURSIVE chain AS (
        SELECT t.id AS id, t.resume_of AS previous
        UNION ALL
        SELECT x.id, x.resume_of FROM chain c JOIN turns x ON x.actor_id = p_actor_id AND x.id = c.previous)
      SELECT coalesce(jsonb_agg(jsonb_build_object('seq', c.seq, 'callKind', c.call_kind, 'toolName', c.tool_name, 'status', c.status,
          'body', r.body) ORDER BY c.turn_id, c.seq), '[]'::jsonb)
      FROM chain x JOIN turn_calls c ON c.turn_id = x.id AND c.call_kind IN ('model', 'tool') AND c.status IN ('ok', 'unusable')
        AND NOT (c.call_kind = 'tool' AND c.upper_usd = 0)
      LEFT JOIN turn_call_raw r ON r.turn_id = c.turn_id AND r.seq = c.seq));
END $function$;

REVOKE ALL ON FUNCTION public.turn_resume_read(uuid,uuid,bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.turn_resume_read(uuid,uuid,bigint) TO service_role;
