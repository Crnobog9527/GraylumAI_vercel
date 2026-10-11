-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- AGENT-CORE R1: extend the existing execution-owned frozen tool journal; no new data store.
-- Existing call/result rows are already covered by account and content erasure.
BEGIN;
CREATE OR REPLACE FUNCTION public.runtime_tool(p_actor_id uuid,p_execution_id uuid,p_call_id text,p_name text,p_arguments jsonb,p_action text,p_result jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions;b bill2_runs;t runtime_tool_calls; descriptor jsonb; resource jsonb; content text; expected jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO b FROM bill2_runs WHERE id=e.billing_run_id;
 IF e.id IS NULL THEN RAISE EXCEPTION 'RUNTIME_TOOL_DENIED';END IF;
 PERFORM runtime_billing_allowed(p_actor_id,b.payload,b.id);
 IF NOT coalesce(e.payload->'tools' ? p_name,false) OR p_name NOT IN ('search','read_source','read_skill_file')
 OR (p_name='search' AND e.payload->>'network'='deny')
 OR jsonb_typeof(p_arguments) IS DISTINCT FROM 'object'
 OR (p_name<>'read_skill_file' AND EXISTS(SELECT 1 FROM jsonb_object_keys(p_arguments) k WHERE k<>'query'))
 THEN RAISE EXCEPTION 'RUNTIME_TOOL_DENIED';END IF;
 IF p_name='read_skill_file' THEN
  IF e.payload->>'role' IS DISTINCT FROM 'skill'
   OR e.payload->>'providerRequestFormat' IS DISTINCT FROM 'agent-turn-v5-stream'
   OR e.payload->'skillFile'->>'packageId' IS DISTINCT FROM e.payload->>'skillId'
   OR e.payload->'skillFile'->>'revisionId' IS DISTINCT FROM e.payload->>'revisionId'
   OR e.payload->'skillFile'->>'packageHash' IS NULL
   OR jsonb_typeof(p_arguments->'path') IS DISTINCT FROM 'string'
   OR length(p_arguments->>'path') NOT BETWEEN 1 AND 240
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_arguments) k WHERE k<>'path')
  THEN RAISE EXCEPTION 'RUNTIME_SKILL_FILE_DENIED';END IF;
  descriptor:=read_skill_package(p_actor_id,(e.payload->>'moduleId')::uuid,(e.payload->>'skillId')::uuid,
   (e.payload->>'revisionId')::uuid,e.payload->'skillFile'->>'packageHash',NULL);
  SELECT f INTO resource FROM jsonb_array_elements(descriptor->'files') f WHERE f->>'path'=p_arguments->>'path';
  IF resource IS NULL THEN RAISE EXCEPTION 'RUNTIME_SKILL_FILE_DENIED';END IF;
  IF (resource->>'bytes')::int>16000 THEN RAISE EXCEPTION 'RUNTIME_SKILL_FILE_TOO_LARGE';END IF;
  IF p_action='complete' THEN
   content:=convert_from(decode(read_skill_package(p_actor_id,(e.payload->>'moduleId')::uuid,
    (e.payload->>'skillId')::uuid,(e.payload->>'revisionId')::uuid,e.payload->'skillFile'->>'packageHash',
    p_arguments->>'path',16000)#>>'{}','base64'),'UTF8');
   expected:=e.payload->'skillFile'||jsonb_build_object('path',p_arguments->>'path',
    'sha256',resource->>'sha256','content',content);
   IF p_result IS DISTINCT FROM expected THEN RAISE EXCEPTION 'RUNTIME_SKILL_FILE_CONFLICT';END IF;
  END IF;
 END IF;
 SELECT * INTO t FROM runtime_tool_calls WHERE execution_id=e.id AND call_id=p_call_id;
 IF t.execution_id IS NOT NULL THEN
  IF t.name<>p_name OR t.arguments IS DISTINCT FROM p_arguments THEN RAISE EXCEPTION 'RUNTIME_TOOL_CONFLICT';END IF;
  IF p_action='complete' THEN
   IF b.closed OR b.cancel_requested THEN RAISE EXCEPTION 'RUNTIME_TOOL_CLOSED';END IF;
   IF t.result IS NOT NULL AND t.result IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'RUNTIME_TOOL_RESULT_CONFLICT';END IF;
   IF p_result IS NULL THEN RAISE EXCEPTION 'RUNTIME_TOOL_RESULT_REQUIRED';END IF;
   UPDATE runtime_tool_calls SET result=p_result WHERE execution_id=e.id AND call_id=p_call_id;
   RETURN jsonb_build_object('execute',false,'result',p_result);
  END IF;
  RETURN jsonb_build_object('execute',false,'result',t.result);
 END IF;
 IF p_action<>'claim' OR b.closed OR b.cancel_requested OR e.state<>'running'
 OR (SELECT count(*) FROM runtime_tool_calls WHERE execution_id=e.id)>=coalesce((e.payload->>'maxToolCalls')::int,0)
 THEN RAISE EXCEPTION 'RUNTIME_TOOL_LIMIT';END IF;
 INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments) VALUES(e.id,p_call_id,p_name,p_arguments);
 RETURN jsonb_build_object('execute',true,'result',NULL);
END $$;

REVOKE ALL ON FUNCTION public.runtime_tool(uuid,uuid,text,text,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.runtime_tool(uuid,uuid,text,text,jsonb,text,jsonb) TO service_role;
COMMIT;
