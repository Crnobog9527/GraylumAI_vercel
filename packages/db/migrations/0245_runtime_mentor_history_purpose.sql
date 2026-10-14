/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- AGENT-CORE R4 follow-up to 0228: a positioning draft's session also carries plan
-- generations and legacy step runs, whose inputs are host-serialized JSON, not the
-- user's words. Only executions recorded as a mentor turn of this draft in opc_turns
-- (same session, request and turn token) count as earlier user messages. Every other
-- 0228 rule is unchanged: owner, completed, live and before the reading turn; the
-- reader, its caps, the frozen result, the write guard and deletion follow-up stay as is.
BEGIN;
CREATE OR REPLACE FUNCTION runtime_mentor_messages(p_actor_id uuid,e runtime_executions)
RETURNS TABLE(turn bigint,execution_id uuid,at timestamptz,body text)
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT row_number() OVER (ORDER BY x.created_at,x.id),x.id,x.created_at,x.payload->>'input'
 FROM runtime_executions x
 WHERE x.actor_id=p_actor_id AND x.session_id=e.session_id AND (x.created_at,x.id)<(e.created_at,e.id)
  AND x.state='completed' AND x.erased_at IS NULL AND x.content_deleted_at IS NULL
  AND x.payload->>'role'='skill' AND x.payload ? 'opcTurnToken' AND NOT x.payload ? 'reportGeneration'
  AND EXISTS(SELECT 1 FROM opc_turns t JOIN opc_drafts d ON d.draft_id=t.draft_id AND d.actor_id=p_actor_id
   WHERE t.session_id=x.session_id AND t.request_id=x.request_id AND t.token::text=x.payload->>'opcTurnToken'
    AND t.purpose='mentor')
  AND btrim(coalesce(x.payload->>'input','')) NOT IN ('','HOST_OPEN_CURRENT_QUESTION','HOST_STEP_SUMMARY:v1')
  AND NOT starts_with(x.payload->>'input','HOST_CHECKLIST_UPDATED:')
$$;
REVOKE ALL ON FUNCTION runtime_mentor_messages(uuid,runtime_executions) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
