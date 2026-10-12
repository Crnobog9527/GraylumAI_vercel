/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- AGENT-CORE R4 (Master Plan item 31): a positioning mentor turn may read the user's own
-- earlier messages of its own conversation with read_history, instead of a summary
-- replacing them. Step state is already sent every turn and is not repeated here.
-- Reads are owner-only, bounded, frozen in runtime_tool_calls, and follow deletion:
-- the result names each source execution, so 0218's erasure scope finds the copy, and
-- a completion racing a deletion is serialized on the same project locks.
BEGIN;

-- runtime_tool admits the new name only for executions frozen with historyRead.
DO $$ DECLARE definition text;needle text;
BEGIN
 definition:=pg_get_functiondef('public.runtime_tool(uuid,uuid,text,text,jsonb,text,jsonb)'::regprocedure);
 IF position('-- 0228 read_history' IN definition)=0 THEN
  needle:='p_name NOT IN (''search'',''read_source'',''read_skill_file'')';
  IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
   RAISE EXCEPTION 'RUNTIME_TOOL_SOURCE_MISMATCH'; END IF;
  EXECUTE replace(definition,needle,'p_name NOT IN (''search'',''read_source'',''read_skill_file'',''read_history'')'||E'\n'||
   ' -- 0228 read_history'||E'\n'||' OR (p_name=''read_history'' AND e.payload->''historyRead'' IS NULL)');
 END IF;
END $$;

-- The user's own completed mentor messages before the reading turn, numbered from 1.
-- Host-generated openings, step summaries, checklist-update markers and report runs are not the user's words.
CREATE OR REPLACE FUNCTION runtime_mentor_messages(p_actor_id uuid,e runtime_executions)
RETURNS TABLE(turn bigint,execution_id uuid,at timestamptz,body text)
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT row_number() OVER (ORDER BY x.created_at,x.id),x.id,x.created_at,x.payload->>'input'
 FROM runtime_executions x
 WHERE x.actor_id=p_actor_id AND x.session_id=e.session_id AND (x.created_at,x.id)<(e.created_at,e.id)
  AND x.state='completed' AND x.erased_at IS NULL AND x.content_deleted_at IS NULL
  AND x.payload->>'role'='skill' AND x.payload ? 'opcTurnToken' AND NOT x.payload ? 'reportGeneration'
  AND btrim(coalesce(x.payload->>'input','')) NOT IN ('','HOST_OPEN_CURRENT_QUESTION','HOST_STEP_SUMMARY:v1')
  AND NOT starts_with(x.payload->>'input','HOST_CHECKLIST_UPDATED:')
$$;

-- The mentor session of the execution, while its draft, project and session are live.
CREATE OR REPLACE FUNCTION runtime_mentor_history_draft(p_actor_id uuid,e runtime_executions) RETURNS opc_drafts
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT d.* FROM opc_drafts d
 JOIN runtime_sessions s ON s.id=d.session_id AND s.actor_id=p_actor_id AND s.erased_at IS NULL AND s.content_deleted_at IS NULL
 JOIN artifact_projects p ON p.id=d.project_id AND p.actor_id=p_actor_id AND p.erased_at IS NULL AND p.content_deleted_at IS NULL
 JOIN bill2_drafts b ON b.id=d.draft_id AND b.actor_id=p_actor_id AND NOT b.revoked
 WHERE d.session_id=e.session_id AND d.actor_id=p_actor_id
$$;

