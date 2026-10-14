-- DATA-ERASURE: deleting a positioning conversation keeps the user's confirmed content read-only.
-- Owner 2026-10-14: "删除定位对话后，已确认的内容保留为只读，可以再整份删除。"
-- Deleting the draft's conversation (content_erasure_confirm on its session) still revokes the draft's
-- billing scope, so no write or model call is possible. Reading the draft is allowed again only in this
-- "conversation deleted" state: own draft, its session deleted, its work (project) not deleted. Drafts
-- with nothing confirmed stay hidden from the list. A read-only draft is removed as a whole through
-- the existing work deletion (content_erasure_confirm 'artifact' on its project), after which the
-- existing CONTENT_ERASED guard of opc_query applies and it leaves the list.

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
  $r$'roundId',round_id,'mode',mode,'conversationDeleted',opc_draft_readonly(p_actor_id,draft_id))),'[]') FROM opc_drafts
   WHERE actor_id=p_actor_id AND (NOT EXISTS(SELECT 1 FROM bill2_drafts b WHERE b.id=opc_drafts.draft_id AND b.revoked)
    OR (opc_draft_readonly(p_actor_id,draft_id) AND opc_draft_has_confirmed(draft_id)))),$r$,'readonly list'),
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
DO $$ DECLARE sig text;source text;guard text:=
 ' IF opc_draft_readonly(p_actor_id,p_draft_id) THEN RAISE EXCEPTION ''CONTENT_ERASED'' USING ERRCODE=''42501''; END IF; -- 0249 read-only';
BEGIN
 FOREACH sig IN ARRAY ARRAY[
  'opc_adopt_topics(uuid,uuid,uuid,bigint,uuid,jsonb,jsonb)','opc_handoff(uuid,uuid,uuid,uuid,jsonb)',
  'opc_handoff_b1(uuid,uuid,uuid,uuid,jsonb)','opc_revise(uuid,uuid,uuid,uuid)',
  'opc_save_plan(uuid,uuid,uuid,bigint,uuid,jsonb)','opc_save_result(uuid,uuid,uuid,text,uuid)',
  'opc_topic_bind(uuid,uuid,uuid,uuid)','opc_topic_consent(uuid,uuid,uuid)',
  'opc_topic_draft_save(uuid,uuid,uuid,bigint,uuid,jsonb)','opc_topic_material(uuid,uuid,uuid,text)'] LOOP
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
