-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-10b C2 (number 0450 set by the controller, after 0449): the content of a work_item conversation on kind=chat. Saving and
-- reading change, the business rules of the old functions stay.
--   opc_content_versions   turn_actor_id, turn_id: which turn wrote a version (FK; one source, as opc_result_links). A version keeps its
--                          turn with ON DELETE NO ACTION; turns are billing records kept 3 years and nothing deletes them today.
--   opc_content_from_turn, opc_video_results_from_turn, opc_video_turn_check   the turn twins of *_from_execution and
--                          opc_video_execution_check: the body is the turn's visible reply; the material and the derived source are what
--                          Node froze in policy.workMaterial / policy.workSource (old: payload.scopeMaterial, injected_source).
--   opc_content_turn_available   opc_result_link_available for a turn id; opc_content_allowed follows it, as runtime_history_available.
--   opc_work_check         takes the request id: a claimed request reads its claimed revision (and returns it to freeze); another request
--                          may not take a claimed revision before the claimant opened (opc_video_runtime_binding_guard's rule).
--   opc_work_source        read of the saved content a derived Skill reads (opc_content_source_current's choice).
--   opc_video_material_prepare   the conflict loop and abandon also see a claimed request that became a turn.
--   content_erasure_scope/_confirm/_mark_session/_saved_readable   a deleted version takes its turn's reply and raw body with it, like its
--                          execution; scope gains 'turns'.
--   opc_content_manual_save, opc_library_before_workspace_ui, turn_session_view   a turn counts as a root of the source chain; turnId in
--                          the library; a reply says whether it is a work Skill's.
-- Compatible: new columns are null for old rows and old paths are unchanged; nothing saves by turn until the page switches. Repeatable:
-- ADD COLUMN IF NOT EXISTS, constraints dropped first, CREATE OR REPLACE. Recovery: re-apply the previous function bodies; while no row has
-- turn_id the columns can be dropped; versions saved by turn are user data and stay.
BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE public.opc_content_versions ADD COLUMN IF NOT EXISTS turn_actor_id uuid, ADD COLUMN IF NOT EXISTS turn_id bigint;
ALTER TABLE public.opc_content_versions DROP CONSTRAINT IF EXISTS opc_content_versions_turn_fkey;
ALTER TABLE public.opc_content_versions ADD CONSTRAINT opc_content_versions_turn_fkey FOREIGN KEY (turn_actor_id, turn_id)
  REFERENCES public.turns(actor_id, id) ON DELETE NO ACTION;
ALTER TABLE public.opc_content_versions DROP CONSTRAINT IF EXISTS opc_content_versions_one_source;
ALTER TABLE public.opc_content_versions ADD CONSTRAINT opc_content_versions_one_source CHECK
  ((turn_actor_id IS NULL AND turn_id IS NULL)
   OR (execution_id IS NULL AND turn_actor_id=actor_id AND turn_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS opc_content_versions_turn ON public.opc_content_versions (turn_actor_id, turn_id) WHERE turn_id IS NOT NULL;

DROP FUNCTION IF EXISTS public.opc_work_check(uuid, uuid, boolean);

CREATE OR REPLACE FUNCTION public.opc_work_check(p_actor_id uuid, p_session_id uuid, p_video_required boolean, p_request_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;item uuid;work jsonb;m runtime_scope_material;binding opc_video_material_bindings;
BEGIN
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
 IF s.id IS NULL OR s.scope->>'kind' IS DISTINCT FROM 'work_item' THEN RETURN jsonb_build_object('work',NULL); END IF; -- turn_open refuses another account's conversation
 -- By read only: opc_assert_business_writable takes a row lock, which the read client refuses.
 IF EXISTS(SELECT 1 FROM opc_businesses b WHERE b.id=opc_target_business(p_actor_id,jsonb_build_object('sessionId',p_session_id))
   AND b.actor_id=p_actor_id AND b.archived_at IS NOT NULL) THEN
  RAISE EXCEPTION 'OPC_BUSINESS_ARCHIVED' USING ERRCODE='42501';
 END IF;
 item:=(s.scope->>'workItemId')::uuid;
 IF p_video_required AND opc_item_content_type(item)<>'video' THEN RAISE EXCEPTION 'OPC_VIDEO_TYPE_REQUIRED'; END IF;
 -- The work method is the Skill revision of the round the item came from (opc_query's methodRevisionId), never the module's latest.
 SELECT jsonb_build_object('moduleId',p.module_id,'skillId',p.skill_id,'revisionId',r.revision_id) INTO work
  FROM artifact_projects p JOIN opc_items i ON i.work_item_id=p.id JOIN artifact_versions v ON v.id=i.source_version_id
  JOIN artifact_rounds r ON r.id=v.round_id WHERE p.id=item AND p.actor_id=p_actor_id;
 -- A request that claimed video material (opc_video_material_prepare) reads exactly that revision.
 IF p_request_id IS NOT NULL THEN
  SELECT * INTO binding FROM opc_video_material_bindings WHERE actor_id=p_actor_id AND request_id=p_request_id;
 END IF;
 IF binding.request_id IS NOT NULL THEN
  SELECT * INTO m FROM runtime_scope_material WHERE session_id=binding.session_id AND revision=binding.material_revision;
  IF binding.session_id<>s.id OR binding.work_item_id<>item OR m.session_id IS NULL OR m.revoked OR m.erased_at IS NOT NULL THEN
   RAISE EXCEPTION 'OPC_CONTENT_BINDING' USING ERRCODE='42501';
  END IF;
 ELSE
  -- The brief and material the old path froze for the next turn: the newest of this conversation not revoked.
  SELECT * INTO m FROM runtime_scope_material
   WHERE session_id=s.id AND NOT revoked AND erased_at IS NULL ORDER BY revision DESC LIMIT 1;
  -- opc_video_runtime_binding_guard's first rule: until the claimed request opens, no other request may take its material.
  IF EXISTS(SELECT 1 FROM opc_video_material_bindings claimed WHERE claimed.actor_id=p_actor_id AND claimed.session_id=s.id
    AND claimed.material_revision=m.revision
    AND NOT EXISTS(SELECT 1 FROM runtime_executions e WHERE e.actor_id=p_actor_id AND e.request_id=claimed.request_id)
    AND NOT EXISTS(SELECT 1 FROM turns t WHERE t.actor_id=p_actor_id AND t.request_id=claimed.request_id)) THEN
   RAISE EXCEPTION 'OPC_CONTENT_BINDING' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN jsonb_build_object('work',work||jsonb_build_object('brief',m.content->'brief','material',m.content->'material',
  'videoPackage',binding.request_id IS NOT NULL,'materialRevision',m.revision,'materialHash',m.content_hash));
END $function$;

CREATE OR REPLACE FUNCTION public.opc_work_source(p_actor_id uuid, p_session_id uuid, p_kind text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;
BEGIN
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
 IF s.id IS NULL OR s.scope->>'kind' IS DISTINCT FROM 'work_item' THEN RETURN jsonb_build_object('status','none'); END IF;
 RETURN opc_content_source_pick(p_actor_id,(s.scope->>'workItemId')::uuid,p_kind,NULL,false);
END $function$;

CREATE OR REPLACE FUNCTION public.opc_content_turn_available(p_actor_id uuid, p_turn_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE l opc_result_links;
BEGIN
 l.turn_actor_id:=p_actor_id;l.turn_id:=p_turn_id;
 RETURN opc_result_link_available(l);
END $function$;

CREATE OR REPLACE FUNCTION public.opc_content_allowed(p_actor_id uuid, p_content_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE current_id uuid:=p_content_id;seen uuid[]:='{}';c opc_content_versions;i opc_items;p artifact_projects;
BEGIN
 -- D7 read boundary
 IF EXISTS(SELECT 1 FROM opc_content_versions WHERE id=p_content_id AND actor_id=p_actor_id AND erased_at IS NOT NULL) THEN RETURN false; END IF;
 LOOP
  IF current_id IS NULL THEN RETURN true;END IF;
  IF current_id=ANY(seen) THEN RETURN false;END IF;
  SELECT * INTO c FROM opc_content_versions WHERE id=current_id AND actor_id=p_actor_id;
  IF NOT FOUND OR c.erased_at IS NOT NULL THEN RETURN false;END IF;
  SELECT wi.* INTO i FROM opc_items wi WHERE wi.work_item_id=c.work_item_id;
  SELECT ap.* INTO p FROM artifact_projects ap WHERE ap.id=i.work_item_id AND ap.actor_id=p_actor_id;
  IF i.work_item_id IS NULL OR p.id IS NULL OR NOT opc_source_allowed(p_actor_id,i.source_version_id)
   OR (c.execution_id IS NOT NULL AND NOT runtime_history_available(c.execution_id))
   OR (c.turn_id IS NOT NULL AND NOT opc_content_turn_available(p_actor_id,c.turn_id)) THEN RETURN false;END IF;
  seen:=array_append(seen,current_id);current_id:=c.source_content_id;
 END LOOP;
END $function$;

CREATE OR REPLACE FUNCTION public.content_erasure_saved_readable(a uuid, cid uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE c opc_content_versions;p artifact_projects;v artifact_versions;r artifact_rounds;
 current_id uuid:=cid;seen uuid[]:='{}';first_row boolean:=true;e runtime_executions;
BEGIN
 IF opc_content_allowed(a,cid) THEN RETURN true; END IF;
 LOOP
  IF current_id IS NULL THEN RETURN true; END IF;
  IF current_id=ANY(seen) THEN RETURN false; END IF;
  SELECT * INTO c FROM opc_content_versions WHERE id=current_id AND actor_id=a;
  IF NOT FOUND OR (first_row AND c.erased_at IS NOT NULL) THEN RETURN false; END IF;
  SELECT * INTO p FROM artifact_projects WHERE id=c.work_item_id AND actor_id=a;
  IF NOT FOUND OR (first_row AND p.erased_at IS NOT NULL) THEN RETURN false; END IF;
  SELECT av.* INTO v FROM opc_items i JOIN artifact_versions av ON av.id=i.source_version_id WHERE i.work_item_id=p.id;
  SELECT * INTO p FROM artifact_projects WHERE id=v.project_id AND actor_id=a;
  SELECT * INTO r FROM artifact_rounds WHERE id=v.round_id AND state='published';
  IF p.id IS NULL OR r.id IS NULL THEN RETURN false; END IF;
  -- Retain current package/actor authorization even when the source body is gone.
  PERFORM read_skill_package(a,p.module_id,p.skill_id,r.revision_id,r.package_hash,NULL);
  IF v.erased_at IS NULL AND NOT opc_source_allowed(a,v.id) THEN RETURN false; END IF;
  IF c.execution_id IS NOT NULL THEN
   SELECT * INTO e FROM runtime_executions WHERE id=c.execution_id AND actor_id=a;
   IF e.id IS NULL OR (e.content_deleted_at IS NULL AND NOT runtime_history_available(e.id)) THEN RETURN false; END IF;
  END IF;
  -- A deleted conversation leaves the version readable, as a deleted execution does; an account being erased does not.
  IF c.turn_id IS NOT NULL AND EXISTS(SELECT 1 FROM turns t WHERE t.actor_id=a AND t.id=c.turn_id
    AND (turn_tombstones(a,t.session_id,'{}'::jsonb)->>'accountErasing')::boolean) THEN RETURN false; END IF;
  seen:=array_append(seen,current_id);current_id:=c.source_content_id;first_row:=false;
 END LOOP;
EXCEPTION WHEN insufficient_privilege OR raise_exception THEN RETURN false;
END $function$;

CREATE OR REPLACE FUNCTION public.opc_content_manual_save(p_actor_id uuid, p_work_item_id uuid, p_request_id uuid, p_expected_version bigint, p_source_content_id uuid, p_kind text, p_status text, p_title text, p_body text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE i opc_items;s runtime_sessions;c opc_content_versions;previous opc_content_versions;
 n bigint;material_revision bigint;clean_title text:=trim(coalesce(p_title,''));
 clean_body text:=trim(coalesce(p_body,''));
BEGIN
 -- 0324 archived business guard
 IF true THEN PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('workItemId',p_work_item_id)); END IF;

 -- D7 read boundary
 IF EXISTS(SELECT 1 FROM opc_content_versions WHERE actor_id=p_actor_id AND request_id=p_request_id AND kind=p_kind AND erased_at IS NOT NULL) THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF;
 PERFORM bill2_actor(p_actor_id);
 -- A manually revised script must descend from a saved script execution.
 IF p_kind IS NULL OR p_kind NOT IN ('brief','script') OR p_status IS NULL OR p_status NOT IN ('draft','final')
  OR char_length(clean_title) NOT BETWEEN 1 AND 160
  OR char_length(clean_body) NOT BETWEEN 1 AND 20000
  OR p_expected_version IS NULL OR p_expected_version<0 THEN RAISE EXCEPTION 'OPC_CONTENT_INVALID';END IF;
 -- Serialise the same request before reading its immutable result. The second
 -- lock serialises different edits on one work item without blocking other work.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,123));
 SELECT wi.* INTO i FROM opc_items wi JOIN artifact_projects p ON p.id=wi.work_item_id
  WHERE wi.work_item_id=p_work_item_id AND p.actor_id=p_actor_id
   AND opc_source_allowed(p_actor_id,wi.source_version_id) FOR UPDATE OF wi;
 IF i.work_item_id IS NULL THEN RAISE EXCEPTION 'OPC_CONTENT_DENIED';END IF;
 IF (p_kind='brief' AND opc_item_content_type(p_work_item_id) NOT IN ('article','image_text'))
  OR (p_kind='script' AND opc_item_content_type(p_work_item_id)<>'video')
  THEN RAISE EXCEPTION 'OPC_CONTENT_INVALID';END IF;
 SELECT * INTO s FROM runtime_sessions WHERE actor_id=p_actor_id
  AND scope=jsonb_build_object('kind','work_item','projectId',i.account_project_id,'workItemId',i.work_item_id);
 IF s.id IS NULL THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
 SELECT * INTO c FROM opc_content_versions WHERE actor_id=p_actor_id
  AND request_id=p_request_id AND kind=p_kind;
 IF FOUND THEN
  IF c.work_item_id<>p_work_item_id OR c.version<>p_expected_version+1
   OR c.source_content_id IS DISTINCT FROM p_source_content_id
   OR c.status<>p_status OR c.title IS DISTINCT FROM clean_title
   OR c.body<>clean_body OR c.execution_id IS NOT NULL OR c.turn_id IS NOT NULL
   THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  IF NOT opc_content_allowed(p_actor_id,c.id) THEN RAISE EXCEPTION 'OPC_CONTENT_SOURCE';END IF;
 ELSE
  SELECT coalesce(max(version),0) INTO n FROM opc_content_versions
   WHERE work_item_id=p_work_item_id AND kind=p_kind;
  IF n<>p_expected_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
  IF n>0 THEN
   SELECT * INTO previous FROM opc_content_versions WHERE work_item_id=p_work_item_id
    AND kind=p_kind AND version=n;
   IF previous.id IS DISTINCT FROM p_source_content_id OR
    NOT opc_content_allowed(p_actor_id,previous.id) THEN
    RAISE EXCEPTION 'OPC_CONTENT_SOURCE';END IF;
  ELSIF p_source_content_id IS NOT NULL THEN RAISE EXCEPTION 'OPC_CONTENT_SOURCE';END IF;
  IF p_kind='script' THEN
   -- Manual video revisions are never a new root. Follow the immutable source
   -- chain to an admitted Runtime execution, including old revisions.
   IF p_source_content_id IS NULL OR NOT EXISTS(
    WITH RECURSIVE ancestry AS (
     SELECT id,source_content_id,execution_id,turn_id,ARRAY[id] visited FROM opc_content_versions
      WHERE id=p_source_content_id AND actor_id=p_actor_id AND work_item_id=p_work_item_id AND kind='script'
     UNION ALL
     SELECT parent.id,parent.source_content_id,parent.execution_id,parent.turn_id,ancestry.visited||parent.id
      FROM opc_content_versions parent JOIN ancestry ON parent.id=ancestry.source_content_id
      WHERE parent.actor_id=p_actor_id AND parent.work_item_id=p_work_item_id AND parent.kind='script' AND NOT parent.id=ANY(ancestry.visited)
    ) SELECT 1 FROM ancestry WHERE execution_id IS NOT NULL OR turn_id IS NOT NULL
   ) THEN RAISE EXCEPTION 'OPC_CONTENT_SOURCE';END IF;
  END IF;
  INSERT INTO opc_content_versions(actor_id,work_item_id,kind,version,status,title,body,
   source_content_id,execution_id,request_id)
   VALUES(p_actor_id,p_work_item_id,p_kind,n+1,p_status,clean_title,clean_body,
    p_source_content_id,NULL,p_request_id) RETURNING * INTO c;
  -- A1 saved bodies stay out of scope material; injection is per derived turn (A2).
 END IF;
 RETURN jsonb_build_object('id',c.id,'kind',c.kind,'version',c.version,
  'status',c.status,'title',c.title,'body',c.body);
END $function$;

CREATE OR REPLACE FUNCTION public.opc_library_before_workspace_ui(p_actor_id uuid, p_search text DEFAULT ''::text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE q text:='%'||lower(trim(coalesce(p_search,'')))||'%';
BEGIN
 PERFORM bill2_actor(p_actor_id);
 RETURN jsonb_build_object('businesses',coalesce((SELECT jsonb_agg(jsonb_build_object(
  'businessId',b.id,'name',b.name,'revision',b.revision,'sourceVersionId',b.current_source_version_id,
  'sourceAvailable',CASE WHEN b.current_source_version_id IS NULL THEN false ELSE opc_source_allowed(p_actor_id,b.current_source_version_id) END,
  'accounts',coalesce((SELECT jsonb_agg(jsonb_build_object('projectId',a.project_id,'platform',a.platform,'account',a.account_key,'stage',a.stage,'revision',a.revision,
   'strategyDraftId',(SELECT d.draft_id FROM artifact_versions v JOIN opc_drafts d ON d.project_id=v.project_id AND d.actor_id=p_actor_id
    WHERE v.id=a.source_version_id AND opc_source_allowed(p_actor_id,v.id)
     AND NOT EXISTS(SELECT 1 FROM bill2_drafts retired WHERE retired.id=d.draft_id AND retired.revoked)
    LIMIT 1),
   'items',coalesce((SELECT jsonb_agg(jsonb_build_object('workItemId',i.work_item_id,'sourceVersionId',i.source_version_id,'title',coalesce(ed.title,p.work_title),'brief',CASE WHEN opc_source_allowed(p_actor_id,i.source_version_id) THEN coalesce(ed.brief,i.brief) ELSE NULL END,'day',coalesce(ed.day,i.day),'revision',coalesce(ed.revision,1),'contentType',opc_item_content_type(i.work_item_id),'sessionId',s.id,'sourceAvailable',opc_source_allowed(p_actor_id,i.source_version_id),
    'lastActivityAt',coalesce((SELECT max(c.created_at) FROM opc_content_versions c WHERE c.work_item_id=i.work_item_id),p.created_at),
    'content',coalesce((WITH checked AS MATERIALIZED (SELECT version.*,content_erasure_saved_readable(p_actor_id,version.id) AS allowed FROM opc_content_versions version WHERE version.work_item_id=i.work_item_id AND version.erased_at IS NULL) SELECT jsonb_agg(jsonb_build_object('id',c.id,'kind',c.kind,'version',c.version,'status',c.status,'title',CASE WHEN c.allowed THEN c.title ELSE NULL END,'body',CASE WHEN c.allowed THEN c.body ELSE NULL END,'contentAvailable',c.allowed,'sourceAvailable',opc_content_allowed(p_actor_id,c.id),'sourceContentId',c.source_content_id,'executionId',c.execution_id,'turnId',c.turn_id,'requestId',c.request_id,'createdAt',c.created_at) ORDER BY c.created_at) FROM checked c),'[]'::jsonb)) ORDER BY i.day,p.work_title)
    FROM opc_items i JOIN artifact_projects p ON p.id=i.work_item_id LEFT JOIN opc_item_edits ed ON ed.work_item_id=i.work_item_id LEFT JOIN runtime_sessions s ON s.actor_id=p_actor_id AND s.scope=jsonb_build_object('kind','work_item','projectId',a.project_id,'workItemId',i.work_item_id)
    WHERE i.erased_at IS NULL AND p.erased_at IS NULL AND p.content_deleted_at IS NULL
 -- D7 library roots
 AND i.account_project_id=a.project_id AND (p_from IS NULL OR coalesce(ed.day,i.day)>=p_from) AND (p_to IS NULL OR coalesce(ed.day,i.day)<=p_to)
     AND (q='%%' OR lower(coalesce(ed.title,p.work_title)) LIKE q OR (opc_source_allowed(p_actor_id,i.source_version_id) AND lower(coalesce(ed.brief,i.brief)) LIKE q))),'[]'::jsonb)) ORDER BY a.platform,a.account_key)
   FROM opc_accounts a WHERE a.erased_at IS NULL AND a.actor_id=p_actor_id AND a.business_id=b.id),'[]'::jsonb)) ORDER BY b.created_at)
  FROM opc_businesses b WHERE b.actor_id=p_actor_id),'[]'::jsonb));
END $function$;

CREATE OR REPLACE FUNCTION public.opc_content_from_turn(p_actor_id uuid, p_work_item_id uuid, p_request_id uuid, p_expected_version bigint, p_kind text, p_status text, p_turn_id bigint, p_source_content_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE i opc_items;s runtime_sessions;t turns;c opc_content_versions;n bigint;source opc_content_versions;body text;frozen uuid;
BEGIN
 PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('workItemId',p_work_item_id));
 IF EXISTS(SELECT 1 FROM opc_content_versions WHERE actor_id=p_actor_id AND request_id=p_request_id AND kind=p_kind AND erased_at IS NOT NULL) THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF;
 PERFORM bill2_actor(p_actor_id);
 SELECT wi.* INTO i FROM opc_items wi JOIN artifact_projects p ON p.id=wi.work_item_id WHERE wi.work_item_id=p_work_item_id AND p.actor_id=p_actor_id;
 -- The session first, then the turn (turn_open's order): a delete that marked this conversation is seen below, one that waits
 -- sees the version committed and cleans it (opc_work_result_turn).
 SELECT * INTO s FROM runtime_sessions WHERE actor_id=p_actor_id AND scope=jsonb_build_object('kind','work_item','projectId',i.account_project_id,'workItemId',i.work_item_id) FOR SHARE;
 SELECT * INTO t FROM turns WHERE actor_id=p_actor_id AND id=p_turn_id AND session_id=s.id FOR UPDATE;
 IF i.work_item_id IS NULL OR t.id IS NULL OR t.kind<>'chat' OR t.close_kind IS DISTINCT FROM 'completed'
   OR NOT opc_content_turn_available(p_actor_id,p_turn_id) THEN RAISE EXCEPTION 'OPC_CONTENT_DENIED';END IF;
 SELECT string_agg(m.content,E'\n\n' ORDER BY m.seq) INTO body FROM session_messages m
  WHERE m.session_id=s.id AND m.turn_id=p_turn_id AND m.role='assistant' AND m.visible;
 IF p_kind NOT IN ('brief','script','storyboard','editing') OR p_status NOT IN ('draft','final') OR char_length(coalesce(body,'')) NOT BETWEEN 1 AND 20000 THEN RAISE EXCEPTION 'OPC_CONTENT_INVALID';END IF;
 -- A storyboard reads the script, editing the storyboard, as supplied to the turn that wrote it (policy.workSource).
 IF p_kind IN ('storyboard','editing') THEN
  frozen:=CASE WHEN t.policy#>>'{workSource,kind}'=CASE p_kind WHEN 'storyboard' THEN 'script' ELSE 'storyboard' END THEN (t.policy#>>'{workSource,contentId}')::uuid END;
  IF p_source_content_id IS NULL THEN p_source_content_id:=frozen;
  ELSIF p_source_content_id IS DISTINCT FROM frozen THEN RAISE EXCEPTION 'OPC_CONTENT_SOURCE';
  END IF;
  IF p_source_content_id IS NULL OR NOT opc_content_allowed(p_actor_id,p_source_content_id) THEN RAISE EXCEPTION 'OPC_CONTENT_SOURCE';END IF;
 END IF;
 SELECT * INTO c FROM opc_content_versions WHERE actor_id=p_actor_id AND request_id=p_request_id AND kind=p_kind;
 IF FOUND THEN
  IF c.work_item_id<>p_work_item_id OR c.turn_id IS DISTINCT FROM p_turn_id OR c.status<>p_status OR c.source_content_id IS DISTINCT FROM p_source_content_id OR c.version<>p_expected_version+1 THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
 ELSE
  IF p_kind IN ('script','storyboard','editing') AND opc_item_content_type(p_work_item_id)<>'video' THEN RAISE EXCEPTION 'OPC_VIDEO_TYPE_REQUIRED';END IF;
  SELECT coalesce(max(version),0) INTO n FROM opc_content_versions WHERE work_item_id=p_work_item_id AND kind=p_kind;
  IF n<>p_expected_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
  IF p_source_content_id IS NOT NULL THEN SELECT * INTO source FROM opc_content_versions WHERE id=p_source_content_id AND work_item_id=p_work_item_id;IF source.id IS NULL THEN RAISE EXCEPTION 'OPC_CONTENT_SOURCE';END IF;END IF;
  INSERT INTO opc_content_versions(actor_id,work_item_id,kind,version,status,body,source_content_id,turn_actor_id,turn_id,request_id)
   VALUES(p_actor_id,p_work_item_id,p_kind,n+1,p_status,body,p_source_content_id,p_actor_id,p_turn_id,p_request_id) RETURNING * INTO c;
 END IF;
 RETURN jsonb_build_object('id',c.id,'kind',c.kind,'version',c.version,'status',c.status,'body',c.body);
END $function$;

CREATE OR REPLACE FUNCTION public.opc_video_turn_check(p_actor_id uuid, p_work_item_id uuid, p_turn_id bigint, p_source_script_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE i opc_items;s runtime_sessions;t turns;script opc_content_versions;m runtime_scope_material;
 ancestor opc_content_versions;current_id uuid;seen uuid[]:='{}';admitted boolean:=false;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT wi.* INTO i FROM opc_items wi JOIN artifact_projects p ON p.id=wi.work_item_id
  WHERE wi.work_item_id=p_work_item_id AND p.actor_id=p_actor_id AND opc_source_allowed(p_actor_id,wi.source_version_id);
 SELECT * INTO s FROM runtime_sessions WHERE actor_id=p_actor_id AND scope=jsonb_build_object('kind','work_item','projectId',i.account_project_id,'workItemId',i.work_item_id);
 SELECT * INTO t FROM turns WHERE id=p_turn_id AND actor_id=p_actor_id AND session_id=s.id;
 SELECT * INTO script FROM opc_content_versions WHERE id=p_source_script_id AND actor_id=p_actor_id AND work_item_id=p_work_item_id AND kind='script' AND status='final';
 SELECT * INTO m FROM runtime_scope_material WHERE session_id=s.id AND revision=(t.policy#>>'{workMaterial,revision}')::bigint AND NOT revoked;
 IF i.work_item_id IS NULL OR t.id IS NULL OR script.id IS NULL OR NOT opc_content_allowed(p_actor_id,script.id)
  OR m.session_id IS NULL OR t.policy#>>'{workMaterial,hash}' IS DISTINCT FROM m.content_hash
  OR m.content->>'brief' IS DISTINCT FROM '已定稿口播稿：'||script.body
  OR NOT (m.request_id=script.request_id OR EXISTS(SELECT 1 FROM opc_video_material_bindings b WHERE b.actor_id=p_actor_id AND b.session_id=m.session_id AND b.material_revision=m.revision AND b.source_script_id=script.id))
  THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
 -- Manual revisions deliberately have no execution_id. Validate every source
 -- edge in this work item's script chain, then require an available admitted
 -- execution. Do not accept a valid prefix of a broken or cyclic chain.
 current_id:=script.id;
 WHILE current_id IS NOT NULL LOOP
  IF current_id=ANY(seen) THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
  SELECT * INTO ancestor FROM opc_content_versions WHERE id=current_id
   AND actor_id=p_actor_id AND work_item_id=p_work_item_id AND kind='script';
  IF NOT FOUND THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
  IF ancestor.turn_id IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM turns original WHERE id=ancestor.turn_id AND actor_id=p_actor_id AND session_id=s.id AND close_kind='completed')
    OR NOT opc_content_turn_available(p_actor_id,ancestor.turn_id)
    THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
   admitted:=true;
  END IF;
  IF ancestor.execution_id IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM runtime_executions original WHERE id=ancestor.execution_id
     AND actor_id=p_actor_id AND session_id=s.id AND state='completed')
    OR NOT runtime_history_available(ancestor.execution_id)
    THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
   admitted:=true;
  END IF;
  seen:=array_append(seen,current_id);current_id:=ancestor.source_content_id;
 END LOOP;
 IF NOT admitted THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
 RETURN jsonb_build_object('valid',true,'materialRevision',m.revision);
END $function$;

CREATE OR REPLACE FUNCTION public.opc_video_results_from_turn(p_actor_id uuid, p_work_item_id uuid, p_request_id uuid, p_turn_id bigint, p_source_script_id uuid, p_expected_storyboard_version bigint, p_expected_editing_version bigint, p_storyboard boolean, p_editing boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE i opc_items;s runtime_sessions;t turns;script opc_content_versions;binding opc_video_material_bindings;raw text;package jsonb;story opc_content_versions;editing_result opc_content_versions;n bigint;result jsonb:='{}';
BEGIN
 -- 0324 archived business guard
 IF true THEN PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('workItemId',p_work_item_id)); END IF;

 PERFORM bill2_actor(p_actor_id);
 IF NOT coalesce(p_storyboard,false) AND NOT coalesce(p_editing,false) THEN RAISE EXCEPTION 'OPC_CONTENT_CHOICE_INVALID';END IF;
 SELECT b.* INTO binding FROM opc_video_material_bindings b JOIN turns x ON x.actor_id=b.actor_id AND x.request_id=b.request_id
  WHERE b.actor_id=p_actor_id AND b.request_id=p_request_id AND x.id=p_turn_id;
 IF binding.request_id IS NULL OR binding.work_item_id<>p_work_item_id OR binding.source_script_id<>p_source_script_id
  OR (binding.storyboard IS NOT NULL AND binding.storyboard IS DISTINCT FROM p_storyboard)
  OR (binding.editing IS NOT NULL AND binding.editing IS DISTINCT FROM p_editing)
  OR (binding.expected_storyboard_version IS NOT NULL AND binding.expected_storyboard_version<>p_expected_storyboard_version)
  OR (binding.expected_editing_version IS NOT NULL AND binding.expected_editing_version<>p_expected_editing_version)
  THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
 PERFORM opc_video_turn_check(p_actor_id,p_work_item_id,p_turn_id,p_source_script_id);
 SELECT wi.* INTO i FROM opc_items wi JOIN artifact_projects p ON p.id=wi.work_item_id WHERE wi.work_item_id=p_work_item_id AND p.actor_id=p_actor_id;
 -- The session, then the turn (opc_content_from_turn).
 SELECT * INTO s FROM runtime_sessions WHERE actor_id=p_actor_id AND scope=jsonb_build_object('kind','work_item','projectId',i.account_project_id,'workItemId',i.work_item_id) FOR SHARE;
 SELECT * INTO t FROM turns WHERE id=p_turn_id AND actor_id=p_actor_id AND session_id=s.id FOR UPDATE;
 SELECT * INTO script FROM opc_content_versions WHERE id=p_source_script_id AND actor_id=p_actor_id AND work_item_id=p_work_item_id AND kind='script' AND status='final';
 IF i.work_item_id IS NULL OR t.id IS NULL OR t.close_kind IS DISTINCT FROM 'completed' OR script.id IS NULL OR NOT opc_content_turn_available(p_actor_id,p_turn_id) THEN RAISE EXCEPTION 'OPC_CONTENT_DENIED';END IF;
 SELECT * INTO story FROM opc_content_versions WHERE actor_id=p_actor_id AND request_id=p_request_id AND kind='storyboard';
 SELECT * INTO editing_result FROM opc_content_versions WHERE actor_id=p_actor_id AND request_id=p_request_id AND kind='editing';
 IF story.id IS NOT NULL OR editing_result.id IS NOT NULL THEN
  IF (p_storyboard IS DISTINCT FROM (story.id IS NOT NULL)) OR (p_editing IS DISTINCT FROM (editing_result.id IS NOT NULL))
   OR (story.id IS NOT NULL AND (story.turn_id IS DISTINCT FROM p_turn_id OR story.source_content_id<>script.id))
   OR (editing_result.id IS NOT NULL AND (editing_result.turn_id IS DISTINCT FROM p_turn_id OR editing_result.source_content_id<>script.id)) THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  IF story.id IS NOT NULL THEN result:=result||jsonb_build_object('storyboard',jsonb_build_object('id',story.id,'version',story.version));END IF;
  IF editing_result.id IS NOT NULL THEN result:=result||jsonb_build_object('editing',jsonb_build_object('id',editing_result.id,'version',editing_result.version));END IF;
  RETURN result;
 END IF;
 IF EXISTS(SELECT 1 FROM opc_content_versions c WHERE c.actor_id=p_actor_id AND c.work_item_id=p_work_item_id AND c.source_content_id=script.id AND ((p_storyboard AND c.kind='storyboard') OR (p_editing AND c.kind='editing'))) THEN
  RAISE EXCEPTION 'OPC_CONTENT_ALREADY_GENERATED';
 END IF;
 SELECT string_agg(m.content,E'\n\n' ORDER BY m.seq) INTO raw FROM session_messages m
  WHERE m.session_id=s.id AND m.turn_id=p_turn_id AND m.role='assistant' AND m.visible;
 BEGIN package:=raw::jsonb;EXCEPTION WHEN others THEN RAISE EXCEPTION 'OPC_CONTENT_RESPONSE_INVALID';END;
 IF jsonb_typeof(package) IS DISTINCT FROM 'object'
  OR (p_storyboard AND p_editing AND package-ARRAY['storyboard','editing'] IS DISTINCT FROM '{}'::jsonb)
  OR (p_storyboard AND NOT p_editing AND package-ARRAY['storyboard'] IS DISTINCT FROM '{}'::jsonb)
  OR (p_editing AND NOT p_storyboard AND package-ARRAY['editing'] IS DISTINCT FROM '{}'::jsonb)
  OR (p_storyboard AND (jsonb_typeof(package->'storyboard') IS DISTINCT FROM 'string' OR coalesce(char_length(package->>'storyboard'),0) NOT BETWEEN 1 AND 20000))
  OR (p_editing AND (jsonb_typeof(package->'editing') IS DISTINCT FROM 'string' OR coalesce(char_length(package->>'editing'),0) NOT BETWEEN 1 AND 20000))
  THEN RAISE EXCEPTION 'OPC_CONTENT_RESPONSE_INVALID';END IF;
 IF p_storyboard THEN
  SELECT coalesce(max(version),0) INTO n FROM opc_content_versions WHERE work_item_id=p_work_item_id AND kind='storyboard';IF n<>p_expected_storyboard_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
  INSERT INTO opc_content_versions(actor_id,work_item_id,kind,version,status,body,source_content_id,turn_actor_id,turn_id,request_id) VALUES(p_actor_id,p_work_item_id,'storyboard',n+1,'final',package->>'storyboard',script.id,p_actor_id,p_turn_id,p_request_id) RETURNING * INTO story;
  result:=result||jsonb_build_object('storyboard',jsonb_build_object('id',story.id,'version',story.version));
 END IF;
 IF p_editing THEN
  SELECT coalesce(max(version),0) INTO n FROM opc_content_versions WHERE work_item_id=p_work_item_id AND kind='editing';IF n<>p_expected_editing_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
  INSERT INTO opc_content_versions(actor_id,work_item_id,kind,version,status,body,source_content_id,turn_actor_id,turn_id,request_id) VALUES(p_actor_id,p_work_item_id,'editing',n+1,'final',package->>'editing',script.id,p_actor_id,p_turn_id,p_request_id) RETURNING * INTO editing_result;
  result:=result||jsonb_build_object('editing',jsonb_build_object('id',editing_result.id,'version',editing_result.version));
 END IF;
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.opc_video_material_prepare(p_actor_id uuid, p_work_item_id uuid, p_request_id uuid, p_source_script_id uuid, p_storyboard boolean, p_editing boolean, p_expected_storyboard_version bigint, p_expected_editing_version bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE i opc_items;s runtime_sessions;script opc_content_versions;source_story opc_content_versions;binding opc_video_material_bindings;m runtime_scope_material;result jsonb;n bigint;material_request uuid:=gen_random_uuid();conflict record;package jsonb;want_story boolean;want_edit boolean;
BEGIN
 -- 0324 archived business guard
 IF true THEN PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('workItemId',p_work_item_id)); END IF;

 PERFORM bill2_actor(p_actor_id);
 -- The all-false form is the terminal action for a material claim whose
 -- Runtime admission is now proven absent. It reuses the existing immutable
 -- request identity and material revocation; no second claim ledger exists.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,107));
 IF NOT coalesce(p_storyboard,false) AND NOT coalesce(p_editing,false) THEN
  SELECT * INTO binding FROM opc_video_material_bindings WHERE actor_id=p_actor_id AND request_id=p_request_id;
  IF binding.request_id IS NULL OR binding.work_item_id<>p_work_item_id OR binding.source_script_id<>p_source_script_id
   OR (binding.expected_storyboard_version IS NOT NULL AND binding.expected_storyboard_version<>p_expected_storyboard_version)
   OR (binding.expected_editing_version IS NOT NULL AND binding.expected_editing_version<>p_expected_editing_version)
   THEN RAISE EXCEPTION 'OPC_CONTENT_PENDING';END IF;
  -- Runtime admission uses the same request-then-session lock order. Once this
  -- lock is held, either an execution already froze this exact material and
  -- the claim stays recoverable, or a later admission observes the revocation.
  PERFORM 1 FROM runtime_sessions WHERE id=binding.session_id AND actor_id=p_actor_id FOR UPDATE;
  SELECT * INTO m FROM runtime_scope_material WHERE session_id=binding.session_id AND revision=binding.material_revision;
  IF m.session_id IS NULL OR EXISTS(
   SELECT 1 FROM runtime_executions e WHERE e.actor_id=p_actor_id AND e.session_id=binding.session_id
    AND e.payload#>>'{scopeMaterial,sessionId}'=binding.session_id::text
    AND e.payload#>>'{scopeMaterial,revision}'=binding.material_revision::text
    AND e.payload#>>'{scopeMaterial,hash}'=m.content_hash
  ) OR EXISTS(SELECT 1 FROM turns t WHERE t.actor_id=p_actor_id AND t.request_id=p_request_id)
  THEN RAISE EXCEPTION 'OPC_CONTENT_PENDING';END IF;
  result:=runtime_material(p_actor_id,binding.session_id,'revoke',NULL,binding.material_revision,NULL);
  RETURN result||jsonb_build_object('abandoned',true);
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_work_item_id::text,119));
 SELECT wi.* INTO i FROM opc_items wi JOIN artifact_projects p ON p.id=wi.work_item_id
  WHERE wi.work_item_id=p_work_item_id AND p.actor_id=p_actor_id AND opc_source_allowed(p_actor_id,wi.source_version_id);
 SELECT * INTO s FROM runtime_sessions WHERE actor_id=p_actor_id AND scope=jsonb_build_object('kind','work_item','projectId',i.account_project_id,'workItemId',i.work_item_id) FOR UPDATE;
 SELECT * INTO script FROM opc_content_versions WHERE id=p_source_script_id AND actor_id=p_actor_id AND work_item_id=p_work_item_id AND kind='script' AND status='final';
 IF i.work_item_id IS NULL OR s.id IS NULL OR script.id IS NULL OR NOT opc_content_allowed(p_actor_id,script.id) THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
 SELECT * INTO binding FROM opc_video_material_bindings WHERE actor_id=p_actor_id AND request_id=p_request_id;
 IF binding.request_id IS NOT NULL THEN
  IF binding.work_item_id<>p_work_item_id OR binding.source_script_id<>p_source_script_id OR binding.session_id<>s.id
   OR (binding.storyboard IS NOT NULL AND binding.storyboard IS DISTINCT FROM p_storyboard)
   OR (binding.editing IS NOT NULL AND binding.editing IS DISTINCT FROM p_editing)
   OR (binding.expected_storyboard_version IS NOT NULL AND binding.expected_storyboard_version<>p_expected_storyboard_version)
   OR (binding.expected_editing_version IS NOT NULL AND binding.expected_editing_version<>p_expected_editing_version)
   THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  SELECT * INTO m FROM runtime_scope_material WHERE session_id=binding.session_id AND revision=binding.material_revision;
  IF m.session_id IS NULL OR m.revoked THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
  RETURN jsonb_build_object('sessionId',m.session_id,'revision',m.revision,'hash',m.content_hash);
 END IF;
 IF opc_item_content_type(p_work_item_id)<>'video' THEN RAISE EXCEPTION 'OPC_VIDEO_TYPE_REQUIRED';END IF;
 -- A new editing-only request must freeze the actual matching storyboard.
 -- The existing binding replay above intentionally retains old paid requests.
 IF p_editing AND NOT p_storyboard THEN
  SELECT * INTO source_story FROM opc_content_versions WHERE actor_id=p_actor_id AND work_item_id=p_work_item_id AND kind='storyboard' AND status='final' AND source_content_id=script.id ORDER BY version DESC LIMIT 1;
  IF source_story.id IS NULL OR NOT opc_content_allowed(p_actor_id,source_story.id) THEN RAISE EXCEPTION 'OPC_STORYBOARD_REQUIRED';END IF;
  IF source_story.version<>p_expected_storyboard_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM opc_content_versions c WHERE c.actor_id=p_actor_id AND c.work_item_id=p_work_item_id AND c.source_content_id=script.id
  AND ((p_storyboard AND c.kind='storyboard') OR (p_editing AND c.kind='editing'))) THEN RAISE EXCEPTION 'OPC_CONTENT_ALREADY_GENERATED';END IF;
 IF p_storyboard THEN SELECT coalesce(max(version),0) INTO n FROM opc_content_versions WHERE work_item_id=p_work_item_id AND kind='storyboard';IF n<>p_expected_storyboard_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;END IF;
 IF p_editing THEN SELECT coalesce(max(version),0) INTO n FROM opc_content_versions WHERE work_item_id=p_work_item_id AND kind='editing';IF n<>p_expected_editing_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;END IF;
 -- A completed and saved binding no longer occupies the global kind/version
 -- slot. Cancelled or structurally invalid terminal output may be retried only
 -- under a new explicit request. Every other overlap is still recoverable and
 -- therefore blocks a second paid dispatch.
 FOR conflict IN
  -- The claimed request ran on the old path or as a turn: a turn that closed any other way than completed retries like a cancelled execution.
  SELECT b.*,coalesce(e.id::text,t.id::text) execution_id,
   coalesce(e.state,CASE WHEN t.close_kind='completed' THEN 'completed' WHEN t.close_kind IS NOT NULL THEN 'cancelled' WHEN t.id IS NOT NULL THEN 'running' END) execution_state,
   coalesce(e.result->>'body',e.primary_result->>'body',
    (SELECT string_agg(sm.content,E'\n\n' ORDER BY sm.seq) FROM session_messages sm WHERE sm.session_id=t.session_id AND sm.turn_id=t.id AND sm.role='assistant' AND sm.visible)) raw,
   material_row.revoked material_revoked
  FROM opc_video_material_bindings b
  LEFT JOIN runtime_executions e ON e.actor_id=b.actor_id AND e.request_id=b.request_id
  LEFT JOIN turns t ON t.actor_id=b.actor_id AND t.request_id=b.request_id
  LEFT JOIN runtime_scope_material material_row ON material_row.session_id=b.session_id AND material_row.revision=b.material_revision
  WHERE b.actor_id=p_actor_id AND b.work_item_id=p_work_item_id AND b.request_id<>p_request_id
   AND ((p_storyboard AND coalesce(b.storyboard,true)) OR (p_editing AND coalesce(b.editing,true)))
 LOOP
  IF coalesce(conflict.material_revoked,false) THEN CONTINUE;END IF;
  package:=NULL;
  IF conflict.execution_state='completed' THEN BEGIN package:=conflict.raw::jsonb;EXCEPTION WHEN others THEN package:=NULL;END;END IF;
  -- 0118 rows predate explicit choice columns. Infer only a structurally valid
  -- completed package; an unknown/nonterminal legacy row remains conservative.
  want_story:=coalesce(conflict.storyboard,true);want_edit:=coalesce(conflict.editing,true);
  IF conflict.storyboard IS NULL AND conflict.editing IS NULL THEN
   want_story:=jsonb_typeof(package)='object' AND package-ARRAY['storyboard']='{}'::jsonb
    AND jsonb_typeof(package->'storyboard')='string' AND char_length(package->>'storyboard') BETWEEN 1 AND 20000;
   want_edit:=jsonb_typeof(package)='object' AND package-ARRAY['editing']='{}'::jsonb
    AND jsonb_typeof(package->'editing')='string' AND char_length(package->>'editing') BETWEEN 1 AND 20000;
   IF jsonb_typeof(package)='object' AND package-ARRAY['storyboard','editing']='{}'::jsonb
    AND jsonb_typeof(package->'storyboard')='string' AND char_length(package->>'storyboard') BETWEEN 1 AND 20000
    AND jsonb_typeof(package->'editing')='string' AND char_length(package->>'editing') BETWEEN 1 AND 20000
   THEN want_story:=true;want_edit:=true;END IF;
   IF NOT want_story AND NOT want_edit THEN want_story:=true;want_edit:=true;END IF;
  END IF;
  -- A recovered legacy single-kind request releases only the kind proven by
  -- its exact terminal package and saved artifact. It must not reserve both
  -- kinds forever or block the same kind for a newly finalized script.
  IF (NOT want_story OR EXISTS(SELECT 1 FROM opc_content_versions c WHERE c.actor_id=conflict.actor_id AND c.request_id=conflict.request_id AND c.kind='storyboard' AND c.source_content_id=conflict.source_script_id))
   AND (NOT want_edit OR EXISTS(SELECT 1 FROM opc_content_versions c WHERE c.actor_id=conflict.actor_id AND c.request_id=conflict.request_id AND c.kind='editing' AND c.source_content_id=conflict.source_script_id))
  THEN CONTINUE;END IF;
  IF NOT ((p_storyboard AND want_story) OR (p_editing AND want_edit)) THEN CONTINUE;END IF;
  IF conflict.execution_id IS NULL OR conflict.execution_state NOT IN ('cancelled','completed') THEN RAISE EXCEPTION 'OPC_CONTENT_ALREADY_GENERATED';END IF;
  IF conflict.execution_state='cancelled' THEN CONTINUE;END IF;
  IF jsonb_typeof(package)='object'
   AND ((want_story AND want_edit AND package-ARRAY['storyboard','editing']='{}'::jsonb)
    OR (want_story AND NOT want_edit AND package-ARRAY['storyboard']='{}'::jsonb)
    OR (want_edit AND NOT want_story AND package-ARRAY['editing']='{}'::jsonb))
   AND (NOT want_story OR (jsonb_typeof(package->'storyboard')='string' AND char_length(package->>'storyboard') BETWEEN 1 AND 20000))
   AND (NOT want_edit OR (jsonb_typeof(package->'editing')='string' AND char_length(package->>'editing') BETWEEN 1 AND 20000))
   THEN RAISE EXCEPTION 'OPC_CONTENT_ALREADY_GENERATED';END IF;
 END LOOP;
 SELECT coalesce(max(revision),0) INTO n FROM runtime_scope_material WHERE session_id=s.id;
 result:=runtime_material(p_actor_id,s.id,'save',material_request,n,jsonb_build_object('brief','已定稿口播稿：'||script.body,'material',CASE WHEN source_story.id IS NULL THEN coalesce(opc_profile(i.source_version_id)::text,'') ELSE jsonb_build_object('positioning',opc_profile(i.source_version_id),'sourceStoryboardId',source_story.id,'storyboardVersion',source_story.version,'storyboard',source_story.body)::text END,'roundId',NULL));
 INSERT INTO opc_video_material_bindings(actor_id,request_id,work_item_id,source_script_id,session_id,material_revision,storyboard,editing,expected_storyboard_version,expected_editing_version)
  VALUES(p_actor_id,p_request_id,p_work_item_id,p_source_script_id,s.id,(result->>'revision')::bigint,p_storyboard,p_editing,p_expected_storyboard_version,p_expected_editing_version);
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.content_erasure_scope(a uuid, k text, target uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- R9 erasure preview

DECLARE sessions uuid[]:='{}'; executions uuid[]:='{}'; projects uuid[]:='{}'; versions uuid[]:='{}';
 content_ids uuid[]:='{}'; refs uuid[]:='{}'; turn_ids bigint[]:='{}';
 root_e runtime_executions;root_s runtime_sessions;root_p artifact_projects;root_c opc_content_versions;
 deleted boolean:=false;more uuid[];n integer;preserved bigint;dependents jsonb;
BEGIN
 IF a IS NULL OR target IS NULL THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
 IF k='answer' THEN
  SELECT * INTO root_e FROM runtime_executions WHERE id=target AND actor_id=a;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
  executions:=ARRAY[root_e.id];deleted:=root_e.content_deleted_at IS NOT NULL OR root_e.erased_at IS NOT NULL;
 ELSIF k='session' THEN
  SELECT * INTO root_s FROM runtime_sessions WHERE id=target AND actor_id=a;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
  sessions:=ARRAY[root_s.id];deleted:=root_s.content_deleted_at IS NOT NULL OR root_s.erased_at IS NOT NULL;
 ELSIF k='artifact' THEN
  SELECT * INTO root_p FROM artifact_projects WHERE id=target AND actor_id=a;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
  projects:=ARRAY[root_p.id];deleted:=root_p.content_deleted_at IS NOT NULL OR root_p.erased_at IS NOT NULL;
  -- Account-specific strategy drafts are private copies in separate projects.
  projects:=projects||ARRAY(SELECT d.project_id FROM opc_account_strategy_drafts b
   JOIN opc_drafts d ON d.draft_id=b.draft_id JOIN artifact_projects p ON p.id=d.project_id
   WHERE b.account_project_id=root_p.id AND b.actor_id=a AND d.actor_id=a AND p.actor_id=a);
  versions:=ARRAY(SELECT id FROM artifact_versions WHERE project_id=ANY(projects) ORDER BY id);
  content_ids:=ARRAY(SELECT id FROM opc_content_versions WHERE actor_id=a AND work_item_id=ANY(projects) ORDER BY id);
 ELSIF k='content' THEN
  SELECT * INTO root_c FROM opc_content_versions WHERE id=target AND actor_id=a;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
  content_ids:=ARRAY(SELECT id FROM opc_content_versions WHERE actor_id=a AND work_item_id=root_c.work_item_id AND kind=root_c.kind);
  deleted:=NOT EXISTS(SELECT 1 FROM opc_content_versions WHERE id=ANY(content_ids) AND erased_at IS NULL);
 ELSE RAISE EXCEPTION 'CONTENT_TARGET_INVALID' USING ERRCODE='22023'; END IF;
 -- The original producing execution predates the saved content UUID. Follow its
 -- persisted identity for the selected family only, not independent descendants.
 executions:=executions||ARRAY(SELECT execution_id FROM opc_content_versions
  WHERE actor_id=a AND id=ANY(content_ids) AND execution_id IS NOT NULL);
 -- Independent saved descendants stay intact, while their copied source contexts are invalidated.
 WITH RECURSIVE descendants(id) AS (
  SELECT id FROM opc_content_versions WHERE id=ANY(content_ids)
  UNION SELECT c.id FROM opc_content_versions c JOIN descendants d ON c.source_content_id=d.id WHERE c.actor_id=a
 ) SELECT coalesce(array_agg(id ORDER BY id),'{}') INTO refs FROM descendants;
 refs:=refs||executions||sessions||projects||versions||content_ids||
  ARRAY(SELECT id FROM artifact_evidence WHERE project_id=ANY(projects))||
  ARRAY(SELECT operation_id FROM artifact_evidence WHERE project_id=ANY(projects) AND operation_id IS NOT NULL)||
  ARRAY(SELECT draft_id FROM opc_drafts WHERE actor_id=a AND project_id=ANY(projects))||
  ARRAY(SELECT conversation_id FROM artifact_chats WHERE project_id=ANY(projects))||
  ARRAY(SELECT work_item_id FROM opc_items WHERE source_version_id=ANY(versions))||
  ARRAY(SELECT session_id FROM opc_topic_workspaces WHERE actor_id=a AND source_version_id=ANY(versions))||ARRAY(SELECT id FROM artifact_rounds WHERE project_id=ANY(projects));
 executions:=ARRAY(SELECT DISTINCT ex.id FROM runtime_executions ex WHERE ex.actor_id=a AND
  (ex.id=ANY(executions) OR ex.session_id=ANY(sessions) OR content_erasure_references(ex.payload,refs)
   -- A2 injected source
   OR content_erasure_references(ex.injected_source,refs)
   OR EXISTS(SELECT 1 FROM runtime_sessions rs WHERE rs.id=ex.session_id AND content_erasure_references(rs.scope,refs))
   -- 0218 workspace tool copies
   OR EXISTS(SELECT 1 FROM runtime_tool_calls tc WHERE tc.execution_id=ex.id AND tc.name IN ('read_source','read_history') AND content_erasure_references(tc.result,refs))
   -- 0228 read_history copies
   OR EXISTS(SELECT 1 FROM opc_video_material_bindings b WHERE b.actor_id=a AND b.source_script_id=ANY(refs)
    AND b.session_id=ex.session_id AND b.request_id=ex.request_id)
   -- ERASE-SPEED material key: read once per execution (OFFSET 0 keeps it from being re-read per material row).
   OR EXISTS(SELECT 1 FROM (SELECT ex.payload#>>'{scopeMaterial,sessionId}' sid,ex.payload#>>'{scopeMaterial,revision}' rev
     OFFSET 0) k
    JOIN runtime_scope_material mat ON mat.session_id=CASE WHEN k.sid ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     THEN k.sid::uuid END AND mat.session_id::text=k.sid AND mat.revision::text=k.rev WHERE
    (mat.request_id=ANY(refs) OR content_erasure_references(mat.request,refs) OR content_erasure_references(mat.content,refs)
     OR EXISTS(SELECT 1 FROM opc_video_material_bindings b WHERE b.actor_id=a AND b.session_id=mat.session_id
      AND b.material_revision=mat.revision AND b.source_script_id=ANY(refs)))
    )));
 -- Exact dependency closure; UNION bounds malformed cycles.
 LOOP
  n:=cardinality(executions);
  more:=ARRAY(SELECT DISTINCT ex.id FROM runtime_executions ex WHERE ex.actor_id=a AND
   (EXISTS(SELECT 1 FROM runtime_history_dependencies d WHERE d.execution_id=ex.id AND d.dependency_id=ANY(executions))
    OR content_erasure_references(ex.payload,executions)
    OR EXISTS(SELECT 1 FROM runtime_executions src WHERE src.id=ANY(executions)
     AND src.actor_id=a AND src.session_id=ex.session_id AND (src.created_at,src.id)<(ex.created_at,ex.id)
     AND content_erasure_capture_copy(ex.payload,src.result))));
  executions:=ARRAY(SELECT DISTINCT x FROM unnest(executions||more) x ORDER BY x);
  EXIT WHEN cardinality(executions)=n;
 END LOOP;
 -- CORE-PATH-V2 V2-10b C2: the turns of the same dependency, by what a turn can hold: the producing turn of a selected version, the
 -- turn given a script as material or as source, and every turn of a conversation in scope.
 turn_ids:=ARRAY(SELECT t.id FROM turns t WHERE t.actor_id=a AND (t.session_id=ANY(sessions)
   OR t.id IN (SELECT c.turn_id FROM opc_content_versions c WHERE c.actor_id=a AND c.id=ANY(content_ids) AND c.turn_id IS NOT NULL)
   OR t.request_id IN (SELECT b.request_id FROM opc_video_material_bindings b WHERE b.actor_id=a AND b.source_script_id=ANY(refs))
   OR t.policy#>>'{workSource,contentId}'=ANY(refs::text[])
   OR t.session_id IN (SELECT rs.id FROM runtime_sessions rs WHERE rs.actor_id=a AND content_erasure_references(rs.scope,refs)))
  ORDER BY t.id);
 SELECT count(*) INTO preserved FROM opc_content_versions c0 WHERE c0.actor_id=a AND c0.erased_at IS NULL
  AND NOT c0.id=ANY(content_ids) AND (c0.execution_id=ANY(executions) OR c0.turn_id=ANY(turn_ids) OR c0.source_content_id=ANY(content_ids));
 preserved:=preserved+(SELECT count(*) FROM artifact_versions v WHERE NOT v.project_id=ANY(projects)
  AND EXISTS(SELECT 1 FROM artifact_projects p0 WHERE p0.id=v.project_id AND p0.actor_id=a)
  AND (EXISTS(SELECT 1 FROM artifact_work_references r WHERE r.project_id=v.project_id AND r.source_version_id=ANY(versions))
   OR EXISTS(SELECT 1 FROM opc_result_links l WHERE l.round_id=v.round_id AND l.execution_id=ANY(executions))
   -- CORE-PATH-V2 V2-7a2: the same for a report finalized from a turn of these conversations.
   OR EXISTS(SELECT 1 FROM opc_result_links l JOIN turns t ON t.actor_id=l.turn_actor_id AND t.id=l.turn_id
    WHERE l.round_id=v.round_id AND t.actor_id=a AND t.session_id=ANY(sessions))));
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'id',id) ORDER BY kind,id),'[]') INTO dependents FROM (
  SELECT 'account' kind,p.project_id id FROM opc_accounts p WHERE p.actor_id=a AND p.source_version_id=ANY(versions)
  UNION SELECT 'work_item',i.work_item_id FROM opc_items i JOIN artifact_projects p ON p.id=i.work_item_id
   WHERE p.actor_id=a AND i.source_version_id=ANY(versions)
  UNION SELECT 'reference',r.project_id FROM artifact_work_references r JOIN artifact_projects p ON p.id=r.project_id
   WHERE p.actor_id=a AND r.source_version_id=ANY(versions)
  UNION SELECT 'content',c.id FROM opc_content_versions c WHERE c.actor_id=a AND NOT c.id=ANY(content_ids)
   AND (c.execution_id=ANY(executions) OR c.turn_id=ANY(turn_ids) OR c.id=ANY(refs))
 ) affected;
 -- Canonical sets make the preview hash independent of query plans and physical row order.
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO sessions FROM unnest(sessions) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO executions FROM unnest(executions) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO projects FROM unnest(projects) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO versions FROM unnest(versions) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO content_ids FROM unnest(content_ids) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO refs FROM unnest(refs) id WHERE id IS NOT NULL;
 RETURN jsonb_build_object('kind',k,'id',target,'alreadyDeleted',deleted,
  'sessions',to_jsonb(sessions),'executions',to_jsonb(executions),'turns',to_jsonb(turn_ids),'projects',to_jsonb(projects),
  'versions',to_jsonb(versions),'contents',to_jsonb(content_ids),'references',to_jsonb(refs),
  'affectedSources',dependents,'preservedSavedVersions',preserved,
  'dataEvents',coalesce((SELECT jsonb_agg(jsonb_build_array(request_id,item_key,created_at) ORDER BY request_id,item_key)
   FROM opc_data_events WHERE actor_id=a AND (execution_id=ANY(executions) OR project_id=ANY(projects)
    OR turn_id IN (SELECT t.id FROM turns t WHERE t.actor_id=a AND t.session_id=ANY(sessions))
    OR target_project_id=ANY(projects) OR source_version_id=ANY(versions))),'[]'::jsonb));
END $function$;

CREATE OR REPLACE FUNCTION public.content_erasure_mark_session(a uuid, target uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions; deleted boolean; scope jsonb; ids uuid[]; refs uuid[]; local boolean; stamp timestamptz; unbound boolean;
BEGIN
 PERFORM bill2_actor(a);
 -- Same order as content_erasure_confirm (profile, then session). A short wait instead of
 -- NOWAIT lets a reply commit that holds this session for a moment finish first.
 PERFORM set_config('lock_timeout','2000',true);
 PERFORM id FROM profiles WHERE id=a FOR SHARE;
 PERFORM bill2_actor(a);
 SELECT * INTO s FROM runtime_sessions WHERE id=target AND actor_id=a FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
 deleted:=s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL;
 IF deleted THEN
  RETURN jsonb_build_object('kind','session','id',target,'status','deleted','alreadyDeleted',true,
   'preservedSavedVersions',0,'financialReviewCount',0);
 END IF;
 -- Writers that copy a result out of this conversation (saving a work result, capture, history
 -- dependencies) lock its execution rows first and then check availability, so taking the same
 -- rows here serializes them with the marker: a copy committed first is visible to the checks
 -- below and cleaned now; a writer that waits sees the committed marker and is refused.
 PERFORM id FROM runtime_executions WHERE session_id=target AND actor_id=a ORDER BY id FOR UPDATE;
 -- Read-only scope (no account-wide locks). The marker alone is enough only when nothing outside
 -- this conversation holds a copy: a free conversation (no work, draft or topic binding), every scoped
 -- execution in it, no saved content, work, data event, result link, captured field, library
 -- request or other conversation's frozen material referencing it. Anything else, or any doubt,
 -- runs the full cleanup now so no derived copy stays readable after this call returns.
 -- ERASE-SPEED bound first: a conversation bound to a draft or a topic workspace (the same two conditions as
 -- below) is never cleaned by the marker alone; only for it is the scope not computed here.
 unbound:=NOT EXISTS(SELECT 1 FROM opc_drafts d WHERE d.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM opc_topic_workspaces t WHERE t.session_id=target);
 IF unbound THEN
  scope:=content_erasure_scope(a,'session',target);
  SELECT coalesce(array_agg(v::uuid),'{}') INTO ids FROM jsonb_array_elements_text(scope->'executions') v;
  refs:=ids||target;
 END IF;
 local:=unbound AND s.scope->>'kind'='positioning_draft' AND s.scope->>'workItemId' IS NULL
  AND NOT EXISTS(SELECT 1 FROM opc_drafts d WHERE d.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM opc_topic_workspaces t WHERE t.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM runtime_executions e WHERE e.id=ANY(ids) AND e.session_id<>target)
  AND NOT EXISTS(SELECT 1 FROM fusion_billing_groups fg WHERE fg.source_session_id=target)
  AND NOT EXISTS(SELECT 1 FROM fusion_compares fcmp WHERE fcmp.session_id=target)
  AND jsonb_array_length(scope->'projects')=0 AND jsonb_array_length(scope->'versions')=0
  AND jsonb_array_length(scope->'contents')=0 AND jsonb_array_length(scope->'affectedSources')=0
  AND NOT EXISTS(SELECT 1 FROM opc_content_versions c WHERE c.actor_id=a AND c.execution_id=ANY(ids))
  AND NOT EXISTS(SELECT 1 FROM opc_content_versions c JOIN turns t ON t.actor_id=c.turn_actor_id AND t.id=c.turn_id WHERE t.actor_id=a AND t.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM opc_data_events d WHERE d.actor_id=a AND d.execution_id=ANY(ids))
  AND NOT EXISTS(SELECT 1 FROM opc_data_events d JOIN turns t ON t.actor_id=d.turn_actor_id AND t.id=d.turn_id WHERE t.actor_id=a AND t.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM opc_result_links l WHERE l.execution_id=ANY(ids))
  AND NOT EXISTS(SELECT 1 FROM opc_result_links l JOIN turns t ON t.actor_id=l.turn_actor_id AND t.id=l.turn_id WHERE t.actor_id=a AND t.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM artifact_rounds r JOIN artifact_projects p ON p.id=r.project_id
   WHERE p.actor_id=a AND r.erased_at IS NULL AND content_erasure_references(r.steps,refs))
  AND NOT EXISTS(SELECT 1 FROM opc_library_requests q WHERE q.actor_id=a AND q.erased_at IS NULL
   AND (content_erasure_references(q.payload,refs) OR content_erasure_references(q.result,refs)))
  AND NOT EXISTS(SELECT 1 FROM runtime_scope_material m JOIN runtime_sessions o ON o.id=m.session_id
   WHERE o.actor_id=a AND m.session_id<>target AND m.erased_at IS NULL
    AND (content_erasure_references(m.request,refs) OR content_erasure_references(m.content,refs)));
 UPDATE runtime_sessions SET content_deleted_at=clock_timestamp() WHERE id=target RETURNING content_deleted_at INTO stamp;
 -- CORE-PATH-V2: the conversation's messages leave the visible history now (one indexed update, still under the session
 -- lock turn_close appends under); their text is cleared with the rest of the conversation by content_erasure_confirm.
 UPDATE session_messages SET visible=false,deleted_at=stamp WHERE session_id=target AND (visible OR deleted_at IS NULL);
 -- Off-database erasure manifest (0227): recorded at the marker's time, in the same transaction;
 -- the later cleanup's own note keeps this first time.
 PERFORM erasure_manifest_note('session',target,a,stamp);
 IF NOT local THEN
  -- Same transaction: the marked-session cleanup locks only rows in scope. If it is busy the
  -- marker rolls back with it and the caller reports the conversation as not deleted.
  RETURN content_erasure_confirm(a,'session',target,NULL)||jsonb_build_object('alreadyDeleted',false);
 END IF;
 -- Content is unreadable from here on. Money facts stay on their original runs; the
 -- background cleanup reports any financial review.
 RETURN jsonb_build_object('kind','session','id',target,'status','deleted','alreadyDeleted',false,
  'preservedSavedVersions',0,'financialReviewCount',0);
EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
 RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
END $function$;

CREATE OR REPLACE FUNCTION public.content_erasure_confirm(a uuid, k text, target uuid, expected_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- 0338 conversation results erasure

-- 0232 conversation name erasure

-- R9 erasure content

DECLARE scope jsonb; turn_ids bigint[]; ids uuid[]; sessions uuid[]; projects uuid[]; versions uuid[]; contents uuid[];
 refs uuid[]; rounds uuid[]; chats uuid[]; research_ids uuid[]; research_plan_ids uuid[]; stamp timestamptz:=clock_timestamp(); row record; financial jsonb;
 remaining bigint:=0; deleted boolean; deleted_runs text[]; deleted_pre text[]; linked uuid[];
BEGIN
 PERFORM bill2_actor(a);
 -- Runtime writers use session -> execution -> run. NOWAIT prevents inverse
 -- legacy/project lock orders from turning erasure into a cross-domain deadlock.
 PERFORM id FROM profiles WHERE id=a FOR SHARE NOWAIT;
 PERFORM bill2_actor(a);
 -- 0231 marked session locks
 IF k='session' AND EXISTS(SELECT 1 FROM runtime_sessions WHERE id=target AND actor_id=a AND content_deleted_at IS NOT NULL) THEN
  scope:=content_erasure_scope(a,k,target);
  SELECT coalesce(array_agg(v::uuid),'{}') INTO ids FROM jsonb_array_elements_text(scope->'executions') v;
  SELECT coalesce(array_agg(v::uuid),'{}') INTO sessions FROM jsonb_array_elements_text(scope->'sessions') v;
  rounds:=ARRAY(SELECT DISTINCT s0.id FROM runtime_sessions s0 WHERE s0.actor_id=a
   AND (s0.id=ANY(sessions) OR s0.id IN (SELECT e0.session_id FROM runtime_executions e0 WHERE e0.id=ANY(ids))) ORDER BY s0.id);
  PERFORM id FROM runtime_sessions WHERE id=ANY(rounds) ORDER BY id FOR UPDATE NOWAIT;
  -- Works these conversations feed (draft, topic workspace or captured field): capture locks the
  -- project before writing, so holding it here serializes capture with this cleanup.
  PERFORM id FROM artifact_projects WHERE actor_id=a AND (id IN (SELECT d0.project_id FROM opc_drafts d0 WHERE d0.session_id=ANY(rounds))
   OR id IN (SELECT d1.project_id FROM opc_topic_workspaces t1 JOIN opc_drafts d1 ON d1.draft_id=t1.draft_id WHERE t1.session_id=ANY(rounds))
   OR id IN (SELECT r0.project_id FROM artifact_rounds r0 JOIN artifact_projects p0 ON p0.id=r0.project_id
    WHERE p0.actor_id=a AND content_erasure_references(r0.steps,ids))) ORDER BY id FOR UPDATE NOWAIT;
  scope:=content_erasure_scope(a,k,target);
  SELECT coalesce(array_agg(v::uuid),'{}') INTO ids FROM jsonb_array_elements_text(scope->'executions') v;
  SELECT coalesce(array_agg(v::uuid),'{}') INTO sessions FROM jsonb_array_elements_text(scope->'sessions') v;
  IF NOT sessions<@rounds OR jsonb_array_length(scope->'projects')>0
   OR EXISTS(SELECT 1 FROM runtime_executions e0 WHERE e0.id=ANY(ids) AND NOT e0.session_id=ANY(rounds)) THEN
   RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
  END IF;
 ELSE
  PERFORM id FROM runtime_sessions WHERE actor_id=a ORDER BY id FOR UPDATE NOWAIT;
  PERFORM id FROM artifact_projects WHERE actor_id=a ORDER BY id FOR UPDATE NOWAIT;
  scope:=content_erasure_scope(a,k,target);
 END IF;
 deleted:=(scope->>'alreadyDeleted')::boolean;
 -- 0227 erasure manifest
 PERFORM erasure_manifest_note(k,target,a,stamp);
 IF NOT deleted AND expected_hash IS DISTINCT FROM encode(sha256(convert_to(scope::text,'utf8')),'hex') THEN
  RAISE EXCEPTION 'CONTENT_ERASURE_PREVIEW_CHANGED' USING ERRCODE='40001';
 END IF;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO ids FROM jsonb_array_elements_text(scope->'executions') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO sessions FROM jsonb_array_elements_text(scope->'sessions') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO projects FROM jsonb_array_elements_text(scope->'projects') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO versions FROM jsonb_array_elements_text(scope->'versions') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO contents FROM jsonb_array_elements_text(scope->'contents') v;
 SELECT coalesce(array_agg(v::bigint),'{}') INTO turn_ids FROM jsonb_array_elements_text(scope->'turns') v;
 -- Existing UI writers lock their item/account before updating private settings.
 PERFORM work_item_id FROM opc_items WHERE work_item_id=ANY(projects) ORDER BY work_item_id FOR UPDATE NOWAIT;
 PERFORM project_id FROM opc_accounts WHERE project_id=ANY(projects) ORDER BY project_id FOR UPDATE NOWAIT;
 PERFORM work_item_id FROM opc_work_ui WHERE actor_id=a AND work_item_id=ANY(projects) ORDER BY work_item_id FOR UPDATE NOWAIT;
 PERFORM account_project_id FROM opc_account_ui WHERE actor_id=a AND account_project_id=ANY(projects) ORDER BY account_project_id FOR UPDATE NOWAIT;
 PERFORM work_item_id FROM opc_publication_ui WHERE actor_id=a AND work_item_id=ANY(projects) ORDER BY work_item_id FOR UPDATE NOWAIT;
 rounds:=ARRAY(SELECT id FROM artifact_rounds WHERE project_id=ANY(projects));
 chats:=ARRAY(SELECT c.conversation_id FROM artifact_chats c JOIN conversations v ON v.id=c.conversation_id
  WHERE c.project_id=ANY(projects) AND v.user_id=a);
 PERFORM id FROM conversations WHERE id=ANY(chats) ORDER BY id FOR UPDATE NOWAIT;
 -- CORE-PATH-V2 V2-7a2: evidence linked to these runs, or to a turn of these conversations.
 linked:=ARRAY(SELECT evidence_id FROM opc_result_links WHERE execution_id=ANY(ids))
  ||ARRAY(SELECT l.evidence_id FROM opc_result_links l JOIN turns t ON t.actor_id=l.turn_actor_id AND t.id=l.turn_id WHERE t.actor_id=a AND t.session_id=ANY(sessions));
 research_ids:=ARRAY(SELECT DISTINCT o.id FROM research_operations o JOIN research_plans p ON p.id=o.plan_id
  JOIN artifact_evidence e ON e.operation_id=o.id WHERE p.actor_id=a AND
   (e.project_id=ANY(projects) OR e.id=ANY(linked)));
 -- 0263 runtime research: conversation searches have no artifact evidence.
 research_plan_ids:=ARRAY(SELECT p.id FROM research_plans p WHERE p.actor_id=a AND (p.session_id=ANY(sessions) OR p.execution_id=ANY(ids) OR p.discovery_id IN (
   SELECT d.id FROM research_discoveries d JOIN research_selection_cards c ON c.confirmation_id=d.keyword_confirmation_id
   WHERE c.actor_id=a AND (c.session_id=ANY(sessions) OR c.execution_id=ANY(ids)))));
 research_ids:=research_ids||ARRAY(SELECT o.id FROM research_operations o
  WHERE o.plan_id=ANY(research_plan_ids) AND NOT o.id=ANY(research_ids));
 research_plan_ids:=research_plan_ids||ARRAY(SELECT DISTINCT plan_id FROM research_operations WHERE id=ANY(research_ids));

 -- Research RPCs serialize on the plan. NOWAIT avoids their plan -> project lock inversion.
 PERFORM id FROM research_plans WHERE id=ANY(research_plan_ids) ORDER BY id FOR UPDATE NOWAIT;
 PERFORM id FROM research_operations WHERE id=ANY(research_ids) ORDER BY id FOR UPDATE NOWAIT;
 IF EXISTS(SELECT 1 FROM research_operations WHERE id=ANY(research_ids) AND erased_at IS NULL AND
   (NOT research_operation_settled(research_operations) OR (pre_deduct_id IS NOT NULL AND charged_credits IS NULL))) THEN
  RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
 END IF;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO refs FROM jsonb_array_elements_text(scope->'references') v;
 refs:=refs||ids||sessions||projects||versions||contents||rounds;
 -- CORE-PATH-V2 V2-7a2: a report turn's request id is its executionId in the edit and publish requests, which hold the edited text.
 refs:=refs||ARRAY(SELECT request_id FROM turns WHERE actor_id=a AND session_id=ANY(sessions) AND kind='report');
 -- CORE-PATH-V2 V2-10b: a topic turn's request id is its executionId in the topic drafts and the adoption requests.
 refs:=refs||ARRAY(SELECT t.request_id FROM turns t JOIN opc_topic_workspaces w ON w.session_id=t.session_id AND w.actor_id=a
  WHERE t.actor_id=a AND t.session_id=ANY(sessions) AND t.kind='chat');
 PERFORM id FROM runtime_executions WHERE id=ANY(ids) ORDER BY id FOR UPDATE NOWAIT;
 PERFORM id FROM bill2_runs WHERE id IN (SELECT billing_run_id FROM runtime_executions WHERE id=ANY(ids))
  ORDER BY id FOR UPDATE NOWAIT;
 -- CORE-PATH-V2 turns: after the account row and their sessions, the order turn_close takes them. A receipt holding one either committed its
 -- response body before this (removed below) or runs after and sees the tombstone (turn_call_record stores no body then).
 PERFORM 1 FROM turns WHERE actor_id=a AND session_id=ANY(sessions) ORDER BY id FOR UPDATE NOWAIT;
 IF EXISTS(SELECT 1 FROM artifact_generations g WHERE g.state NOT IN ('succeeded','refunded')
  AND (g.project_id=ANY(projects) OR content_erasure_references(g.input,refs))) THEN
  RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
 END IF;
 -- Keep only source IDs in the existing dependency graph before clearing copies.
 -- Repeated deletion/financial cleanup must find the same original dependent runs.
 INSERT INTO runtime_history_dependencies(execution_id,dependency_id)
 SELECT ex.id,src.id FROM runtime_executions ex JOIN runtime_executions src ON src.session_id=ex.session_id
 WHERE ex.id=ANY(ids) AND src.id=ANY(ids) AND ex.actor_id=a AND src.actor_id=a
  AND (src.created_at,src.id)<(ex.created_at,ex.id) AND content_erasure_capture_copy(ex.payload,src.result)
 ON CONFLICT DO NOTHING;
 -- Retain only binding identities for later cleanup/recovery after frozen material is gone.
 INSERT INTO runtime_history_dependencies(execution_id,dependency_id)
 SELECT ex.id,src.id FROM opc_video_material_bindings b JOIN runtime_executions src
  ON src.actor_id=b.actor_id AND src.session_id=b.session_id AND src.request_id=b.request_id
 JOIN runtime_executions ex ON ex.actor_id=b.actor_id AND ex.session_id=b.session_id AND ex.id<>src.id
 WHERE b.actor_id=a AND src.id=ANY(ids) AND ex.id=ANY(ids)
  AND ex.payload#>>'{scopeMaterial,sessionId}'=b.session_id::text
  AND ex.payload#>>'{scopeMaterial,revision}'=b.material_revision::text
 ON CONFLICT DO NOTHING;
 -- 0295 report price
 PERFORM report_fee_settle_internal(held_fee.execution_id,false) FROM report_fees held_fee JOIN runtime_executions fe ON fe.id=held_fee.execution_id
  WHERE held_fee.actor_id=a AND held_fee.state='held' AND (fe.id=ANY(ids) OR fe.session_id=ANY(sessions));
 PERFORM report_fee_settle_internal(held_fee.execution_id,true) FROM report_fees held_fee JOIN runtime_executions fe ON fe.id=held_fee.execution_id
  WHERE held_fee.actor_id=a AND held_fee.state='held' AND (fe.id=ANY(ids) OR fe.session_id=ANY(sessions));
 UPDATE runtime_sessions SET content_deleted_at=stamp WHERE id=ANY(sessions) AND content_deleted_at IS NULL;
 UPDATE artifact_projects SET content_deleted_at=stamp WHERE id=ANY(projects) AND content_deleted_at IS NULL;
 UPDATE bill2_runs SET content_deleted_at=stamp WHERE actor_id=a AND content_deleted_at IS NULL
  AND id IN (SELECT billing_run_id FROM runtime_executions WHERE id=ANY(ids));
 -- Preserve original delivery/unknown facts before clearing the execution body.
 -- No adapter, redispatch, new request ID or fabricated provider failure exists here.
 FOR row IN SELECT id,billing_run_id FROM runtime_executions WHERE id=ANY(ids) ORDER BY id LOOP
  IF row.billing_run_id IS NOT NULL THEN
   financial:=runtime_financial_recovery(a,row.id,true);
   PERFORM account_erasure_scrub_calls(a,row.billing_run_id);
   PERFORM account_erasure_scrub_run(a,row.billing_run_id);
   financial:=account_erasure_scrub_receipts(a,row.billing_run_id,100);
   remaining:=remaining+coalesce((financial->>'remaining')::bigint,0);
  END IF;
 END LOOP;
 -- 0290 fusion compares
 PERFORM fc.id FROM fusion_compares fc WHERE fc.actor_id=a AND (fc.session_id=ANY(sessions)
  OR fc.session_id IN (SELECT d.session_id FROM opc_drafts d WHERE d.actor_id=a AND d.project_id=ANY(projects))
  OR content_erasure_references(fc.workspace_dependencies,refs)) ORDER BY fc.id FOR UPDATE NOWAIT;
 PERFORM r.id FROM bill2_runs r JOIN fusion_compares fc ON fc.group_id=r.fusion_group_id
  WHERE fc.actor_id=a AND content_erasure_references(fc.workspace_dependencies,refs) ORDER BY r.id FOR UPDATE OF r NOWAIT;
 FOR row IN SELECT r.id,r.closed FROM bill2_runs r JOIN fusion_compares fc ON fc.group_id=r.fusion_group_id
  WHERE fc.actor_id=a AND content_erasure_references(fc.workspace_dependencies,refs) ORDER BY r.id LOOP
  UPDATE bill2_runs SET content_deleted_at=stamp WHERE id=row.id AND content_deleted_at IS NULL;
  IF NOT row.closed THEN PERFORM bill2_cancel(a,row.id); END IF;
  PERFORM bill2_finalize(a,row.id);
  financial:=account_erasure_scrub_calls(a,row.id);
  remaining:=remaining+coalesce((financial->>'remaining')::bigint,0);
  financial:=account_erasure_scrub_run(a,row.id);
  remaining:=remaining+coalesce((financial->>'remaining')::bigint,0);
  financial:=account_erasure_scrub_receipts(a,row.id,100);
  remaining:=remaining+coalesce((financial->>'remaining')::bigint,0);
 END LOOP;
 DELETE FROM fusion_call_outputs o USING fusion_compares fc
  WHERE o.group_id=fc.group_id AND fc.actor_id=a AND content_erasure_references(fc.workspace_dependencies,refs);
 DELETE FROM fusion_compares fc WHERE fc.actor_id=a AND (fc.session_id=ANY(sessions)
  OR fc.session_id IN (SELECT d.session_id FROM opc_drafts d WHERE d.actor_id=a AND d.project_id=ANY(projects))
  OR content_erasure_references(fc.workspace_dependencies,refs));
 -- 0236 fusion reviews
 -- NOWAIT like the session/project/run locks: a claim holding a review row fails this fast (retryable
 -- CONTENT_ERASURE_BUSY) instead of a deadlock (#955 review).
 PERFORM fr.id FROM fusion_reviews fr WHERE fr.actor_id=a AND (fr.project_id=ANY(projects) OR fr.source_session_id=ANY(sessions)
  OR fr.source_version_id=ANY(versions)) ORDER BY fr.id FOR UPDATE NOWAIT;
 DELETE FROM fusion_reviews fr WHERE fr.actor_id=a AND (fr.project_id=ANY(projects) OR fr.source_session_id=ANY(sessions)
  OR fr.source_version_id=ANY(versions));
 -- 0294 fee refund
 PERFORM fusion_review_fee_settle_internal(held_fee.review_id) FROM fusion_review_fees held_fee
  WHERE held_fee.actor_id=a AND held_fee.state='held' AND NOT EXISTS(SELECT 1 FROM fusion_reviews WHERE id=held_fee.review_id);
 -- 0235 fusion outputs
 -- Like the session/project locks above, take the Fusion run locks up front with NOWAIT: a concurrent group
 -- claim holds a run and then the profile, so waiting here could deadlock; failing fast lets the caller
 -- (or the deletion sweep) retry once the claim committed (#947 review).
 PERFORM r.id FROM bill2_runs r JOIN fusion_billing_groups g ON g.id=r.fusion_group_id
  WHERE g.actor_id=a AND (g.source_session_id=ANY(sessions)
   OR g.source_session_id IN (SELECT d.session_id FROM opc_drafts d WHERE d.actor_id=a AND d.project_id=ANY(projects)))
  ORDER BY r.id FOR UPDATE OF r NOWAIT;
 FOR row IN SELECT r.id,r.closed FROM bill2_runs r JOIN fusion_billing_groups g ON g.id=r.fusion_group_id
  WHERE g.actor_id=a AND (g.source_session_id=ANY(sessions)
   OR g.source_session_id IN (SELECT d.session_id FROM opc_drafts d WHERE d.actor_id=a AND d.project_id=ANY(projects))) ORDER BY r.id LOOP
  UPDATE bill2_runs SET content_deleted_at=stamp WHERE id=row.id AND content_deleted_at IS NULL;
  IF NOT row.closed THEN PERFORM bill2_cancel(a,row.id); END IF;
  PERFORM bill2_finalize(a,row.id);
  -- Anything a scrub could not clear yet is counted (review_required), and the recovery cron
  -- scrubs a content-deleted run again once it settles (PR-3b).
  financial:=account_erasure_scrub_calls(a,row.id);
  remaining:=remaining+coalesce((financial->>'remaining')::bigint,0);
  financial:=account_erasure_scrub_run(a,row.id);
  remaining:=remaining+coalesce((financial->>'remaining')::bigint,0);
  financial:=account_erasure_scrub_receipts(a,row.id,100);
  remaining:=remaining+coalesce((financial->>'remaining')::bigint,0);
 END LOOP;
 DELETE FROM fusion_call_outputs o USING fusion_billing_groups g
  WHERE o.group_id=g.id AND g.actor_id=a AND (g.source_session_id=ANY(sessions)
   OR g.source_session_id IN (SELECT d.session_id FROM opc_drafts d WHERE d.actor_id=a AND d.project_id=ANY(projects)));
 UPDATE runtime_scope_material m SET request=NULL,content=NULL,content_hash=NULL,erased_at=stamp
  WHERE m.erased_at IS NULL AND EXISTS(SELECT 1 FROM runtime_sessions s WHERE s.id=m.session_id AND s.actor_id=a)
   AND (m.session_id=ANY(refs) OR m.request_id=ANY(refs)
    OR EXISTS(SELECT 1 FROM runtime_sessions rs WHERE rs.id=m.session_id AND content_erasure_references(rs.scope,refs))
    OR content_erasure_references(m.request,refs) OR content_erasure_references(m.content,refs)
    OR EXISTS(SELECT 1 FROM opc_video_material_bindings b WHERE b.session_id=m.session_id AND b.material_revision=m.revision AND b.source_script_id=ANY(refs)));
 UPDATE runtime_tool_calls SET arguments=NULL,result=NULL,erased_at=stamp WHERE execution_id=ANY(ids) AND erased_at IS NULL;
 UPDATE runtime_session_batches SET items=NULL,erased_at=stamp WHERE execution_id=ANY(ids) AND erased_at IS NULL;
 UPDATE runtime_session_history SET item=NULL,erased_at=stamp WHERE execution_id=ANY(ids) AND erased_at IS NULL
  AND (session_id=ANY(sessions) OR item->>'role' IS DISTINCT FROM 'user');
 UPDATE runtime_history_dependencies SET erased_at=stamp WHERE erased_at IS NULL
  AND (execution_id=ANY(ids) OR dependency_id=ANY(ids));
 UPDATE runtime_executions SET payload=jsonb_build_object('input',payload->'input'),result=NULL,primary_result=NULL,match_result=NULL,
  unavailable_reason='content_deleted',content_deleted_at=stamp WHERE id=ANY(ids) AND content_deleted_at IS NULL AND erased_at IS NULL;
 -- Whole sessions also clear retained questions; an answer deletion retains them.
 UPDATE runtime_executions SET payload=NULL,result=NULL,primary_result=NULL,match_result=NULL,erased_at=stamp
  WHERE session_id=ANY(sessions) AND erased_at IS NULL AND state IN ('completed','cancelled');
 UPDATE runtime_executions SET payload=jsonb_build_object('input',NULL)
  WHERE session_id=ANY(sessions) AND erased_at IS NULL AND content_deleted_at IS NOT NULL;
 UPDATE bill2_drafts SET revoked=true WHERE actor_id=a AND id IN
  (SELECT (rs.scope->>'draftId')::uuid FROM runtime_sessions rs WHERE rs.id=ANY(sessions) AND rs.scope->>'kind' IN ('positioning_draft','positioning_topic'));
 DELETE FROM runtime_session_names WHERE session_id=ANY(sessions);
 -- A session with a turn still open keeps its (tombstoned, content-free) shell until that turn closes: an erased row is
 -- immutable and the closing turn releases active_turn_id on it. The sweep erases it on a later pass.
 UPDATE runtime_sessions SET scope=NULL,start_payload=NULL,erased_at=stamp WHERE id=ANY(sessions) AND erased_at IS NULL
  AND active_turn_id IS NULL;
 -- CORE-PATH-V2 conversation content: the provider response bodies of its turns and its message text. The turns and their
 -- receipts are billing records and keep their billing fields (plan 4.6).
 DELETE FROM turn_call_raw r USING turns t WHERE t.actor_id=a AND t.session_id=ANY(sessions) AND r.turn_id=t.id;
 UPDATE session_messages SET content='',content_hash=encode(sha256(''::bytea),'hex'),visible=false,deleted_at=coalesce(deleted_at,stamp)
  WHERE session_id=ANY(sessions) AND (content<>'' OR visible);
 -- The turns behind deleted content (content_erasure_scope), in conversations that stay.
 DELETE FROM turn_call_raw r USING turns t WHERE t.actor_id=a AND t.id=ANY(turn_ids) AND r.turn_id=t.id;
 UPDATE session_messages m SET content='',content_hash=encode(sha256(''::bytea),'hex'),visible=false,deleted_at=coalesce(m.deleted_at,stamp)
  FROM turns t WHERE t.actor_id=a AND t.id=ANY(turn_ids) AND m.session_id=t.session_id AND m.turn_id=t.id AND (m.content<>'' OR m.visible);
 UPDATE opc_content_versions SET body=NULL,title=NULL,erased_at=stamp WHERE id=ANY(contents) AND erased_at IS NULL;
 -- System capture fields and suggestions carry exact execution provenance. Preserve
 -- unrelated manual fields and independently saved published bodies.
 UPDATE artifact_rounds r SET steps=content_erasure_capture_steps(r.steps)
  WHERE r.erased_at IS NULL AND NOT r.id=ANY(rounds)
  AND EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=r.project_id AND p.actor_id=a)
  AND content_erasure_references(r.steps,ids)
  AND r.steps IS DISTINCT FROM content_erasure_capture_steps(r.steps);
 UPDATE artifact_generations g SET input=NULL,result=(SELECT jsonb_object_agg(key,value)
  FROM jsonb_each(coalesce(g.result,'{}')) WHERE key IN ('credits','inputTokens','outputTokens','costUsd')),erased_at=stamp
  WHERE g.erased_at IS NULL AND g.state IN ('succeeded','refunded') AND
   (g.project_id=ANY(projects) OR content_erasure_references(g.input,refs));
 UPDATE agent_slice_executions SET preference_refs=NULL,discussion_refs=NULL,input_hash=NULL,erased_at=stamp
  WHERE erased_at IS NULL AND project_id=ANY(projects);
 UPDATE agent_slice_links SET source_hash=NULL,erased_at=stamp WHERE erased_at IS NULL AND round_id=ANY(rounds);
 UPDATE opc_library_requests SET payload=NULL,result=NULL,erased_at=stamp WHERE actor_id=a AND erased_at IS NULL
  AND (request_id IN (SELECT request_id FROM opc_content_versions WHERE id=ANY(contents))
   OR result->>'id'=ANY(contents::text[]) OR content_erasure_references(payload,refs) OR content_erasure_references(result,refs));
 UPDATE opc_handoffs SET payload=NULL,result=NULL,erased_at=stamp WHERE actor_id=a AND erased_at IS NULL
  AND (content_erasure_references(payload,refs) OR content_erasure_references(result,refs));
 UPDATE opc_topic_draft_versions SET request=NULL,body=NULL,erased_at=stamp WHERE actor_id=a AND erased_at IS NULL
  AND (source_version_id=ANY(versions) OR request_id=ANY(refs)
   OR content_erasure_references(request,refs) OR content_erasure_references(body,refs)
   OR request_id IN (SELECT event.request_id FROM opc_data_events event WHERE event.actor_id=a
    AND event.action='topic_draft' AND (event.execution_id=ANY(ids)
     OR event.turn_id IN (SELECT t.id FROM turns t WHERE t.actor_id=a AND t.session_id=ANY(sessions)))));
 DELETE FROM opc_data_events WHERE actor_id=a AND (execution_id=ANY(ids) OR project_id=ANY(projects)
  OR turn_id IN (SELECT t.id FROM turns t WHERE t.actor_id=a AND t.session_id=ANY(sessions))
  OR target_project_id=ANY(projects) OR source_version_id=ANY(versions));
 -- Frozen source bodies and request caches are system copies, not independent saved content.
 UPDATE opc_turns t SET input_hash=NULL,erased_at=stamp WHERE t.erased_at IS NULL AND
  (t.session_id=ANY(sessions) OR t.round_id=ANY(rounds) OR EXISTS(SELECT 1 FROM runtime_executions e
   WHERE e.id=ANY(ids) AND e.session_id=t.session_id AND e.request_id=t.request_id));
 UPDATE opc_topic_workspaces SET source_hash=NULL,erased_at=stamp WHERE actor_id=a AND erased_at IS NULL
  AND (session_id=ANY(sessions) OR source_version_id=ANY(versions));
 UPDATE opc_topic_openings SET input=NULL,erased_at=stamp WHERE erased_at IS NULL AND draft_id IN
  (SELECT draft_id FROM opc_drafts WHERE actor_id=a AND (session_id=ANY(sessions) OR project_id=ANY(projects)));
 UPDATE opc_plans SET request=NULL,body=NULL,erased_at=stamp WHERE erased_at IS NULL AND source_version_id=ANY(versions);
 -- Same private-setting removal as account erasure, restricted to the selected family.
 DELETE FROM opc_work_ui WHERE actor_id=a AND work_item_id=ANY(projects);
 DELETE FROM opc_account_ui WHERE actor_id=a AND account_project_id=ANY(projects);
 DELETE FROM opc_publication_ui WHERE actor_id=a AND work_item_id=ANY(projects);
 UPDATE opc_item_edits SET title=NULL,brief=NULL,erased_at=stamp WHERE erased_at IS NULL AND work_item_id=ANY(projects);
 UPDATE opc_items SET brief=NULL,erased_at=stamp WHERE erased_at IS NULL AND work_item_id=ANY(projects);
 UPDATE opc_accounts SET account_key='erased:'||project_id,erased_at=stamp WHERE erased_at IS NULL AND project_id=ANY(projects);
 -- Guided Skill chats belong to the selected artifact family. Clear snapshots
 -- before message bodies and retain content-free identity shells for accounting.
 UPDATE conversation_context_snapshots SET content=NULL,metadata=NULL,erased_at=stamp
  WHERE conversation_id=ANY(chats) AND erased_at IS NULL;
 UPDATE messages SET content=NULL,erased_at=stamp WHERE conversation_id=ANY(chats) AND erased_at IS NULL;
 UPDATE artifact_chat_turns SET body=NULL,erased_at=stamp WHERE conversation_id=ANY(chats) AND erased_at IS NULL;
 UPDATE conversations SET is_deleted='true',deleted_at=stamp WHERE id=ANY(chats) AND erased_at IS NULL;
 UPDATE conversations SET title=NULL,summary=NULL,summary_metadata=NULL,erased_at=stamp WHERE id=ANY(chats) AND erased_at IS NULL;
 UPDATE artifact_versions SET report=NULL,report_hash=NULL,erased_at=stamp WHERE project_id=ANY(projects) AND erased_at IS NULL;
 UPDATE artifact_candidates SET body=NULL,erased_at=stamp WHERE round_id=ANY(rounds) AND erased_at IS NULL;
 UPDATE artifact_confirmations SET body=NULL,erased_at=stamp WHERE round_id=ANY(rounds) AND erased_at IS NULL;
 -- Bound plans include approved operations that were never reserved; erasing them prevents late reserve.
 UPDATE research_plans p SET operations=NULL,erased_at=stamp WHERE p.actor_id=a AND p.erased_at IS NULL AND (p.session_id=ANY(sessions) OR p.execution_id=ANY(ids) OR p.discovery_id IN (
   SELECT d.id FROM research_discoveries d JOIN research_selection_cards c ON c.confirmation_id=d.keyword_confirmation_id
   WHERE c.actor_id=a AND (c.session_id=ANY(sessions) OR c.execution_id=ANY(ids))));
 WITH removed AS (
  DELETE FROM research_discoveries d WHERE d.actor_id=a AND (d.session_id=ANY(sessions) OR d.execution_id=ANY(ids)
   OR d.keyword_confirmation_id IN (SELECT confirmation_id FROM research_selection_cards
    WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids)))) RETURNING id
 ) DELETE FROM research_selection_cards WHERE actor_id=a AND
  (session_id=ANY(sessions) OR execution_id=ANY(ids) OR discovery_id IN (SELECT id FROM removed));
 -- Deleting only the answer of a later refresh keeps the earlier success of a remaining answer: the record goes back
 -- to that success (the refresh attempt is dropped and can never finish), so it is reused and never paid for again.
 UPDATE research_account_fetches SET state=CASE WHEN state='failed_charged' THEN state ELSE 'succeeded' END,execution_id=last_success_execution_id,evidence=last_success,
   attempt=gen_random_uuid(),refresh_id=NULL,updated_at=clock_timestamp()
 WHERE actor_id=a AND execution_id=ANY(ids) AND last_success IS NOT NULL
   AND NOT coalesce(last_success_execution_id=ANY(ids),false) AND NOT coalesce(session_id=ANY(sessions),false);
 -- A sent charged/unknown result must not become payable again when only its answer is removed.
 -- Retain only the session-scoped digest and terminal state; revoke late completion tokens and all private payload.
 UPDATE research_account_fetches SET execution_id=NULL,account=NULL,evidence=NULL,last_success=NULL,
   last_success_execution_id=NULL,refresh_id=NULL,attempt=gen_random_uuid(),updated_at=stamp
 WHERE actor_id=a AND state IN ('failed_charged','unknown')
   AND (execution_id=ANY(ids) OR last_success_execution_id=ANY(ids)) AND NOT coalesce(session_id=ANY(sessions),false);
 DELETE FROM research_account_fetches WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids)
   OR last_success_execution_id=ANY(ids));
 DELETE FROM research_refresh_grants WHERE actor_id=a AND (session_id=ANY(sessions)
   OR used_execution_id=ANY(ids) OR source_execution_id=ANY(ids));
 DELETE FROM research_discoveries WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids));
 -- 0338 session results: a saved result goes with its conversation; erasing only its source reply keeps it (shown as source unavailable).
 DELETE FROM runtime_session_results WHERE actor_id=a AND session_id=ANY(sessions);
 -- 0320 shortfall: the choice card goes with its answer or conversation.
 DELETE FROM research_benchmark_shortfalls WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids));
 -- 0268 benchmarks: derived numbers go with their answer, conversation or evidence.
 DELETE FROM research_benchmarks WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids)
   OR operation_ids && research_ids);
 -- Same terminal-result cost projection as account erasure; original amounts and charge IDs stay intact.
 UPDATE research_operations o SET erased_at=stamp,
  result=(SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(
   CASE WHEN jsonb_typeof(o.result)='object' THEN o.result ELSE '{}'::jsonb END) e WHERE e.key='cost')
 WHERE o.id=ANY(research_ids) AND o.erased_at IS NULL;
 -- Plans contain approved operation IDs/hashes/quote ceilings, never query text. Preserve
 -- mixed plans for unrelated operations; clear only when every approved operation is erased.
 UPDATE research_plans p SET operations=NULL,erased_at=stamp WHERE p.id=ANY(research_plan_ids)
  AND p.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.operations) item
   WHERE NOT EXISTS(SELECT 1 FROM research_operations o WHERE o.plan_id=p.id
    AND o.id::text=item->>'operationId' AND o.erased_at IS NOT NULL));
 UPDATE artifact_evidence SET payload=NULL,content_hash=NULL,erased_at=stamp WHERE erased_at IS NULL AND
  (project_id=ANY(projects) OR id=ANY(linked));
 UPDATE artifact_requests SET payload=(SELECT jsonb_object_agg(key,value) FROM jsonb_each(coalesce(payload,'{}'))
  WHERE key IN ('sliceExecution','slicePhase')),response=NULL,erased_at=stamp WHERE erased_at IS NULL AND
  EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=artifact_requests.project_id AND p.actor_id=a)
  AND (project_id=ANY(projects) OR content_erasure_references(payload,refs) OR content_erasure_references(response,refs));
 UPDATE artifact_rounds SET steps=NULL,erased_at=stamp WHERE id=ANY(rounds) AND erased_at IS NULL;
 UPDATE artifact_work_references SET creation_payload=NULL,source_hash=NULL,erased_at=stamp WHERE erased_at IS NULL AND
  (project_id=ANY(projects) OR source_version_id=ANY(versions));
 UPDATE artifact_projects SET work_title=NULL,account='erased:'||id,erased_at=stamp WHERE id=ANY(projects) AND erased_at IS NULL;
 -- content_erasure_ledger_owned is true only for a row naming one of this account's content-deleted runs. Collect those
 -- runs once and test each row's five identities against them with plain comparisons first, so the function (and the guard
 -- trigger it feeds) only runs for rows that can be owned; ownership is still decided by content_erasure_ledger_owned.
 deleted_runs:=ARRAY(SELECT r.id::text FROM bill2_runs r WHERE r.actor_id=a AND r.content_deleted_at IS NOT NULL);
 deleted_pre:=ARRAY(SELECT r.pre_deduct_id::text FROM bill2_runs r WHERE r.actor_id=a AND r.content_deleted_at IS NOT NULL
   AND r.pre_deduct_id IS NOT NULL);
 FOR row IN SELECT * FROM (VALUES
  ('token_stats','content_erased_at=$2'),
  ('billing_history','reason=NULL,content_erased_at=$2'),
  ('credit_transactions','description=NULL,content_erased_at=$2'),
  ('ai_usage_logs','error_message=NULL,ip_address=NULL,user_agent=NULL,content_erased_at=$2')
 ) x(tbl,assignment) LOOP
  EXECUTE format('WITH cand AS MATERIALIZED (SELECT t.ctid c FROM public.%1$I t CROSS JOIN LATERAL (SELECT to_jsonb(t) j) x
    WHERE t.user_id=$1 AND t.content_erased_at IS NULL
     AND ((x.j->>''bill2_run_id'')=ANY($3) OR (x.j#>>''{metadata,usage,runId}'')=ANY($3) OR (x.j#>>''{metadata,runId}'')=ANY($3)
      OR (x.j->>''id'')=ANY($4) OR (x.j#>>''{metadata,preDeductId}'')=ANY($4))
     AND content_erasure_ledger_owned(x.j))
   UPDATE public.%1$I t SET %2$s FROM cand WHERE t.ctid=cand.c',
   row.tbl,row.assignment) USING a,stamp,deleted_runs,deleted_pre;
 END LOOP;
 -- This status is about content. Unknown money remains on its original run.
 RETURN jsonb_build_object('kind',k,'id',target,'status',CASE WHEN remaining>0 THEN 'review_required' ELSE 'deleted' END,
  'alreadyDeleted',deleted,'preservedSavedVersions',scope->'preservedSavedVersions','financialReviewCount',remaining);
EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
 RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
END $function$;

CREATE OR REPLACE FUNCTION public.turn_session_view(p_actor_id uuid, p_session_id uuid, p_after_seq integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions; a turns; l turns;
BEGIN
  -- A disabled or deleted account reads nothing, as every other read (bill2_actor) and turn_open refuse it.
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_actor_id AND status = 'active' AND is_deleted::text = 'false') THEN
    RAISE EXCEPTION 'TURN_ACCOUNT_DENIED' USING ERRCODE='42501';
  END IF;
  SELECT * INTO s FROM runtime_sessions WHERE id = p_session_id AND actor_id = p_actor_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'TURN_SESSION_DENIED' USING ERRCODE='42501'; END IF;
  IF s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'TURN_SESSION_ERASED' USING ERRCODE='42501'; END IF;
  -- The conversation's whole scope is session_view_allowed, called first by Node (view.ts); a draft revoked since then is refused
  -- here, in the same snapshot as the messages.
  IF s.scope->>'kind' = 'positioning_draft' AND NOT (turn_mentor_draft_allowed(p_actor_id, (s.scope->>'draftId')::uuid)
      AND turn_mentor_source_live((s.scope->>'draftId')::uuid)) THEN
    RAISE EXCEPTION 'TURN_SESSION_DENIED' USING ERRCODE='42501';
  END IF;
  IF s.active_turn_id IS NOT NULL THEN SELECT * INTO a FROM turns WHERE actor_id = p_actor_id AND id = s.active_turn_id; END IF;
  SELECT * INTO l FROM turns WHERE session_id = p_session_id AND actor_id = p_actor_id AND state = 'closed'
    ORDER BY opened_at DESC LIMIT 1;
  RETURN jsonb_build_object(
    'activeTurn', CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('turnId', a.id, 'kind', a.kind, 'state', a.state,
      'pauseReason', a.pause_reason, 'openedAt', a.opened_at, 'updatedAt', a.updated_at) END,
    'lastTurn', CASE WHEN l.id IS NULL THEN NULL ELSE jsonb_build_object('turnId', l.id, 'kind', l.kind, 'closeKind', l.close_kind,
      'failureCode', l.failure_code, 'settlement', l.settlement, 'chargedCredits', l.charged_credits, 'closedAt', l.closed_at) END,
    'messages', (SELECT coalesce(jsonb_agg(jsonb_build_object('seq', m.seq, 'role', m.role, 'turnId', m.turn_id, 'content', m.content,
          -- The page's handle of a topic reply (V2-10b): its turn's request id, what the topic draft and the adoption name.
          'requestId', (SELECT r.request_id FROM turns r WHERE r.actor_id = p_actor_id AND r.id = m.turn_id),
          -- A Skill reply of a work item (V2-10b C2): what the page offers to adopt.
          'workSkill', (SELECT r.policy ? 'workSkill' FROM turns r WHERE r.actor_id = p_actor_id AND r.id = m.turn_id))
        ORDER BY m.seq), '[]'::jsonb)
      FROM (SELECT seq, role, turn_id, content FROM session_messages
            WHERE session_id = p_session_id AND visible AND deleted_at IS NULL AND seq > greatest(coalesce(p_after_seq, 0), 0)
            ORDER BY seq LIMIT 50) m),
    -- The paid tool calls behind those replies, for the work rows a reload shows again (Owner 10-02): a reply's own turn and the
    -- paused turns it continued. What was asked is the tool call in the model receipt just before; a receipt that holds none
    -- gives null. Owner's key only; nothing is written.
    'calls', (WITH RECURSIVE shown AS (
        SELECT DISTINCT m.turn_id AS reply, m.turn_id AS id FROM (SELECT seq, turn_id FROM session_messages
            WHERE session_id = p_session_id AND visible AND deleted_at IS NULL AND seq > greatest(coalesce(p_after_seq, 0), 0)
            ORDER BY seq LIMIT 50) m
        UNION ALL
        SELECT x.reply, t.resume_of FROM shown x JOIN turns t ON t.actor_id = p_actor_id AND t.id = x.id WHERE t.resume_of IS NOT NULL)
      SELECT coalesce(jsonb_agg(jsonb_build_object('turnId', x.reply, 'seq', c.seq, 'toolName', c.tool_name, 'status', c.status,
          'usage', c.usage, 'q', t.policy->'q', 'multiplier', c.multiplier,
          -- The model call that asked: a benchmark lookup settles in several rows, so not always the row just before.
          -- Along the resume chain: a resumed turn's first real call may follow the model receipt of the turn it continued.
          'arguments', (WITH RECURSIVE up AS (SELECT t.id AS id, 0 AS depth, t.resume_of AS previous
              UNION ALL SELECT p.id, u.depth + 1, p.resume_of FROM up u JOIN turns p ON p.actor_id = p_actor_id AND p.id = u.previous)
            SELECT r.body::jsonb #>> '{choices,0,message,tool_calls,0,function,arguments}' FROM up u
              JOIN turn_calls m ON m.turn_id = u.id AND m.call_kind = 'model' AND (u.depth > 0 OR m.seq < c.seq)
              JOIN turn_call_raw r ON r.turn_id = m.turn_id AND r.seq = m.seq
              ORDER BY u.depth, m.seq DESC LIMIT 1)) ORDER BY t.id, c.seq), '[]'::jsonb)
      FROM shown x JOIN turns t ON t.actor_id = p_actor_id AND t.id = x.id AND t.session_id = p_session_id
      JOIN turn_calls c ON c.turn_id = t.id AND c.call_kind = 'tool' AND c.upper_usd > 0 AND c.status IN ('ok', 'unusable')));
END $function$;

DO $grants$
DECLARE f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['opc_work_check(uuid,uuid,boolean,uuid)','opc_work_source(uuid,uuid,text)',
   'opc_content_from_turn(uuid,uuid,uuid,bigint,text,text,bigint,uuid)','opc_video_turn_check(uuid,uuid,bigint,uuid)',
   'opc_video_results_from_turn(uuid,uuid,uuid,bigint,uuid,bigint,bigint,boolean,boolean)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated, service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
 END LOOP;
 REVOKE ALL ON FUNCTION public.opc_content_turn_available(uuid,bigint) FROM PUBLIC, anon, authenticated, service_role;
END $grants$;
COMMIT;
