/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Forward only. Remote application requires separate Owner authorization.
ALTER TABLE public.skills ADD COLUMN IF NOT EXISTS content_kind text NOT NULL DEFAULT 'text'
  CHECK (content_kind IN ('text', 'directory'));
CREATE TABLE IF NOT EXISTS public.skill_packages (
  revision_id uuid PRIMARY KEY REFERENCES public.skill_revisions(id),
  skill_id uuid NOT NULL REFERENCES public.skills(id),
  request_id uuid NOT NULL UNIQUE,
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  package_hash text NOT NULL CHECK (package_hash ~ '^[a-f0-9]{64}$'),
  entry_hash text NOT NULL CHECK (entry_hash ~ '^[a-f0-9]{64}$'),
  expected_version integer NOT NULL,
  actor_id uuid NOT NULL REFERENCES public.profiles(id)
);
CREATE INDEX IF NOT EXISTS skill_packages_skill_idx ON public.skill_packages(skill_id);
CREATE TABLE IF NOT EXISTS public.skill_package_files (
  revision_id uuid NOT NULL REFERENCES public.skill_packages(revision_id),
  path text NOT NULL,
  bytes bytea NOT NULL,
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 0 AND 2097152),
  media_type text NOT NULL CHECK (media_type = 'text/markdown'),
  file_hash text NOT NULL CHECK (file_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (revision_id, path),
  CHECK (octet_length(bytes) = byte_length),
  CHECK (encode(sha256(bytes), 'hex') = file_hash)
);
CREATE TABLE IF NOT EXISTS public.skill_revision_revocations (
  revision_id uuid PRIMARY KEY REFERENCES public.skill_revisions(id),
  revoked_by uuid NOT NULL REFERENCES public.profiles(id),
  revoked_at timestamptz NOT NULL DEFAULT now()
);
-- Revocation is separate, irreversible state. Restore content by publishing a new revision.
DO $$ DECLARE t text; cols text; BEGIN
  FOREACH t IN ARRAY ARRAY['skills','skill_revisions','skill_packages','skill_package_files','skill_revision_revocations'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated',t);
    SELECT string_agg(quote_ident(attname),',') INTO cols FROM pg_attribute
      WHERE attrelid = ('public.'||t)::regclass AND attnum > 0 AND NOT attisdropped;
    EXECUTE format('REVOKE SELECT (%s), INSERT (%s), UPDATE (%s), REFERENCES (%s) ON public.%I FROM PUBLIC, anon, authenticated',cols,cols,cols,cols,t);
    IF t IN ('skill_packages','skill_package_files','skill_revision_revocations') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM service_role',t);
      EXECUTE format('GRANT SELECT ON public.%I TO service_role',t);
      EXECUTE format('DROP TRIGGER IF EXISTS immutable_content ON public.%I',t);
      EXECUTE format('CREATE TRIGGER immutable_content BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.prevent_skill_revision_mutation()',t);
    END IF;
  END LOOP;
END $$;
GRANT SELECT (id,skill_key,status,published_version,published_at,content_kind) ON public.skills TO anon,authenticated;
-- No new public view or private-read RPC grants. Refuse unexpected inherited privilege.
DO $$ BEGIN
  IF has_column_privilege('anon','public.skills','published_content','SELECT')
     OR has_column_privilege('authenticated','public.skills','published_content','SELECT') THEN
    RAISE EXCEPTION 'unexpected inherited private Skill access';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.enforce_skill_package_kind() RETURNS trigger
LANGUAGE plpgsql SET search_path = public,pg_temp AS $$ BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.published_version > 0 AND NEW.content_kind <> OLD.content_kind THEN
      RAISE EXCEPTION 'published Skill kind is immutable';
    END IF;
    IF OLD.content_kind = 'directory' AND NEW.draft_content IS DISTINCT FROM OLD.draft_content THEN
      RAISE EXCEPTION 'directory packages require complete publication';
    END IF;
  END IF;
  IF NEW.content_kind = 'directory' AND NEW.published_version > 0 AND NOT EXISTS (
    SELECT 1 FROM public.skill_packages p JOIN public.skill_revisions r ON r.id=p.revision_id
    WHERE p.skill_id=NEW.id AND r.skill_id=NEW.id AND r.version=NEW.published_version
      AND r.content_hash=p.entry_hash AND r.content=NEW.published_content
  ) THEN RAISE EXCEPTION 'complete package revision required'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS enforce_skill_package_kind ON public.skills;
CREATE TRIGGER enforce_skill_package_kind BEFORE INSERT OR UPDATE ON public.skills
FOR EACH ROW EXECUTE FUNCTION public.enforce_skill_package_kind();

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
    IF f->>'path' IS NULL OR length(f->>'path') NOT BETWEEN 1 AND 240 OR f->>'path' !~ '\.md$'
      OR f->>'path' ~ '(^/|\\|[:%?#[:cntrl:][:space:]]|(^|/)(\.|\.\.|scripts)(/|$)|//)'
      OR lower(f->>'path')=ANY(paths) THEN RAISE EXCEPTION 'invalid path'; END IF;
    paths:=array_append(paths,lower(f->>'path'));
    SELECT x INTO meta FROM jsonb_array_elements(p_manifest->'files') x WHERE x->>'path'=f->>'path';
    b:=decode(f->>'base64','base64');
    IF b IS NULL OR meta IS NULL OR meta->>'mediaType' IS DISTINCT FROM 'text/markdown'
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

CREATE OR REPLACE FUNCTION public.revoke_skill_revision(p_revision_id uuid,p_actor_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_actor_id AND role='admin' AND status='active') THEN RAISE EXCEPTION 'administrator required' USING ERRCODE='42501'; END IF;
  INSERT INTO public.skill_revision_revocations(revision_id,revoked_by) VALUES(p_revision_id,p_actor_id) ON CONFLICT DO NOTHING;
END $$;

-- Internal service caller must authenticate the actor and perform existing business admission.
-- Every call independently checks current actor state, module/binding and revocation.
CREATE OR REPLACE FUNCTION public.read_skill_package(p_actor_id uuid,p_module_id uuid,p_skill_id uuid,
  p_revision_id uuid DEFAULT NULL,p_package_hash text DEFAULT NULL,p_path text DEFAULT NULL,p_max_bytes integer DEFAULT 2097152)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p public.skill_packages%ROWTYPE; f public.skill_package_files%ROWTYPE;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false')
    OR NOT EXISTS(SELECT 1 FROM public.modules WHERE id=p_module_id AND skill_id=p_skill_id AND active IS TRUE)
    OR NOT EXISTS(SELECT 1 FROM public.skills WHERE id=p_skill_id AND status='published' AND content_kind='directory') THEN RAISE EXCEPTION 'Skill unavailable' USING ERRCODE='42501'; END IF;
  SELECT pk.* INTO p FROM public.skill_packages pk JOIN public.skill_revisions r ON r.id=pk.revision_id
    JOIN public.skills s ON s.id=pk.skill_id WHERE pk.skill_id=p_skill_id
    AND ((p_revision_id IS NULL AND r.version=s.published_version) OR r.id=p_revision_id)
    AND (p_package_hash IS NULL OR pk.package_hash=p_package_hash)
    AND NOT EXISTS(SELECT 1 FROM public.skill_revision_revocations WHERE revision_id=r.id);
  IF NOT FOUND THEN RAISE EXCEPTION 'Skill unavailable'; END IF;
  IF p_path IS NULL THEN RETURN p.manifest; END IF;
  IF p_path='' THEN RETURN 'true'::jsonb; END IF;
  SELECT * INTO f FROM public.skill_package_files WHERE revision_id=p.revision_id AND path=p_path;
  IF NOT FOUND OR p_max_bytes IS NULL OR p_max_bytes<0 OR octet_length(f.bytes)>p_max_bytes THEN RAISE EXCEPTION 'resource unavailable'; END IF;
  RETURN to_jsonb(replace(encode(f.bytes,'base64'),E'\n',''));
END $$;
DO $$ DECLARE fn regprocedure; BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.enforce_skill_package_kind()'::regprocedure,
    'public.atomic_publish_skill_package(uuid,uuid,uuid,uuid,integer,jsonb,text,jsonb)'::regprocedure,
    'public.revoke_skill_revision(uuid,uuid)'::regprocedure,
    'public.read_skill_package(uuid,uuid,uuid,uuid,text,text,integer)'::regprocedure
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',fn);
    IF fn<>'public.enforce_skill_package_kind()'::regprocedure THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn); END IF;
  END LOOP;
