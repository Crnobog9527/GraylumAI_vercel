/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Additive administrator publication. Existing projects and immutable revisions are retained.
BEGIN;
ALTER TABLE public.skill_package_files DROP CONSTRAINT IF EXISTS skill_package_files_media_type_check;
ALTER TABLE public.skill_package_files ADD CONSTRAINT skill_package_files_media_type_check CHECK (media_type IN ('text/markdown','text/yaml'));
-- YAML templates remain bounded UTF-8 text resources, never executable configuration.
CREATE OR REPLACE FUNCTION public.atomic_publish_skill_package(
  p_skill_id uuid,p_actor_id uuid,p_revision_id uuid,p_request_id uuid,p_expected_version integer,
  p_manifest jsonb,p_hash_payload text,p_files jsonb
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.skills%ROWTYPE; prior public.skill_packages%ROWTYPE;
  f jsonb; meta jsonb; b bytea; entry text; entry_hash text; payload jsonb;
  total_bytes integer:=0; ts timestamptz:=clock_timestamp(); v integer; paths text[]:='{}'; ref text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id=p_actor_id AND role='admin' AND status='active') THEN
    RAISE EXCEPTION 'administrator required' USING ERRCODE='42501'; END IF;
  SELECT * INTO s FROM public.skills WHERE id=p_skill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Skill unavailable'; END IF;
  SELECT * INTO prior FROM public.skill_packages WHERE request_id=p_request_id;
  IF FOUND THEN
    IF prior.skill_id<>p_skill_id OR prior.revision_id<>p_revision_id OR prior.manifest IS DISTINCT FROM p_manifest
      OR prior.actor_id<>p_actor_id OR prior.expected_version<>p_expected_version THEN RAISE EXCEPTION 'request conflict'; END IF;
    -- File bytes are also checked on replay, not just caller-supplied hashes.
    IF (SELECT jsonb_agg(jsonb_build_object('path',path,'base64',replace(encode(bytes,'base64'),E'\n','')) ORDER BY path)
        FROM public.skill_package_files WHERE revision_id=prior.revision_id)
        IS DISTINCT FROM (SELECT jsonb_agg(x ORDER BY x->>'path') FROM jsonb_array_elements(p_files) x) THEN RAISE EXCEPTION 'request conflict'; END IF;
    RETURN p_expected_version+1;
  END IF;
  IF p_expected_version IS NULL OR s.published_version<>p_expected_version OR (s.published_version>0 AND s.content_kind<>'directory') THEN RAISE EXCEPTION 'stale draft or incompatible kind'; END IF;
  IF p_manifest->>'packageId' IS DISTINCT FROM p_skill_id::text OR p_manifest->>'revisionId' IS DISTINCT FROM p_revision_id::text
    OR jsonb_typeof(p_files) IS DISTINCT FROM 'array' OR jsonb_array_length(p_files) NOT BETWEEN 1 AND 64
    OR jsonb_typeof(p_manifest->'files') IS DISTINCT FROM 'array' OR jsonb_array_length(p_manifest->'files')<>jsonb_array_length(p_files)
    OR jsonb_typeof(p_manifest->'tasks') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_manifest->'requiredCapabilities') IS DISTINCT FROM 'array'
    OR (SELECT count(*) FROM jsonb_object_keys(p_manifest->'tasks'))>64
    OR octet_length(p_hash_payload)>131072 THEN RAISE EXCEPTION 'invalid package'; END IF;
  IF (p_manifest->>'directoryName') !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length(p_manifest->>'directoryName')>64
    OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_manifest->'requiredCapabilities') c WHERE c<>'documents.read') THEN RAISE EXCEPTION 'unsupported package'; END IF;
  FOR f IN SELECT * FROM jsonb_array_elements(p_files) LOOP
    IF f->>'path' IS NULL OR length(f->>'path') NOT BETWEEN 1 AND 240 OR f->>'path' !~ '\.(md|ya?ml)$'
      OR f->>'path' ~ '(^/|\\|[:%?#[:cntrl:][:space:]]|(^|/)(\.|\.\.|scripts)(/|$)|//)'
      OR lower(f->>'path')=ANY(paths) THEN RAISE EXCEPTION 'invalid path'; END IF;
    paths:=array_append(paths,lower(f->>'path'));
    SELECT x INTO meta FROM jsonb_array_elements(p_manifest->'files') x WHERE x->>'path'=f->>'path';
    b:=decode(f->>'base64','base64');
    IF b IS NULL OR meta IS NULL OR meta->>'mediaType' IS DISTINCT FROM (CASE WHEN f->>'path' ~ '\.md$' THEN 'text/markdown' ELSE 'text/yaml' END)
      OR (meta->>'bytes')::integer IS DISTINCT FROM octet_length(b)
      OR meta->>'sha256' IS DISTINCT FROM encode(sha256(b),'hex')
      OR jsonb_typeof(meta->'requires') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'file integrity mismatch'; END IF;
    PERFORM convert_from(b,'UTF8');
    total_bytes:=total_bytes+octet_length(b);
    IF total_bytes>2097152 THEN RAISE EXCEPTION 'package too large'; END IF;
    IF f->>'path'='SKILL.md' THEN entry:=convert_from(b,'UTF8'); entry_hash:=meta->>'sha256'; END IF;
  END LOOP;
  IF entry IS NULL OR length(btrim(entry))=0 THEN RAISE EXCEPTION 'entry required'; END IF;
  FOR ref IN SELECT jsonb_array_elements_text(x->'requires') FROM jsonb_array_elements(p_manifest->'files') x
    UNION ALL SELECT jsonb_array_elements_text(value) FROM jsonb_each(p_manifest->'tasks') LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_manifest->'files') x WHERE x->>'path'=ref) THEN RAISE EXCEPTION 'missing reference'; END IF;
  END LOOP;
  payload:=jsonb_build_object('packageId',p_skill_id::text,'revisionId',p_revision_id::text,'directoryName',p_manifest->>'directoryName',
    'files',(SELECT jsonb_agg(jsonb_build_array(x->'path',x->'bytes',x->'mediaType',x->'sha256',
      (SELECT coalesce(jsonb_agg(y ORDER BY y#>>'{}' COLLATE "C"),'[]') FROM jsonb_array_elements(x->'requires') y)) ORDER BY x->>'path' COLLATE "C") FROM jsonb_array_elements(p_manifest->'files') x),
    'tasks',(SELECT coalesce(jsonb_agg(jsonb_build_array(key,(SELECT coalesce(jsonb_agg(y ORDER BY y#>>'{}' COLLATE "C"),'[]') FROM jsonb_array_elements(value) y)) ORDER BY key COLLATE "C"),'[]') FROM jsonb_each(p_manifest->'tasks')),
    'requiredCapabilities',(SELECT coalesce(jsonb_agg(x ORDER BY x#>>'{}' COLLATE "C"),'[]') FROM jsonb_array_elements(p_manifest->'requiredCapabilities') x));
  IF p_hash_payload::jsonb IS DISTINCT FROM payload OR p_manifest->>'packageHash' IS DISTINCT FROM encode(sha256(convert_to(p_hash_payload,'UTF8')),'hex') THEN RAISE EXCEPTION 'package hash mismatch'; END IF;
  v:=s.published_version+1;
  INSERT INTO public.skill_revisions(id,skill_id,version,content,content_hash,published_by,publish_metadata,published_at)
    VALUES(p_revision_id,p_skill_id,v,entry,entry_hash,p_actor_id,'{"source":"complete_package"}',ts);
  INSERT INTO public.skill_packages VALUES(p_revision_id,p_skill_id,p_request_id,p_manifest,p_manifest->>'packageHash',entry_hash,p_expected_version,p_actor_id);
  INSERT INTO public.skill_package_files
    SELECT p_revision_id,pf->>'path',decode(pf->>'base64','base64'),(m->>'bytes')::integer,m->>'mediaType',m->>'sha256'
    FROM jsonb_array_elements(p_files) pf JOIN jsonb_array_elements(p_manifest->'files') m ON m->>'path'=pf->>'path';
  UPDATE public.skills SET content_kind='directory',published_content=entry,published_content_hash=entry_hash,published_version=v,
    published_at=ts,published_by=p_actor_id,updated_by=p_actor_id,status='published' WHERE id=p_skill_id;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.admin_publish_skill_module(
 p_actor_id uuid,p_module_id uuid,p_expected_updated_at timestamptz,p_metadata jsonb,
 p_skill_id uuid,p_revision_id uuid,p_request_id uuid,p_expected_version integer,
 p_manifest jsonb,p_hash_payload text,p_files jsonb,p_workflow jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m public.modules%ROWTYPE; n public.modules%ROWTYPE; prior public.artifact_workflows%ROWTYPE;
 v integer; registration text:='admin-'||p_request_id::text; ts timestamptz:=clock_timestamp();
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND role='admin' AND status='active' AND is_deleted='false') THEN
  RAISE EXCEPTION 'administrator required' USING ERRCODE='42501'; END IF;
 -- Serialize registry capacity as well as first creation, before a module row exists.
 PERFORM pg_advisory_xact_lock(hashtextextended('admin-skill-registry',72));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_module_id::text,72));
 SELECT * INTO m FROM modules WHERE id=p_module_id FOR UPDATE;
 IF jsonb_typeof(p_metadata) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_metadata) k WHERE k NOT IN
 ('title','description','full_description','model_id','platform','category','icon','image_url','badge_type','badge_text',
 'credits_display','sort_order','active','is_featured','features','examples','preparation_questions')) THEN RAISE EXCEPTION 'invalid module'; END IF;
 n:=jsonb_populate_record(NULL::public.modules,p_metadata);
 IF n.title IS NULL OR length(btrim(n.title)) NOT BETWEEN 1 AND 100 OR n.model_id IS NULL OR n.active IS NULL OR n.is_featured IS NULL
  OR n.sort_order IS NULL OR n.sort_order NOT BETWEEN 0 AND 1000 OR NOT EXISTS(SELECT 1 FROM ai_models WHERE id=n.model_id AND is_active='true') THEN
  RAISE EXCEPTION 'module or model unavailable'; END IF;
 SELECT * INTO prior FROM artifact_workflows WHERE id=registration;
 IF FOUND THEN
  -- Exact uncertain-result retries do not publish again or overwrite later edits.
  IF prior.module_id IS DISTINCT FROM p_module_id OR prior.skill_id IS DISTINCT FROM p_skill_id OR prior.revision_id IS DISTINCT FROM p_revision_id
   OR prior.workflow IS DISTINCT FROM p_workflow OR NOT coalesce(to_jsonb(m) @> p_metadata,false)
   OR m.skill_id IS DISTINCT FROM p_skill_id THEN RAISE EXCEPTION 'request conflict'; END IF;
  v:=atomic_publish_skill_package(p_skill_id,p_actor_id,p_revision_id,p_request_id,p_expected_version,p_manifest,p_hash_payload,p_files);
  RETURN jsonb_build_object('moduleId',p_module_id,'revisionId',p_revision_id,'version',v);
 END IF;
 IF (m.id IS NULL AND p_expected_updated_at IS NOT NULL) OR
    (m.id IS NOT NULL AND (p_expected_updated_at IS NULL OR m.updated_at IS DISTINCT FROM p_expected_updated_at)) THEN RAISE EXCEPTION 'module changed'; END IF;
 -- A new version retains the original Skill identity so saved conversations keep their binding.
 IF m.skill_id IS NOT NULL AND m.skill_id<>p_skill_id THEN RAISE EXCEPTION 'binding changed'; END IF;
 IF m.skill_id IS NULL THEN
  IF p_expected_version<>0 OR EXISTS(SELECT 1 FROM skills WHERE id=p_skill_id) THEN RAISE EXCEPTION 'new skill required'; END IF;
  INSERT INTO skills(id,skill_key,draft_content,created_by,updated_by)
   VALUES(p_skill_id,'module-'||p_module_id::text,'',p_actor_id,p_actor_id);
 END IF;
 IF EXISTS(SELECT 1 FROM artifact_workflows WHERE module_id=p_module_id AND enabled AND workflow->>'kind' IS DISTINCT FROM p_workflow->>'kind') THEN
  RAISE EXCEPTION 'workflow kind changed'; END IF;
 v:=atomic_publish_skill_package(p_skill_id,p_actor_id,p_revision_id,p_request_id,p_expected_version,p_manifest,p_hash_payload,p_files);
 PERFORM artifact_validate_workflow(p_workflow,p_manifest);
 IF p_workflow->>'kind' NOT IN ('document','social') OR (p_workflow->>'version')::integer IS DISTINCT FROM v THEN RAISE EXCEPTION 'invalid workflow'; END IF;
 IF m.id IS NULL THEN
  INSERT INTO modules(id,title,created_by,active) VALUES(p_module_id,n.title,p_actor_id,false);
 END IF;
 IF (SELECT count(*) FROM artifact_workflows WHERE enabled AND module_id<>p_module_id)>=100 THEN RAISE EXCEPTION 'registry capacity'; END IF;
 UPDATE artifact_workflows SET enabled=false WHERE module_id=p_module_id AND enabled;
 INSERT INTO artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled)
  VALUES(registration,p_module_id,p_skill_id,p_revision_id,p_workflow,n.title,true);
 UPDATE modules SET title=n.title,description=n.description,full_description=n.full_description,model_id=n.model_id,
  platform=n.platform,category=n.category,icon=n.icon,image_url=n.image_url,badge_type=n.badge_type,badge_text=n.badge_text,
  credits_display=n.credits_display,sort_order=n.sort_order,is_featured=n.is_featured,active=n.active,
  features=n.features,examples=n.examples,preparation_questions=n.preparation_questions,
  skill_id=p_skill_id,prompt_content=NULL,system_prompt=NULL,user_prompt_template=NULL,updated_at=ts WHERE id=p_module_id;
 RETURN jsonb_build_object('moduleId',p_module_id,'revisionId',p_revision_id,'version',v);
END $$;
CREATE OR REPLACE FUNCTION public.admin_read_skill_module(p_actor_id uuid,p_module_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m public.modules%ROWTYPE; s public.skills%ROWTYPE; w public.artifact_workflows%ROWTYPE; p public.skill_packages%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND role='admin' AND status='active' AND is_deleted='false') THEN
  RAISE EXCEPTION 'administrator required' USING ERRCODE='42501'; END IF;
 SELECT * INTO m FROM modules WHERE id=p_module_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'module unavailable'; END IF;
 IF m.skill_id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO s FROM skills WHERE id=m.skill_id;
 IF (SELECT count(*) FROM artifact_workflows WHERE module_id=m.id AND skill_id=s.id AND enabled)<>1 THEN RAISE EXCEPTION 'ambiguous or missing workflow'; END IF;
 SELECT * INTO w FROM artifact_workflows WHERE module_id=m.id AND skill_id=s.id AND enabled;
 IF NOT FOUND OR s.content_kind<>'directory' THEN RAISE EXCEPTION 'module requires its existing publisher'; END IF;
 SELECT * INTO p FROM skill_packages WHERE revision_id=w.revision_id;
 RETURN jsonb_build_object('skillId',s.id,'expectedVersion',s.published_version,'directoryName',p.manifest->>'directoryName',
  'workflow',w.workflow,'files',(SELECT jsonb_agg(jsonb_build_object('path',path,'base64',replace(encode(bytes,'base64'),E'\n','')) ORDER BY path)
   FROM skill_package_files WHERE revision_id=p.revision_id));
END $$;
REVOKE ALL ON FUNCTION public.admin_publish_skill_module(uuid,uuid,timestamptz,jsonb,uuid,uuid,uuid,integer,jsonb,text,jsonb,jsonb),
 public.admin_read_skill_module(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.admin_publish_skill_module(uuid,uuid,timestamptz,jsonb,uuid,uuid,uuid,integer,jsonb,text,jsonb,jsonb),
 public.admin_read_skill_module(uuid,uuid) TO service_role;
COMMIT;
