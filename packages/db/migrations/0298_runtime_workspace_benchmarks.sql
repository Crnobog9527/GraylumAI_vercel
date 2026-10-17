/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- CHAT-AUTO-CONTEXT B1 (Owner 2026-10-17, MASTER_PLAN 2.1; docs/launch/tasks/CHAT-AUTO-CONTEXT.md): free conversations
-- can read the benchmark table their confirmed positioning was built from, at no tool charge. 0218's
-- runtime_workspace_source is rebuilt with one more entry kind, 'benchmarks', listed right after the positionings:
-- per confirmed business, the positioning session of the draft that produced its confirmed version (opc_drafts.project_id
-- = that version's project; a newer, unconfirmed draft of the same business is never used), when it still has benchmark
-- rows from live answers. Its body is 0268's research_benchmark_table rows (numbers computed by code, fetch
-- times, missing fields), capped at 8000 characters; nothing is fetched from a supplier here.
-- Everything else is 0218 unchanged: owner/free-session gate, opc_source_allowed on the business's positioning version,
-- 40-entry index (positionings, then benchmarks, then strategies and topics), 4000-character body for the other kinds.
-- Erasure needs no new code: the entry carries sessionId (the positioning session) and sourceVersionId, and a read also
-- returns producedBy: [{executionId}] for every answer whose rows it copied; content_erasure_references matches all three
-- keys and 0218 already scopes read_source tool results. Deleting that positioning conversation, the positioning itself,
-- or (internally) one producing answer clears free-conversation answers that copied the table. Its dependency is the
-- positioning version, so 0218's tool guard still refuses a copy stored after the positioning was revoked or deleted.
-- Rollback: re-run 0218's definition and drop runtime_workspace_benchmark_guard (no data is written by this migration).
BEGIN;
CREATE OR REPLACE FUNCTION runtime_workspace_source(p_actor_id uuid,p_session_id uuid,p_query text DEFAULT '') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE entries jsonb;entry jsonb;body text;version_id uuid;cap integer:=4000;produced jsonb;
BEGIN
 IF NOT runtime_workspace_session(p_actor_id,p_session_id) THEN RAISE EXCEPTION 'RUNTIME_WORKSPACE_DENIED';END IF;
 IF length(coalesce(p_query,''))>2000 THEN RAISE EXCEPTION 'RUNTIME_WORKSPACE_QUERY_DENIED';END IF;
 -- Metadata is requested by the model, not loaded into every conversation.
 SELECT coalesce(jsonb_agg(x.entry ORDER BY x.rank,x.id),'[]') INTO entries FROM (
  SELECT 0 rank,b.id::text id,jsonb_build_object('id',b.id,'kind','positioning','name',b.name,'confirmedAt',v.created_at,'sourceVersionId',b.current_source_version_id) entry
  FROM opc_businesses b JOIN artifact_versions v ON v.id=b.current_source_version_id WHERE b.actor_id=p_actor_id AND b.erased_at IS NULL AND b.current_source_version_id IS NOT NULL
   AND opc_source_allowed(p_actor_id,b.current_source_version_id)
  UNION ALL
  SELECT 1,s.session_id::text,jsonb_build_object('id',s.session_id,'kind','benchmarks','name',b.name,'sessionId',s.session_id,
   'accounts',s.accounts,'qualified',s.qualified,'fetchedAt',s.fetched_at,'sourceVersionId',b.current_source_version_id,
   'use','Real public data of benchmark accounts fetched during positioning research; numbers come only from this table.')
  FROM opc_businesses b CROSS JOIN LATERAL (
   SELECT d.session_id,count(*)::int accounts,(count(*) FILTER (WHERE rb.qualified))::int qualified,max(rb.fetched_at) fetched_at
   FROM opc_draft_businesses db JOIN opc_drafts d ON d.draft_id=db.draft_id AND d.actor_id=p_actor_id
    AND d.project_id=(SELECT cv.project_id FROM artifact_versions cv WHERE cv.id=b.current_source_version_id)
   JOIN runtime_sessions rs ON rs.id=d.session_id AND rs.actor_id=p_actor_id AND rs.content_deleted_at IS NULL AND rs.erased_at IS NULL
   JOIN research_benchmarks rb ON rb.session_id=d.session_id AND rb.actor_id=p_actor_id
   JOIN runtime_executions x ON x.id=rb.execution_id AND x.actor_id=p_actor_id AND x.session_id=d.session_id
    AND x.content_deleted_at IS NULL AND x.erased_at IS NULL
   WHERE db.business_id=b.id GROUP BY d.session_id ORDER BY max(rb.fetched_at) DESC,d.session_id LIMIT 1) s
  WHERE b.actor_id=p_actor_id AND b.erased_at IS NULL AND b.current_source_version_id IS NOT NULL
   AND opc_source_allowed(p_actor_id,b.current_source_version_id)
  UNION ALL
  SELECT 2,ac.project_id::text,jsonb_build_object('id',ac.project_id,'kind','strategy','platform',ac.platform,'account',coalesce((SELECT display_name FROM opc_account_ui WHERE actor_id=p_actor_id AND account_project_id=ac.project_id),ac.account_key),'sourceVersionId',ac.source_version_id)
  FROM opc_accounts ac WHERE ac.actor_id=p_actor_id AND opc_source_allowed(p_actor_id,ac.source_version_id)
  UNION ALL
  SELECT 2,i.work_item_id::text,jsonb_build_object('id',i.work_item_id,'kind','topic','platform',ac.platform,'account',coalesce((SELECT display_name FROM opc_account_ui WHERE actor_id=p_actor_id AND account_project_id=ac.project_id),ac.account_key),'title',coalesce((SELECT title FROM opc_item_edits WHERE work_item_id=i.work_item_id),p.work_title),'sourceVersionId',i.source_version_id)
  FROM opc_items i JOIN opc_accounts ac ON ac.project_id=i.account_project_id JOIN artifact_projects p ON p.id=i.work_item_id AND p.actor_id=p_actor_id
  WHERE ac.actor_id=p_actor_id AND opc_source_allowed(p_actor_id,i.source_version_id)
  ORDER BY rank,id LIMIT 40
 ) x;
 IF coalesce(p_query,'')='' THEN
  RETURN jsonb_build_object('kind','workspace_index','entries',entries,'limit',40,'dependencies',(SELECT coalesce(jsonb_agg(DISTINCT x->>'sourceVersionId'),'[]') FROM jsonb_array_elements(entries) x));
 END IF;
 SELECT x INTO entry FROM jsonb_array_elements(entries) x WHERE x->>'id'=p_query;
 IF entry IS NULL THEN RETURN jsonb_build_object('kind','unavailable','dependencies','[]'::jsonb);END IF;
 version_id:=(entry->>'sourceVersionId')::uuid;
 IF entry->>'kind' IN ('strategy','positioning') THEN body:=opc_profile(version_id)::text;
 ELSIF entry->>'kind'='benchmarks' THEN
  body:=(research_benchmark_table(p_actor_id,(entry->>'sessionId')::uuid)->'rows')::text;cap:=8000;
  -- Same rows as research_benchmark_table (live answers of this session, at most 30): the answers they came from.
  SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('executionId',t.execution_id)),'[]') INTO produced FROM (
   SELECT rb.execution_id FROM research_benchmarks rb JOIN runtime_executions x ON x.id=rb.execution_id AND x.actor_id=p_actor_id
    AND x.session_id=rb.session_id WHERE rb.actor_id=p_actor_id AND rb.session_id=(entry->>'sessionId')::uuid
    AND x.content_deleted_at IS NULL AND x.erased_at IS NULL
   ORDER BY rb.qualified DESC,rb.followers DESC NULLS LAST,rb.platform,rb.account LIMIT 30) t;
  RETURN jsonb_build_object('kind','workspace_source','identity',entry,'body',left(body,cap),'truncated',length(body)>cap,
   'producedBy',produced,'dependencies',jsonb_build_array(version_id));
 ELSE SELECT coalesce((SELECT ed.brief FROM opc_item_edits ed WHERE ed.work_item_id=i.work_item_id),i.brief) INTO body FROM opc_items i WHERE i.work_item_id=(entry->>'id')::uuid;END IF;
 RETURN jsonb_build_object('kind','workspace_source','identity',entry,'body',left(body,cap),'truncated',length(body)>cap,'dependencies',jsonb_build_array(version_id));