END $$;

-- Admin activation may check a disabled module; active chat checks active first.
CREATE OR REPLACE FUNCTION public.is_text_skill_executable(p_module_id uuid,p_skill_id uuid,p_version integer,p_require_active boolean DEFAULT true)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM public.modules m JOIN public.skills s ON s.id=m.skill_id
    JOIN public.skill_revisions r ON r.skill_id=s.id AND r.version=p_version
    WHERE m.id=p_module_id AND (p_require_active IS FALSE OR m.active IS TRUE) AND s.id=p_skill_id AND s.status='published' AND s.content_kind='text'
      AND s.published_version=p_version AND NOT EXISTS(SELECT 1 FROM public.skill_revision_revocations WHERE revision_id=r.id));
$$;
REVOKE ALL ON FUNCTION public.is_text_skill_executable(uuid,uuid,integer,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.is_text_skill_executable(uuid,uuid,integer,boolean) TO service_role;

-- Refuse inherited ACL/view drift rather than silently asserting private storage.
DO $$ DECLARE r text; t text; c text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  FOREACH t IN ARRAY ARRAY['skills','skill_revisions','skill_packages','skill_package_files','skill_revision_revocations'] LOOP
   FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=('public.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
    IF NOT(t='skills' AND c=ANY(ARRAY['id','skill_key','status','published_version','published_at','content_kind']))
      AND has_column_privilege(r,'public.'||t,c,'SELECT') THEN RAISE EXCEPTION 'unexpected inherited private Skill privilege'; END IF;
   END LOOP;
  END LOOP;
  IF EXISTS (
    WITH RECURSIVE dependencies(oid) AS (
      SELECT oid FROM pg_class WHERE oid=ANY(ARRAY['public.skills'::regclass,'public.skill_revisions'::regclass,'public.skill_packages'::regclass,'public.skill_package_files'::regclass,'public.skill_revision_revocations'::regclass])
      UNION SELECT rw.ev_class FROM dependencies d JOIN pg_depend dep ON dep.refobjid=d.oid
        JOIN pg_rewrite rw ON rw.oid=dep.objid AND dep.classid='pg_rewrite'::regclass
    ) SELECT 1 FROM dependencies d JOIN pg_class v ON v.oid=d.oid WHERE v.relkind IN ('v','m') AND has_any_column_privilege(r,v.oid,'SELECT')
  ) THEN RAISE EXCEPTION 'review existing private Skill view access before applying'; END IF;
 END LOOP;
END $$;
