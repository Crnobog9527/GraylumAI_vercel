BEGIN;
SET LOCAL lock_timeout='5s';

-- TURN-STEPS history (Owner 2026-11-04): a reply's step list ("已读取「分镜脚本」方法", "已搜索，找到 6 条结果") stays above the reply after
-- a reload. What is kept is only a tool kind, an end state, a Skill's public catalog name, a count of results and a fixed reason: no
-- argument, no search words, no result or Skill text (so nothing of what the user wrote is kept here, and account erasure has nothing
-- more to clear: the column lives on the turn row, which erasure already treats as a money record without content).
--
--   turns.steps            jsonb array, NULL until the reply's close; at most 16 steps and 4096 bytes.
--   turn_steps_save        the server writes it once, right after the turn closed (never changes turn_close): the actor's own closed turn,
--                          shape checked here as well as in Node, set once (a second save changes nothing and answers false).
--   turn_session_view      the whole function again (the view a reload reads): each assistant message also carries its turn's steps.
--
-- Repeatable: the column is IF NOT EXISTS and both functions are CREATE OR REPLACE. Recovery: nothing else reads the column, so a
-- rollback is the code that reads and writes it, then (if the data is to go too) `ALTER TABLE public.turns DROP COLUMN IF EXISTS steps;`
-- after turn_session_view is put back to its 0450 text. Old code and the new view are compatible both ways: the view only adds a key.

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

CREATE OR REPLACE FUNCTION public.turn_steps_save(p_actor_id uuid, p_turn_id bigint, p_steps jsonb)
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
  UPDATE public.turns SET steps = p_steps WHERE actor_id = p_actor_id AND id = p_turn_id AND state = 'closed' AND steps IS NULL;
  RETURN FOUND;
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
          -- The steps the reply showed while it was written (turn_steps_save): only a tool kind, an end state, a Skill's public name
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

DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.turn_steps_save(uuid,bigint,jsonb) FROM PUBLIC, anon, authenticated, service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.turn_steps_save(uuid,bigint,jsonb) TO service_role';
END $$;

COMMIT;