END $$;
REVOKE ALL ON FUNCTION runtime_workspace_source(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION runtime_workspace_source(uuid,uuid,text) TO service_role;
-- A benchmark read is stored after it was read. Like 0218's tool guard: lock the positioning project in share mode
-- (erasure locks the actor's projects NOWAIT before computing its scope), then recheck that the positioning session and
-- every producing answer are still live, so a copy can never be stored after its source answer or session was deleted.
CREATE OR REPLACE FUNCTION runtime_workspace_benchmark_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a uuid;s uuid;
BEGIN
 IF NEW.name<>'read_source' OR NEW.result IS NULL OR NEW.result->>'kind' IS DISTINCT FROM 'workspace_source'
  OR NEW.result#>>'{identity,kind}' IS DISTINCT FROM 'benchmarks' THEN RETURN NEW;END IF;
 SELECT actor_id INTO a FROM runtime_executions WHERE id=NEW.execution_id;
 s:=(NEW.result#>>'{identity,sessionId}')::uuid;
 PERFORM p.id FROM artifact_projects p JOIN opc_drafts od ON od.project_id=p.id
  WHERE od.session_id=s AND p.actor_id=a ORDER BY p.id FOR SHARE OF p;
 IF NOT EXISTS(SELECT 1 FROM runtime_sessions rs WHERE rs.id=s AND rs.actor_id=a AND rs.content_deleted_at IS NULL AND rs.erased_at IS NULL)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(NEW.result->'producedBy','[]'::jsonb)) i
   WHERE NOT EXISTS(SELECT 1 FROM runtime_executions x WHERE x.id=(i->>'executionId')::uuid AND x.actor_id=a
    AND x.session_id=s AND x.content_deleted_at IS NULL AND x.erased_at IS NULL))
 THEN RAISE EXCEPTION 'RUNTIME_WORKSPACE_SOURCE_REVOKED';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION runtime_workspace_benchmark_guard() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS runtime_workspace_benchmark_guard ON runtime_tool_calls;
CREATE TRIGGER runtime_workspace_benchmark_guard BEFORE INSERT OR UPDATE OF result ON runtime_tool_calls
 FOR EACH ROW EXECUTE FUNCTION runtime_workspace_benchmark_guard();
COMMIT;
