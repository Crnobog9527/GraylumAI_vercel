-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- REPORT-VERSION-MARKS (number 0455 = staging's highest + 1): fusionReview.versionMarks reads through a function.
-- The server read opc_drafts, artifact_versions and fusion_reviews as service_role, which has no SELECT on them (staging,
-- 2026-11-02: HTTP 400 on every open of a full report; the router mapped the permission error to FUSION_REVIEW_UNAVAILABLE).
-- fusion_version_marks_read returns the same rows the three reads did: the caller's own drafts (any other or unknown draft is
-- refused, FUSION_VERSION_MARKS_DENIED), the versions of their projects plus the extra version ids, and the caller's own reviews of them.
-- Compatible: a new function only; old code never calls it, the new code before this migration fails as it does today.
-- Repeatable: CREATE OR REPLACE. Recovery: DROP FUNCTION public.fusion_version_marks_read(uuid,uuid[],uuid[]); no data is written.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.fusion_version_marks_read(p_actor_id uuid, p_draft_ids uuid[], p_version_ids uuid[] DEFAULT '{}')
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  ids uuid[] := ARRAY(SELECT DISTINCT d FROM unnest(coalesce(p_draft_ids,'{}')) d);
  extra uuid[] := ARRAY(SELECT DISTINCT v FROM unnest(coalesce(p_version_ids,'{}')) v);
  projects uuid[];
BEGIN
  IF p_actor_id IS NULL OR cardinality(ids) = 0 OR cardinality(ids) > 500 OR cardinality(extra) > 2000 THEN
    RAISE EXCEPTION 'FUSION_VERSION_MARKS_DENIED' USING ERRCODE = '42501';
  END IF;
  SELECT array_agg(DISTINCT project_id) INTO projects FROM opc_drafts WHERE actor_id = p_actor_id AND draft_id = ANY(ids);
  IF (SELECT count(*) FROM opc_drafts WHERE actor_id = p_actor_id AND draft_id = ANY(ids)) <> cardinality(ids) THEN
    RAISE EXCEPTION 'FUSION_VERSION_MARKS_DENIED' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'versions', coalesce((SELECT jsonb_agg(jsonb_build_object('id', x.id, 'source', x.source, 'from', x.src_from)) FROM (
      SELECT v.id, v.report->'generatedReport'->>'source' AS source, v.report->'generatedReport'->>'sourceVersionId' AS src_from
      FROM artifact_versions v WHERE v.erased_at IS NULL AND (v.project_id = ANY(projects) OR v.id = ANY(extra)) LIMIT 5000) x), '[]'::jsonb),
    'reviews', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'draft_id', r.draft_id, 'source_version_id', r.source_version_id,
        'state', r.state, 'ended_at', r.ended_at, 'adoption', r.adoption, 'created_at', r.created_at) ORDER BY r.created_at DESC, r.id DESC)
      FROM (SELECT * FROM fusion_reviews WHERE actor_id = p_actor_id AND (project_id = ANY(projects) OR source_version_id = ANY(extra))
        ORDER BY created_at DESC, id DESC LIMIT 5000) r), '[]'::jsonb));
END $function$;

REVOKE ALL ON FUNCTION public.fusion_version_marks_read(uuid,uuid[],uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fusion_version_marks_read(uuid,uuid[],uuid[]) TO service_role;
COMMIT;
