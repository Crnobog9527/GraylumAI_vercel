/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
BEGIN;
-- A bounded projection of existing input/candidate facts, not another body store.
CREATE OR REPLACE FUNCTION public.agent_slice_conversation(p_actor_id uuid,p_conversation_id uuid,p_before_time timestamptz DEFAULT NULL,p_before_id uuid DEFAULT NULL,p_limit integer DEFAULT 20) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e agent_slice_executions%ROWTYPE; reply jsonb; summary jsonb; rows jsonb:='[]'; next_cursor jsonb:=NULL; n integer:=0; permitted boolean; input_body text; step_title text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') OR
 NOT EXISTS(SELECT 1 FROM conversations WHERE id=p_conversation_id AND user_id=p_actor_id AND is_deleted='false') THEN RAISE EXCEPTION 'slice denied' USING ERRCODE='42501'; END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 OR (p_before_time IS NULL)<>(p_before_id IS NULL) THEN RAISE EXCEPTION 'slice cursor invalid'; END IF;
 FOR e IN SELECT * FROM agent_slice_executions WHERE conversation_id=p_conversation_id
  AND (p_before_time IS NULL OR (created_at,request_id)<(p_before_time,p_before_id))
  ORDER BY created_at DESC,request_id DESC LIMIT p_limit+1
 LOOP
  n:=n+1;
  IF n>p_limit THEN EXIT; END IF;
  permitted:=EXISTS(SELECT 1 FROM artifact_projects WHERE id=e.project_id AND actor_id=p_actor_id);
  reply:=jsonb_build_object('state','restricted'); summary:=reply; input_body:=NULL;
  IF permitted THEN
   BEGIN
    reply:=agent_slice_result(p_actor_id,e.request_id,'reply','read');
    summary:=agent_slice_result(p_actor_id,e.request_id,'summary','read');
   EXCEPTION WHEN insufficient_privilege THEN
    reply:=jsonb_build_object('state','restricted'); summary:=reply;
   END;
  END IF;
  IF reply->>'state'<>'restricted' AND summary->>'state'<>'restricted' THEN
   SELECT payload->>'body' INTO input_body FROM artifact_requests WHERE project_id=e.project_id AND request_id=e.request_id AND action='slice_input';
   IF input_body IS NULL THEN RAISE EXCEPTION 'slice input unavailable'; END IF;
  ELSE reply:=jsonb_build_object('state','restricted'); summary:=reply; END IF;
  SELECT s->>'title' INTO step_title FROM artifact_rounds r CROSS JOIN LATERAL jsonb_array_elements(r.workflow->'steps') s WHERE r.id=e.round_id AND s->>'id'=e.step_id;
  rows:=rows||jsonb_build_array(jsonb_build_object('executionId',e.request_id,'createdAt',e.created_at,'projectId',e.project_id,'roundId',e.round_id,'stepId',e.step_id,'pairId',e.pair_id,'stepTitle',coalesce(step_title,'创作'),'input',input_body,'reply',reply,'summary',summary));
  next_cursor:=jsonb_build_object('createdAt',e.created_at,'executionId',e.request_id);
 END LOOP;
 RETURN jsonb_build_object('items',rows,'nextCursor',CASE WHEN n>p_limit THEN next_cursor ELSE NULL END);
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_conversation(uuid,uuid,timestamptz,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_conversation(uuid,uuid,timestamptz,uuid,integer) TO service_role;
COMMIT;
