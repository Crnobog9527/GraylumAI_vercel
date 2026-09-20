/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Additive result reader replacement: preserve paid results across draft revision.
-- No data rewrite; existing ownership, evidence and Runtime availability checks remain.
BEGIN;
CREATE OR REPLACE FUNCTION opc_plan_result(p_actor_id uuid,p_draft_id uuid,p_execution_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;e runtime_executions;r artifact_rounds;v artifact_versions;original_turn opc_turns;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND session_id=d.session_id AND actor_id=p_actor_id;
 SELECT * INTO original_turn FROM opc_turns WHERE draft_id=d.draft_id AND session_id=d.session_id AND request_id=e.request_id AND token::text=e.payload->>'opcTurnToken' AND purpose='plan';
 SELECT * INTO r FROM artifact_rounds WHERE id=original_turn.round_id AND project_id=d.project_id AND state='published';
 SELECT * INTO v FROM artifact_versions WHERE round_id=r.id;
 IF NOT EXISTS(SELECT 1 FROM opc_turns t WHERE t.session_id=d.session_id AND t.request_id=e.request_id AND t.token::text=e.payload->>'opcTurnToken' AND t.purpose='plan' AND t.round_id=r.id) OR e.payload->'scopeMaterial'->'content'->>'brief' NOT LIKE 'plan:%' OR v.id IS NULL OR e.state IS DISTINCT FROM 'completed' OR NOT runtime_history_available(e.id) OR NOT opc_source_allowed(p_actor_id,v.id)
 OR e.payload->>'revisionId' IS DISTINCT FROM r.revision_id::text OR e.payload->'scopeMaterial'->'content'->'work'->>'roundId' IS DISTINCT FROM r.id::text THEN RAISE EXCEPTION 'OPC_RESULT_DENIED';END IF;
 RETURN jsonb_build_object('sourceVersionId',v.id,'sourceRoundId',r.id,'body',e.result->>'body');
END $$;
REVOKE ALL ON FUNCTION opc_plan_result(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_plan_result(uuid,uuid,uuid) TO service_role;
COMMIT;
