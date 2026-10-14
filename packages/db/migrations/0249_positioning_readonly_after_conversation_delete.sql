-- DATA-ERASURE: deleting a positioning conversation keeps the user's confirmed content read-only.
-- Owner 2026-10-14: "删除定位对话后，已确认的内容保留为只读，可以再整份删除。"
-- Deleting the draft's conversation (content_erasure_confirm on its session) still revokes the draft's
-- billing scope, so no write or model call is possible. Reading the draft is allowed again only in this
-- "conversation deleted" state: own draft, its session deleted, its work (project) not deleted. Drafts
-- with nothing confirmed stay hidden from the list. A read-only draft is removed as a whole through
-- the existing work deletion (content_erasure_confirm 'artifact' on its project), after which the
-- existing CONTENT_ERASED guard of opc_query applies and it leaves the list. List entries also carry
-- the draft's topic workspace session, so the page can clear that workspace's local copies on deletion.
-- The confirmed-only boundary is enforced here, not only by the API: opc_query returns only confirmed
-- content for a read-only draft (old and new API instances alike), and every other draft read refuses it.

CREATE OR REPLACE FUNCTION public.opc_draft_readonly(a uuid,draft uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM opc_drafts d
  JOIN runtime_sessions s ON s.id=d.session_id AND s.actor_id=a
  JOIN artifact_projects p ON p.id=d.project_id AND p.actor_id=a
  WHERE d.draft_id=draft AND d.actor_id=a
   AND (s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL)
   AND p.erased_at IS NULL AND p.content_deleted_at IS NULL)
$$;
REVOKE ALL ON FUNCTION public.opc_draft_readonly(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Something the user confirmed: a confirmed field, a confirmed step, or a published version.
CREATE OR REPLACE FUNCTION public.opc_draft_has_confirmed(draft uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM opc_drafts d JOIN artifact_rounds r ON r.id=d.round_id JOIN artifact_projects p ON p.id=d.project_id
  WHERE d.draft_id=draft AND (r.state='published' OR coalesce(p.current_version,0)>0 OR EXISTS(
   SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(r.steps)='object' THEN r.steps ELSE '{}'::jsonb END) st
   WHERE jsonb_typeof(st.value)='object' AND (st.value->>'valid'='true' OR EXISTS(
    SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(st.value->'information')='object' THEN st.value->'information' ELSE '{}'::jsonb END) f
    WHERE jsonb_typeof(f.value)='object' AND f.value->>'status'='confirmed')))))