CREATE OR REPLACE FUNCTION runtime_mentor_history(p_actor_id uuid,p_execution_id uuid,p_query text DEFAULT '') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions;d opc_drafts;total bigint;wanted bigint;segments jsonb;result jsonb;cap integer;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id;
 IF e.id IS NULL OR e.state<>'running' OR e.erased_at IS NOT NULL OR e.content_deleted_at IS NOT NULL
  OR e.payload->'historyRead' IS NULL OR NOT coalesce(e.payload->'tools' ? 'read_history',false)
 THEN RAISE EXCEPTION 'RUNTIME_MENTOR_HISTORY_DENIED';END IF;
 d:=runtime_mentor_history_draft(p_actor_id,e);
 IF d.draft_id IS NULL THEN RAISE EXCEPTION 'RUNTIME_MENTOR_HISTORY_DENIED';END IF;
 IF coalesce(p_query,'')='' THEN wanted:=1;
 ELSIF p_query ~ '^segment-[1-9][0-9]{0,4}$' THEN wanted:=substr(p_query,9)::bigint;
 ELSE RETURN jsonb_build_object('kind','unavailable');END IF;
 SELECT count(*) INTO total FROM runtime_mentor_messages(p_actor_id,e);
 -- Eight messages per segment; the index names at most the earliest 20 segments.
 SELECT coalesce(jsonb_agg(jsonb_build_object('id','segment-'||g,'turns',jsonb_build_array(lo,hi),'from',f,'to',t) ORDER BY g),'[]')
 INTO segments FROM (SELECT (turn-1)/8+1 g,min(turn) lo,max(turn) hi,min(at) f,max(at) t
  FROM runtime_mentor_messages(p_actor_id,e) GROUP BY 1 ORDER BY 1 LIMIT 20) s;
 IF wanted>(total+7)/8 THEN
  RETURN jsonb_build_object('kind','unavailable','segments',segments,'messages',total);
 END IF;
 -- 2500 characters of user text stay within the 14336-byte result part of the frozen reserve even escaped.
 FOREACH cap IN ARRAY ARRAY[2500,800] LOOP
  SELECT jsonb_build_object('kind','mentor_history','segment','segment-'||wanted,'segments',segments,'messages',total,
   'items',coalesce(jsonb_agg(jsonb_build_object('turn',m.turn,'at',m.at,'executionId',m.execution_id,'text',m.shown) ORDER BY m.turn),'[]'),
   'truncated',coalesce(bool_or(m.cut),false))
  INTO result FROM (
   SELECT x.turn,x.at,x.execution_id,
    left(x.body,greatest(0,cap-coalesce(sum(char_length(x.body)) OVER (ORDER BY x.turn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0))::integer) shown,
    coalesce(sum(char_length(x.body)) OVER (ORDER BY x.turn),0)>cap cut
   FROM runtime_mentor_messages(p_actor_id,e) x WHERE (x.turn-1)/8+1=wanted
  ) m;
  IF octet_length(to_jsonb(result::text)::text)<=14336 THEN RETURN result;END IF;
 END LOOP;
 RAISE EXCEPTION 'RUNTIME_MENTOR_HISTORY_TOO_LARGE';
END $$;

-- A read_history result is written after the read. Erasure locks the actor's projects
-- (NOWAIT) before computing its scope; holding the draft's project in share mode here
-- makes that erasure report busy, or waits for it and then rejects deleted messages.
-- runtime_tool already holds the execution; execution -> project matches 0218.
CREATE OR REPLACE FUNCTION runtime_mentor_history_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions;d opc_drafts;
BEGIN
 IF NEW.name<>'read_history' OR NEW.result IS NULL OR NEW.result->>'kind' IS DISTINCT FROM 'mentor_history' THEN RETURN NEW;END IF;
 SELECT * INTO e FROM runtime_executions WHERE id=NEW.execution_id;
 PERFORM p.id FROM artifact_projects p JOIN opc_drafts od ON od.project_id=p.id
  WHERE od.session_id=e.session_id AND p.actor_id=e.actor_id ORDER BY p.id FOR SHARE OF p;
 d:=runtime_mentor_history_draft(e.actor_id,e);
 IF d.draft_id IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.result->'items') i
  WHERE NOT EXISTS(SELECT 1 FROM runtime_executions x WHERE x.id=(i->>'executionId')::uuid AND x.actor_id=e.actor_id
   AND x.session_id=e.session_id AND x.erased_at IS NULL AND x.content_deleted_at IS NULL))
 THEN RAISE EXCEPTION 'RUNTIME_MENTOR_HISTORY_REVOKED';END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS runtime_mentor_history_guard ON runtime_tool_calls;
CREATE TRIGGER runtime_mentor_history_guard BEFORE INSERT OR UPDATE OF result ON runtime_tool_calls
 FOR EACH ROW EXECUTE FUNCTION runtime_mentor_history_guard();

-- Deleting an earlier answer or the conversation also deletes the answers that copied it.
DO $$ DECLARE definition text;needle text;
BEGIN
 definition:=pg_get_functiondef('public.content_erasure_scope(uuid,text,uuid)'::regprocedure);
 IF position('-- 0228 read_history copies' IN definition)=0 THEN
  needle:='tc.name=''read_source'' AND content_erasure_references(tc.result,refs))';
  IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
   RAISE EXCEPTION 'CONTENT_ERASURE_SOURCE_MISMATCH: content_erasure_scope 0228'; END IF;
  EXECUTE replace(definition,needle,'tc.name IN (''read_source'',''read_history'') AND content_erasure_references(tc.result,refs))'||
   E'\n   -- 0228 read_history copies');
 END IF;
END $$;

REVOKE ALL ON FUNCTION runtime_mentor_messages(uuid,runtime_executions),runtime_mentor_history_draft(uuid,runtime_executions),
 runtime_mentor_history(uuid,uuid,text),runtime_mentor_history_guard(),content_erasure_scope(uuid,text,uuid),
 runtime_tool(uuid,uuid,text,text,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION runtime_mentor_history(uuid,uuid,text),runtime_tool(uuid,uuid,text,text,jsonb,text,jsonb) TO service_role;
COMMIT;
