-- DB-PERF PR-4: a Skill load read each private file in its own read_skill_package call, each preceded by a separate
-- access check, so a coach turn made 10 calls (32 in a new server instance). read_skill_package gains one optional
-- argument, p_paths: with it, a single call performs exactly the same checks as before (active actor, active module
-- bound to the Skill, published directory Skill, the requested revision and package hash, revision not revoked) and,
-- in the same statement, returns every requested file. An empty array is the access check alone.
-- Without p_paths the function behaves exactly as in 0064, so every existing SQL caller (positional, 6 or 7 arguments)
-- and the previous application code keep working unchanged.
-- The signature changes, so the old function is dropped and recreated in this transaction; plpgsql callers resolve the
-- name at call time. Grants are restored as in 0064 (service_role only). Repeatable: the DROP is then a no-op and
-- CREATE OR REPLACE rewrites the same function.
-- Rollback: recreate the 0064 definition (DROP this 8-argument function, run the 0064 CREATE and its grant block) and
-- deploy the code before PR-4. No table or stored data changes.
DROP FUNCTION IF EXISTS public.read_skill_package(uuid,uuid,uuid,uuid,text,text,integer);
CREATE OR REPLACE FUNCTION public.read_skill_package(p_actor_id uuid,p_module_id uuid,p_skill_id uuid,
  p_revision_id uuid DEFAULT NULL,p_package_hash text DEFAULT NULL,p_path text DEFAULT NULL,p_max_bytes integer DEFAULT 2097152,
  p_paths text[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p public.skill_packages%ROWTYPE; f public.skill_package_files%ROWTYPE; files jsonb:='{}'; total bigint:=0;
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
  IF p_paths IS NOT NULL THEN
    -- A batch is bound to one exact package (revision and hash) and to a whole, distinct path list.
    IF p_revision_id IS NULL OR p_package_hash IS NULL OR p_path IS NOT NULL OR cardinality(p_paths)>64
      OR array_position(p_paths,NULL) IS NOT NULL
      OR (SELECT count(DISTINCT x) FROM unnest(p_paths) x)<>cardinality(p_paths) THEN RAISE EXCEPTION 'resource unavailable'; END IF;
    FOR f IN SELECT * FROM public.skill_package_files WHERE revision_id=p.revision_id AND path=ANY(p_paths) LOOP
      total:=total+octet_length(f.bytes);
      files:=files||jsonb_build_object(f.path,replace(encode(f.bytes,'base64'),E'\n',''));
    END LOOP;
    -- Every requested file must exist and all of them together fit the caller's bound.
    IF (SELECT count(*) FROM jsonb_object_keys(files))<>cardinality(p_paths)
      OR p_max_bytes IS NULL OR p_max_bytes<0 OR total>p_max_bytes THEN RAISE EXCEPTION 'resource unavailable'; END IF;
    RETURN jsonb_build_object('files',files);
  END IF;
  IF p_path IS NULL THEN RETURN p.manifest; END IF;
  IF p_path='' THEN RETURN 'true'::jsonb; END IF;
  SELECT * INTO f FROM public.skill_package_files WHERE revision_id=p.revision_id AND path=p_path;
  IF NOT FOUND OR p_max_bytes IS NULL OR p_max_bytes<0 OR octet_length(f.bytes)>p_max_bytes THEN RAISE EXCEPTION 'resource unavailable'; END IF;
  RETURN to_jsonb(replace(encode(f.bytes,'base64'),E'\n',''));
END $$;
REVOKE ALL ON FUNCTION public.read_skill_package(uuid,uuid,uuid,uuid,text,text,integer,text[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.read_skill_package(uuid,uuid,uuid,uuid,text,text,integer,text[]) TO service_role;