$$;
REVOKE ALL ON FUNCTION public.opc_draft_has_confirmed(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- The only response opc_query gives for a read-only draft: step titles and state, the body of a
-- confirmed step, and confirmed field values. Turns, plans, handoffs, reports, unconfirmed values,
-- suggestions and notes never leave the database. Any other projection passes through unchanged.
CREATE OR REPLACE FUNCTION public.opc_readonly_projection(raw jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 WITH steps AS (SELECT s.value st,s.ord FROM jsonb_array_elements(CASE WHEN jsonb_typeof(raw#>'{snapshot,workflow,steps}')='array'
   THEN raw#>'{snapshot,workflow,steps}' ELSE '[]'::jsonb END) WITH ORDINALITY s(value,ord) WHERE jsonb_typeof(s.value->'id')='string')
 SELECT CASE WHEN raw->'conversationDeleted' IS DISTINCT FROM 'true'::jsonb THEN raw ELSE jsonb_build_object(
  'conversationDeleted',true,'draftId',raw->'draftId','projectId',raw->'projectId','roundId',raw->'roundId','sessionId',raw->'sessionId',
  'snapshot',jsonb_build_object('state',raw#>'{snapshot,state}',
   'workflow',jsonb_build_object('steps',coalesce((SELECT jsonb_agg(jsonb_build_object('id',st->'id','title',st->'title') ORDER BY ord) FROM steps),'[]'::jsonb)),
   'steps',coalesce((SELECT jsonb_object_agg(st->>'id',jsonb_strip_nulls(jsonb_build_object(
     'version',x->'version','reviewVersion',x->'reviewVersion','valid',coalesce(x->'valid'='true'::jsonb,false),
     'body',CASE WHEN x->'valid'='true'::jsonb AND jsonb_typeof(x->'body')='string' AND btrim(x->>'body')<>'' THEN x->'body' END)))
    FROM steps,LATERAL (SELECT raw#>ARRAY['snapshot','steps',st->>'id'] x) state),'{}'::jsonb)),
  'information',coalesce((SELECT jsonb_object_agg(st->>'id',jsonb_build_object(
    'schema',coalesce((SELECT jsonb_agg(jsonb_build_object('id',f->'id','title',f->'title') ORDER BY o)
     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i->'schema')='array' THEN i->'schema' ELSE '[]'::jsonb END) WITH ORDINALITY q(f,o)),'[]'::jsonb),
    'values',coalesce((SELECT jsonb_object_agg(v.key,jsonb_strip_nulls(jsonb_build_object('value',v.value->'value','status','confirmed',
      'nature',CASE WHEN jsonb_typeof(v.value->'nature')='string' THEN v.value->'nature' END)))
     FROM jsonb_each(CASE WHEN jsonb_typeof(i->'values')='object' THEN i->'values' ELSE '{}'::jsonb END) v
     WHERE v.value->>'status'='confirmed' AND jsonb_typeof(v.value->'value')='string'),'{}'::jsonb)))
   FROM steps,LATERAL (SELECT raw#>ARRAY['information',st->>'id'] i) info),'{}'::jsonb),
  'turns','[]'::jsonb,'plans','[]'::jsonb,'handoffs','[]'::jsonb,'report',NULL::jsonb) END
$$;
REVOKE ALL ON FUNCTION public.opc_readonly_projection(jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Patch the live definitions at unique anchors (same method as 0209/0232).
DO $$ DECLARE source text;sig text;needle text;replacement text;marker text; BEGIN
 FOR sig,needle,replacement,marker IN SELECT * FROM (VALUES
 ('opc_query_before_mentor_basis(uuid,uuid)',
  $n$ IF d.draft_id IS NULL OR NOT bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',d.draft_id)) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;$n$,
  $r$ IF d.draft_id IS NULL OR (NOT bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',d.draft_id))
  AND NOT opc_draft_readonly(p_actor_id,d.draft_id)) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;$r$,'readonly read'),
 ('opc_query_before_mentor_basis(uuid,uuid)',
  $n$ RETURN jsonb_build_object('draftId',d.draft_id,'sessionId',d.session_id,$n$,
  $r$ RETURN jsonb_build_object('conversationDeleted',opc_draft_readonly(p_actor_id,d.draft_id),'draftId',d.draft_id,'sessionId',d.session_id,$r$,
  'readonly flag'),
 ('opc_query_before_mentor_basis(uuid,uuid)',
  $n$'roundId',round_id,'mode',mode)),'[]') FROM opc_drafts WHERE actor_id=p_actor_id AND NOT EXISTS(SELECT 1 FROM bill2_drafts b WHERE b.id=opc_drafts.draft_id AND b.revoked)),$n$,
  $r$'roundId',round_id,'mode',mode,'conversationDeleted',opc_draft_readonly(p_actor_id,draft_id),
   'topicSessionId',(SELECT t.session_id FROM opc_topic_workspaces t WHERE t.draft_id=opc_drafts.draft_id AND t.actor_id=p_actor_id))),'[]') FROM opc_drafts
   WHERE actor_id=p_actor_id AND (NOT EXISTS(SELECT 1 FROM bill2_drafts b WHERE b.id=opc_drafts.draft_id AND b.revoked)
    OR (opc_draft_readonly(p_actor_id,draft_id) AND opc_draft_has_confirmed(draft_id)))),$r$,'readonly list'),
 ('opc_query(uuid,uuid)',
  $n$  RETURN jsonb_set(projection_result,'{information}',coalesce(information,'{}'::jsonb));$n$,
  $r$  RETURN opc_readonly_projection(jsonb_set(projection_result,'{information}',coalesce(information,'{}'::jsonb)));$r$,
  'readonly projection'),
 -- Called inside the draft read for each step (internal: no service_role grant); its output is dropped
 -- by opc_readonly_projection for a read-only draft.
 ('opc_historical_reach(uuid,uuid,text)',
  $n$ IF d.draft_id IS NULL OR NOT bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',p_draft_id)) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;$n$,
  $r$ IF d.draft_id IS NULL OR (NOT bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',p_draft_id))
  AND NOT opc_draft_readonly(p_actor_id,p_draft_id)) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;$r$,'readonly reach')
 ) changes(signature,anchor,patch,label) LOOP
  marker:='-- 0249 '||marker;
  source:=pg_get_functiondef(('public.'||sig)::regprocedure);
  IF position(marker IN source)=0 THEN
   IF length(source)-length(replace(source,needle,''))<>length(needle)
   THEN RAISE EXCEPTION 'OPC_READONLY_SOURCE_MISMATCH: % %',sig,marker;END IF;
   source:=replace(source,needle,replacement);
   source:=replace(source,'AS $function$',E'AS $function$\n'||marker||E'\n');
   EXECUTE source;
  END IF;
 END LOOP;
END $$;

-- Read-only is enforced by the server, not only by the page: every draft write that does not
-- already check the draft's billing scope refuses a read-only draft first (same narrow-guard
-- method as 0201). Writes that check the scope are already refused, because it stays revoked.
-- The draft reads other than opc_query (topic workspace, topic draft, plan result) refuse it too:
-- what they return is not confirmed positioning content.
DO $$ DECLARE sig text;source text;guard text:=
 ' IF opc_draft_readonly(p_actor_id,p_draft_id) THEN RAISE EXCEPTION ''CONTENT_ERASED'' USING ERRCODE=''42501''; END IF; -- 0249 read-only';
BEGIN
 FOREACH sig IN ARRAY ARRAY[
  'opc_adopt_topics(uuid,uuid,uuid,bigint,uuid,jsonb,jsonb)','opc_handoff(uuid,uuid,uuid,uuid,jsonb)',
  'opc_handoff_b1(uuid,uuid,uuid,uuid,jsonb)','opc_revise(uuid,uuid,uuid,uuid)',
  'opc_save_plan(uuid,uuid,uuid,bigint,uuid,jsonb)','opc_save_result(uuid,uuid,uuid,text,uuid)',
  'opc_topic_bind(uuid,uuid,uuid,uuid)','opc_topic_consent(uuid,uuid,uuid)',
  'opc_topic_draft_save(uuid,uuid,uuid,bigint,uuid,jsonb)','opc_topic_material(uuid,uuid,uuid,text)',
  'opc_adopt_topics_with_source(uuid,uuid,uuid,bigint,uuid,jsonb,jsonb,jsonb,uuid)',
  'opc_topic_draft_from_execution(uuid,uuid,uuid,bigint,uuid,uuid,jsonb)',
  'opc_step_material(uuid,uuid,uuid,text,text,text)','fusion_review_start(uuid,uuid,uuid,uuid,jsonb)',
  'opc_topic_draft_read(uuid,uuid)','opc_topic_read(uuid,uuid)','opc_plan_result(uuid,uuid,uuid)'] LOOP
  source:=pg_get_functiondef(('public.'||sig)::regprocedure);
  IF position('-- 0249 read-only' IN source)=0 THEN
   IF position('BEGIN' IN source)=0 THEN RAISE EXCEPTION 'OPC_READONLY_SOURCE_MISMATCH: %',sig; END IF;
   EXECUTE regexp_replace(source,'\mBEGIN\M',E'BEGIN\n'||guard);
  END IF;
  -- Never skip silently: every listed write must now carry the guard.
  IF position('-- 0249 read-only' IN pg_get_functiondef(('public.'||sig)::regprocedure))=0 THEN
   RAISE EXCEPTION 'OPC_READONLY_GUARD_MISSING: %',sig; END IF;
 END LOOP;
END $$;
