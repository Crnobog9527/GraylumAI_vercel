/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- FUSION-REVIEW PR-4b: read-only helpers for the review flow. Number allocated by the controller.
-- All three are service-role only with a fixed search_path; none writes anything.
BEGIN;

-- The review Skill is uploaded through the existing Skill publication but is not attached to any module, so
-- read_skill_package (which requires an active module) cannot read it. This reader returns a file only when
-- the Skill id, the revision id and the package hash all match a published, non-revoked package.
-- p_path NULL returns the manifest; otherwise the file bytes as base64.
CREATE OR REPLACE FUNCTION public.fusion_review_skill_file(p_skill_id uuid, p_revision_id uuid, p_package_hash text,
  p_path text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pk skill_packages; f skill_package_files;
BEGIN
  IF p_skill_id IS NULL OR p_revision_id IS NULL OR coalesce(p_package_hash,'')!~'^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'FUSION_REVIEW_SKILL_UNAVAILABLE'; END IF;
  SELECT p.* INTO pk FROM skill_packages p JOIN skill_revisions r ON r.id=p.revision_id JOIN skills s ON s.id=p.skill_id
    WHERE p.revision_id=p_revision_id AND p.skill_id=p_skill_id AND r.skill_id=p_skill_id AND p.package_hash=p_package_hash
      AND s.status='published' AND s.content_kind='directory'
      AND NOT EXISTS(SELECT 1 FROM skill_revision_revocations v WHERE v.revision_id=r.id);
  IF pk.revision_id IS NULL THEN RAISE EXCEPTION 'FUSION_REVIEW_SKILL_UNAVAILABLE'; END IF;
  IF p_path IS NULL THEN RETURN pk.manifest; END IF;
  SELECT * INTO f FROM skill_package_files WHERE revision_id=pk.revision_id AND path=p_path;
  IF f.revision_id IS NULL OR octet_length(f.bytes)>262144 THEN RAISE EXCEPTION 'FUSION_REVIEW_SKILL_UNAVAILABLE'; END IF;
  RETURN to_jsonb(replace(encode(f.bytes,'base64'),E'\n',''));
END $$;

-- The frozen inputs of a review, read from its own immutable version: the reviewed report body, the
-- template sections and length, and the declared steps and fields. Refused once the version is erased.
CREATE OR REPLACE FUNCTION public.fusion_review_source(p_actor_id uuid, p_review_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rv fusion_reviews; ver artifact_versions; r artifact_rounds;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  SELECT * INTO rv FROM fusion_reviews WHERE id=p_review_id AND actor_id=p_actor_id;
  SELECT * INTO ver FROM artifact_versions WHERE id=rv.source_version_id AND erased_at IS NULL;
  SELECT * INTO r FROM artifact_rounds WHERE id=ver.round_id;
  IF rv.id IS NULL OR ver.id IS NULL OR r.id IS NULL OR ver.report_hash IS DISTINCT FROM rv.version_hash
    OR NOT content_erasure_artifact_readable(p_actor_id,ver.id) THEN RAISE EXCEPTION 'FUSION_REVIEW_STALE'; END IF;
  RETURN jsonb_build_object('body',ver.report#>>'{generatedReport,body}',
    'sections',r.workflow#>'{reportGeneration,sections}','maxCharacters',r.workflow#>'{reportGeneration,maxCharacters}',
    'declared',coalesce((SELECT jsonb_agg(jsonb_build_object('stepId',st->>'id','fieldIds',
      coalesce((SELECT jsonb_agg(i->>'id') FROM jsonb_array_elements(coalesce(st->'information','[]')) i),'[]'))
      ORDER BY o) FROM jsonb_array_elements(r.workflow->'steps') WITH ORDINALITY x(st,o)),'[]'));
END $$;

-- Recovery (§3.3): calls of reviews in progress or ended whose body was saved but never judged. The
-- caller redoes the frozen host check and writes the verdict before settlement.
CREATE OR REPLACE FUNCTION public.fusion_review_unjudged(p_limit integer)
RETURNS TABLE(actor_id uuid, review_id uuid, call_id uuid, run_id uuid, phase text, round integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT rv.actor_id, rv.id, c.id, br.id, c.payload->>'phase', (x->>'round')::int
  FROM fusion_reviews rv CROSS JOIN LATERAL jsonb_array_elements(rv.steps) x
  JOIN bill2_runs br ON br.fusion_group_id=(x->>'groupId')::uuid AND br.actor_id=rv.actor_id
  JOIN bill2_calls c ON c.run_id=br.id
  WHERE c.fusion_verdict IS NULL AND c.settled_at IS NULL AND EXISTS(SELECT 1 FROM fusion_call_outputs o WHERE o.call_id=c.id)
  ORDER BY c.created_at, c.id LIMIT least(greatest(coalesce(p_limit,50),1),200);
$$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['fusion_review_skill_file(uuid,uuid,text,text)','fusion_review_source(uuid,uuid)',
    'fusion_review_unjudged(integer)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;
COMMIT;
