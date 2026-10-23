-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- CONTENT-CONVERSATION-DRIVEN: in free chat the current dialogue model loads a Skill itself with the load_skill tool
-- (Owner 2026-10-23: "就让当前对话的这个模型自己去判断是否要调用 skill"; "同一轮最多加载2个技能").
--   * Admission freezes the catalog (payload.skillCatalog: name, description and the immutable package identity of
--     each loadable Skill) and payload.maxSkillLoads. The tool argument is the Skill's exact name (key "query").
--   * runtime_tool admits load_skill only for an ordinary free-chat execution, only for a name in its frozen catalog,
--     and at most maxSkillLoads distinct calls; a completed result must carry exactly that entry's package identity.
--     The result is journaled in runtime_tool_calls like every tool; a replay returns the journaled row.
-- No new table; existing tool-call rows are already covered by content and account erasure.
-- Compatibility: older executions have no skillCatalog, so the new name is refused for them; old code never sends it.
-- Repeatable: CREATE OR REPLACE and a marker-skipped patch. Recovery: restore runtime_tool from its previous
-- definition and drop the two helper functions (no data is written outside runtime_tool_calls).
BEGIN;
SET LOCAL lock_timeout='5s';

-- The frozen catalog entry this execution may load under this name, or NULL.
CREATE OR REPLACE FUNCTION public.runtime_load_skill_entry(e runtime_executions,p_arguments jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT c FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.payload->'skillCatalog')='array'
   THEN e.payload->'skillCatalog' ELSE '[]'::jsonb END) c
 WHERE e.payload->>'role'='ordinary' AND jsonb_typeof(p_arguments->'query')='string' AND c->>'name'=p_arguments->>'query'
 LIMIT 1
$$;

-- A load is allowed when the name is in the frozen catalog and, counting other calls only (a replay of the same call
-- is always answered from the journal), fewer than maxSkillLoads Skills were loaded in this execution.
CREATE OR REPLACE FUNCTION public.runtime_load_skill_allowed(e runtime_executions,p_call_id text,p_arguments jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT runtime_load_skill_entry(e,p_arguments) IS NOT NULL
  AND ((SELECT count(*) FROM runtime_tool_calls t WHERE t.execution_id=e.id AND t.name='load_skill' AND t.call_id<>p_call_id)
   < coalesce((e.payload->>'maxSkillLoads')::int,0)
   OR EXISTS(SELECT 1 FROM runtime_tool_calls t WHERE t.execution_id=e.id AND t.call_id=p_call_id))
$$;

-- A completed result names exactly the frozen entry's package and carries non-empty instructions.
CREATE OR REPLACE FUNCTION public.runtime_load_skill_result_valid(e runtime_executions,p_arguments jsonb,p_result jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT c IS NOT NULL AND jsonb_typeof(p_result)='object'
  AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_result) k)
   =ARRAY['instructions','moduleId','name','packageHash','packageId','revisionId']
  AND p_result->>'name'=c->>'name' AND p_result->>'moduleId'=c->>'moduleId' AND p_result->>'packageId'=c->>'packageId'
  AND p_result->>'revisionId'=c->>'revisionId' AND p_result->>'packageHash'=c->>'packageHash'
  AND jsonb_typeof(p_result->'instructions')='string' AND length(p_result->>'instructions')>0
 FROM (SELECT runtime_load_skill_entry(e,p_arguments) c) x
$$;

DO $$ DECLARE definition text;names text;complete text;
BEGIN
 definition:=pg_get_functiondef('public.runtime_tool(uuid,uuid,text,text,jsonb,text,jsonb)'::regprocedure);
 IF position('-- 0340 load_skill' IN definition)=0 THEN
  names:='p_name NOT IN (''search'',''read_source'',''read_skill_file'',''read_history'')';
  complete:=' SELECT * INTO t FROM runtime_tool_calls WHERE execution_id=e.id AND call_id=p_call_id;';
  IF array_length(string_to_array(definition,names),1)<>2 OR array_length(string_to_array(definition,complete),1)<>2 THEN
   RAISE EXCEPTION 'RUNTIME_TOOL_SOURCE_MISMATCH: 0340';END IF;
  definition:=replace(definition,names,
   'p_name NOT IN (''search'',''read_source'',''read_skill_file'',''read_history'',''load_skill'')'||E'\n'||
   ' -- 0340 load_skill: a name from the catalog frozen at admission, at most maxSkillLoads per execution'||E'\n'||
   ' OR (p_name=''load_skill'' AND NOT runtime_load_skill_allowed(e,p_call_id,p_arguments))');
  definition:=replace(definition,complete,
   ' IF p_name=''load_skill'' AND p_action=''complete'' AND NOT runtime_load_skill_result_valid(e,p_arguments,p_result)'||E'\n'||
   '  THEN RAISE EXCEPTION ''RUNTIME_SKILL_LOAD_CONFLICT'';END IF;'||E'\n'||complete);
  EXECUTE definition;
 END IF;
END $$;

REVOKE ALL ON FUNCTION public.runtime_load_skill_entry(runtime_executions,jsonb),
 public.runtime_load_skill_allowed(runtime_executions,text,jsonb),
 public.runtime_load_skill_result_valid(runtime_executions,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
