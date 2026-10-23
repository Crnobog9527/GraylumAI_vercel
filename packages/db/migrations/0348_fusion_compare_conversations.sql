-- FUSION-COMPARE first message (Owner 2026-10-24): a new conversation may start with a multi-model compare.
-- The conversation list (opc_free_conversations) only knew conversations with an ordinary/skill turn, so a conversation
-- whose only content is a compare (not yet adopted) was invisible. Anchored patch: such a conversation is listed too,
-- titled with the compared question, its activity time counting the compare. A refused start (no group, nothing ran)
-- is not a conversation worth listing. Nothing else about the list changes (rename, deletion and review filters stay).
-- Rollback: re-run the previous function body (0307's patch result) or remove the lines marked "FUSION-COMPARE first message".
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $list$ DECLARE d text; a1 text; a2 text; a3 text; a4 text; a5 text;
BEGIN
 d:=pg_get_functiondef('public.opc_free_conversations(uuid)'::regprocedure);
 IF position('-- FUSION-COMPARE first message' IN d)=0 THEN
  a1:=$a$ SELECT s.id,first_turn.id AS execution_id,first_turn.payload,activity.last_activity$a$;
  a2:=$a$ CROSS JOIN LATERAL (
  SELECT e.id,e.payload FROM runtime_executions e
  WHERE e.session_id=s.id AND e.actor_id=p_actor_id AND e.payload->>'role' IN ('ordinary','skill')
  ORDER BY e.created_at,e.id LIMIT 1
 ) first_turn
 CROSS JOIN LATERAL (
  SELECT max(e.created_at) AS last_activity FROM runtime_executions e
  WHERE e.session_id=s.id AND e.actor_id=p_actor_id
 ) activity$a$;
  a3:=$a$ WHERE NOT coalesce(first_turn.payload ? 'weeklyReview',false)$a$;
  a4:=$a$   CASE WHEN runtime_history_available(s.execution_id)$a$;
  FOREACH a5 IN ARRAY ARRAY[a1,a2,a3,a4] LOOP
   IF array_length(string_to_array(d,a5),1)<>2 THEN RAISE EXCEPTION 'FUSION_COMPARE_CHAT_LIST_MISMATCH';END IF;
  END LOOP;
  d:=replace(d,a1,$b$ SELECT s.id,first_turn.id AS execution_id,first_turn.payload,first_compare.id AS compare_id,first_compare.question AS compare_question,activity.last_activity$b$);
  d:=replace(d,a2,$b$ LEFT JOIN LATERAL (
  SELECT e.id,e.payload FROM runtime_executions e
  WHERE e.session_id=s.id AND e.actor_id=p_actor_id AND e.payload->>'role' IN ('ordinary','skill')
  ORDER BY e.created_at,e.id LIMIT 1
 ) first_turn ON true
 -- FUSION-COMPARE first message: a conversation that so far holds only a compare
 LEFT JOIN LATERAL (
  SELECT c.id,c.question FROM fusion_compares c
  WHERE c.session_id=s.id AND c.actor_id=p_actor_id AND c.state<>'refused'
  ORDER BY c.created_at,c.id LIMIT 1
 ) first_compare ON true
 CROSS JOIN LATERAL (
  SELECT greatest(max(e.created_at),(SELECT max(c.created_at) FROM fusion_compares c
   WHERE c.session_id=s.id AND c.actor_id=p_actor_id AND c.state<>'refused')) AS last_activity FROM runtime_executions e
  WHERE e.session_id=s.id AND e.actor_id=p_actor_id
 ) activity$b$);
  d:=replace(d,a3,$b$ WHERE (first_turn.id IS NOT NULL OR first_compare.id IS NOT NULL)
 AND NOT coalesce(first_turn.payload ? 'weeklyReview',false)$b$);
  d:=replace(d,a4,$b$   CASE WHEN s.execution_id IS NULL
    THEN CASE WHEN s.compare_question IS NOT NULL THEN left(coalesce(nullif(btrim(s.compare_question),''),'新对话'),80) ELSE '对话记录' END
   WHEN runtime_history_available(s.execution_id)$b$);
  EXECUTE d;
 END IF;
END $list$;
COMMIT;
