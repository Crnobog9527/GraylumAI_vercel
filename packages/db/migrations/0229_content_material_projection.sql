-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- CONTENT-CONVERSATION-DRIVEN A1 (docs/launch/implementation/CONTENT_CONVERSATION_DRIVEN_PRECONDITIONS.md
-- sections 2.3 and 3.2). Number assigned by the controller. No remote application.
-- 1. Saved bodies no longer enter the always-on topic scope material: content saves stop
--    writing material revisions; the material keeps content type, title, brief and positioning.
--    New work items (opc_handoff) start from the same material.
-- 2. Existing work-item sessions whose latest material is a saved body (content save or a
--    completed legacy video preparation) get one appended
--    header-only revision (frozen history is never rewritten). Sessions with an unfinished
--    legacy video binding are skipped; video preparation is retired separately (R).
-- 3. A brief adopted from an execution is saved through the existing item edit and recorded
--    in opc_data_events as brief_adoption (AI original vs user-saved text).
-- 4. Library items expose the positioning version they are bound to.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Single definition of the always-on work-item material. Same text format as the
-- latest opc_library_edit, with handoff defaults when the item was never edited.
CREATE OR REPLACE FUNCTION public.opc_work_material_payload(p_work_item_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object(
  'brief','内容类型：'||coalesce(ed.content_type,opc_item_content_type(i.work_item_id))
   ||E'\n标题：'||coalesce(ed.title,p.work_title)||E'\n简报：'||coalesce(ed.brief,i.brief),
  'material',coalesce(opc_profile(i.source_version_id)::text,''),'roundId',NULL)
 FROM opc_items i JOIN artifact_projects p ON p.id=i.work_item_id
 LEFT JOIN opc_item_edits ed ON ed.work_item_id=i.work_item_id
 WHERE i.work_item_id=p_work_item_id
$$;
REVOKE ALL ON FUNCTION public.opc_work_material_payload(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Remove the material write from both content save paths, keeping every other
-- statement (including the D7 read boundary guards) of the live definitions.
DO $$
DECLARE sig text;source text;head text;start_at int;end_at int;tail text;
BEGIN
 FOREACH sig IN ARRAY ARRAY[
  'opc_content_from_execution(uuid,uuid,uuid,bigint,text,text,uuid,uuid)',
  'opc_content_manual_save(uuid,uuid,uuid,bigint,uuid,text,text,text,text)'
 ] LOOP
  source:=pg_get_functiondef(('public.'||sig)::regprocedure);
  CONTINUE WHEN position('-- A1 saved bodies stay out of scope material' IN source)>0;
  IF position('-- D7 read boundary' IN source)=0 THEN RAISE EXCEPTION 'A1_SOURCE_MISMATCH: % lost D7 guard',sig;END IF;
  head:=E'  IF p_status=''final'' THEN\n   SELECT coalesce(max(revision),0) INTO material_revision FROM runtime_scope_material';
  start_at:=position(head IN source);
  IF start_at=0 OR position('runtime_material(' IN substr(source,start_at))=0 THEN
   RAISE EXCEPTION 'A1_SOURCE_MISMATCH: % material block',sig;END IF;
  tail:=substr(source,start_at);
  end_at:=position(E'\n  END IF;\n' IN tail);
  IF end_at=0 OR position('runtime_material(' IN substr(tail,1,end_at))=0 THEN
   RAISE EXCEPTION 'A1_SOURCE_MISMATCH: % material block end',sig;END IF;
  source:=substr(source,1,start_at-1)
   ||E'  -- A1 saved bodies stay out of scope material; injection is per derived turn (A2).\n'
   ||substr(tail,end_at+length(E'\n  END IF;\n'));
  EXECUTE source;
 END LOOP;
END $$;

-- New work items start from the same material (content type and title, not only the brief).
DO $$
DECLARE source text;needle text:='jsonb_build_object(''brief'',item->>''brief'',''material'',opc_profile(v.id)::text,''roundId'',NULL)';
BEGIN
 source:=pg_get_functiondef('public.opc_handoff(uuid,uuid,uuid,uuid,jsonb)'::regprocedure);
 IF position('opc_work_material_payload(wid)' IN source)=0 THEN
  IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN
   RAISE EXCEPTION 'A1_SOURCE_MISMATCH: opc_handoff material';END IF;
  EXECUTE replace(source,needle,'opc_work_material_payload(wid)');
 END IF;
END $$;

-- Append one header-only revision where the latest revision is a saved body.
DO $$
DECLARE r record;
BEGIN
 FOR r IN
  SELECT s.id session_id,s.actor_id,(s.scope->>'workItemId')::uuid work_item_id,m.revision
  FROM runtime_sessions s
  JOIN LATERAL (SELECT * FROM runtime_scope_material x WHERE x.session_id=s.id ORDER BY x.revision DESC LIMIT 1) m ON true
  JOIN profiles pr ON pr.id=s.actor_id AND pr.status='active' AND pr.is_deleted='false'
  WHERE s.scope->>'kind'='work_item' AND s.erased_at IS NULL AND s.content_deleted_at IS NULL
   -- Same gate runtime_material applies; unusable sessions are never admitted again.
   AND coalesce(bill2_scope_allowed(s.actor_id,s.scope),false)
   AND m.erased_at IS NULL AND NOT m.revoked
   -- Body-bearing revisions: a content save (request id = content id) or a legacy video
   -- preparation (its binding points at this revision; unfinished ones are skipped below).
   AND (EXISTS(SELECT 1 FROM opc_content_versions c WHERE c.id=m.request_id AND c.actor_id=s.actor_id)
    OR EXISTS(SELECT 1 FROM opc_video_material_bindings vb WHERE vb.session_id=s.id AND vb.material_revision=m.revision))
   AND EXISTS(SELECT 1 FROM opc_items i WHERE i.work_item_id=(s.scope->>'workItemId')::uuid)
   -- An unfinished legacy video binding must keep its bound revision current.
   AND NOT EXISTS(SELECT 1 FROM opc_video_material_bindings b
    JOIN runtime_scope_material bm ON bm.session_id=b.session_id AND bm.revision=b.material_revision AND NOT bm.revoked
    WHERE b.session_id=s.id AND NOT EXISTS(SELECT 1 FROM runtime_executions e WHERE e.session_id=b.session_id
     AND e.payload#>>'{scopeMaterial,revision}'=b.material_revision::text))
  ORDER BY s.id
 LOOP
  -- runtime_material caps the payload at 24000 bytes; leave an oversized session to the
  -- next item edit rather than truncating the positioning profile.
  IF octet_length(opc_work_material_payload(r.work_item_id)::text)>24000 THEN
   RAISE NOTICE 'A1 material reprojection skipped (capacity) for session %',r.session_id;CONTINUE;END IF;
  PERFORM runtime_material(r.actor_id,r.session_id,'save',md5(r.session_id::text||':material-reproject-v1')::uuid,
   r.revision,opc_work_material_payload(r.work_item_id));
 END LOOP;
END $$;

-- Library items carry the positioning version they were adopted under (O1 stale banner).
DO $$
DECLARE source text;needle text:='''items'',coalesce((SELECT jsonb_agg(jsonb_build_object(''workItemId'',i.work_item_id,';
BEGIN
 source:=pg_get_functiondef('public.opc_library_before_workspace_ui(uuid,text,date,date)'::regprocedure);
 IF position('''sourceVersionId'',i.source_version_id' IN source)=0 THEN
  IF position(needle IN source)=0 THEN RAISE EXCEPTION 'A1_SOURCE_MISMATCH: opc_library_before_workspace_ui items';END IF;
  EXECUTE replace(source,needle,needle||'''sourceVersionId'',i.source_version_id,');
 END IF;
END $$;

ALTER TABLE public.opc_data_events DROP CONSTRAINT IF EXISTS opc_data_events_action_check;
ALTER TABLE public.opc_data_events ADD CONSTRAINT opc_data_events_action_check
 CHECK(action IN ('topic_draft','topic_adoption','rewrite','abandon','brief_adoption'));

-- Update the topic brief from an owned, available execution's text. The original must be a
-- verbatim excerpt of that execution's body; the saved brief is what the user confirmed.
CREATE OR REPLACE FUNCTION public.opc_brief_adoption(
 p_actor_id uuid,p_request_id uuid,p_work_item_id uuid,p_expected_revision bigint,
 p_execution_id uuid,p_original text,p_brief text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions;i opc_items;ed opc_item_edits;p artifact_projects;prior opc_data_events;result jsonb;body text;
BEGIN
 PERFORM 1 FROM profiles WHERE id=p_actor_id FOR SHARE;
 IF p_request_id IS NULL OR p_work_item_id IS NULL OR p_expected_revision IS NULL
  OR char_length(trim(coalesce(p_original,''))) NOT BETWEEN 1 AND 20000
  OR char_length(trim(coalesce(p_brief,''))) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'OPC_DATA_EVENT_INVALID';END IF;
 e:=opc_data_execution(p_actor_id,p_execution_id);
 SELECT wi.* INTO i FROM opc_items wi JOIN artifact_projects ap ON ap.id=wi.work_item_id
  WHERE wi.work_item_id=p_work_item_id AND ap.actor_id=p_actor_id;
 IF i.work_item_id IS NULL OR NOT EXISTS(SELECT 1 FROM runtime_sessions s WHERE s.id=e.session_id AND s.actor_id=p_actor_id
  AND s.scope=jsonb_build_object('kind','work_item','projectId',i.account_project_id,'workItemId',i.work_item_id))
 THEN RAISE EXCEPTION 'OPC_DATA_SOURCE_DENIED';END IF;
 body:=coalesce(e.result->>'body',e.primary_result->>'body');
 IF body IS NULL OR position(p_original IN body)=0 THEN RAISE EXCEPTION 'OPC_DATA_SOURCE_DENIED';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,229));
 SELECT * INTO prior FROM opc_data_events WHERE actor_id=p_actor_id AND request_id=p_request_id AND item_key='';
 IF FOUND AND (prior.action<>'brief_adoption' OR prior.execution_id<>p_execution_id OR prior.target_project_id<>p_work_item_id
  OR prior.original IS DISTINCT FROM to_jsonb(p_original) OR prior.adopted IS DISTINCT FROM to_jsonb(trim(p_brief)))
 THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
 SELECT * INTO ed FROM opc_item_edits WHERE work_item_id=i.work_item_id;
 SELECT * INTO p FROM artifact_projects WHERE id=i.work_item_id;
 -- The existing edit keeps its own request replay, revision check, rename and material refresh.
 result:=opc_library_edit(p_actor_id,p_request_id,'item',i.work_item_id,p_expected_revision,jsonb_build_object(
  'title',coalesce(ed.title,p.work_title),'brief',trim(p_brief),'day',coalesce(ed.day,i.day)::text,
  'contentType',coalesce(ed.content_type,opc_item_content_type(i.work_item_id))));
 INSERT INTO opc_data_events(actor_id,request_id,item_key,action,execution_id,project_id,target_project_id,original,adopted)
 VALUES(p_actor_id,p_request_id,'','brief_adoption',e.id,i.work_item_id,i.work_item_id,to_jsonb(p_original),to_jsonb(trim(p_brief)))
 ON CONFLICT DO NOTHING;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.opc_brief_adoption(uuid,uuid,uuid,bigint,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.opc_brief_adoption(uuid,uuid,uuid,bigint,uuid,text,text) TO service_role;

COMMENT ON COLUMN public.opc_content_versions.kind IS
 'brief = article/image-text body text (正文, legacy name); script/storyboard/editing = video. The topic brief (简报) is opc_item_edits.brief, not a content version.';
COMMIT;
