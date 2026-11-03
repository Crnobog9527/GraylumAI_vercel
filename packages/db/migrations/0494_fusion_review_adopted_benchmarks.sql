-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- FUSION-REVIEW (jury input, 0494): fusion_review_source also returns
-- adoptedBenchmarks, the benchmark accounts the report actually adopted with the numbers and fetch time the host attached when the
-- report was finalized (artifact_versions.report #> generatedReport.data.data.benchmarks.accounts: platform, account, metrics). The report
-- text carries only account names; before this the reviewers had nothing to check a benchmark against except the draft's
-- free-text materials, which still hold links the user wrote before (and ones that failed to load), so a fetched account could be
-- called unverified next to them. Three states: a list (stored data, accounts adopted), an empty list (stored data, none adopted) and
-- null (no stored data, e.g. a report finalized earlier: unknown, which says nothing about whether benchmarks were used).
-- Compatibility: one more key in the returned object; the deployed app's source schema ignores unknown keys (zod object), and the new
-- app reads a missing key as unknown. Repeatable: CREATE OR REPLACE only.
-- Recovery: re-apply the previous fusion_review_source (packages/db/functions history); nothing is stored.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.fusion_review_source(p_actor_id uuid, p_review_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE rv fusion_reviews; ver artifact_versions; r artifact_rounds; accounts jsonb;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  SELECT * INTO rv FROM fusion_reviews WHERE id=p_review_id AND actor_id=p_actor_id;
  SELECT * INTO ver FROM artifact_versions WHERE id=rv.source_version_id AND erased_at IS NULL;
  SELECT * INTO r FROM artifact_rounds WHERE id=ver.round_id;
  IF rv.id IS NULL OR ver.id IS NULL OR r.id IS NULL OR ver.report_hash IS DISTINCT FROM rv.version_hash
    OR NOT content_erasure_artifact_readable(p_actor_id,ver.id) THEN RAISE EXCEPTION 'FUSION_REVIEW_STALE'; END IF;
  accounts:=ver.report#>'{generatedReport,data,data,benchmarks,accounts}';
  RETURN jsonb_build_object('body',ver.report#>>'{generatedReport,body}',
    'sections',r.workflow#>'{reportGeneration,sections}','maxCharacters',r.workflow#>'{reportGeneration,maxCharacters}',
    'declared',coalesce((SELECT jsonb_agg(jsonb_build_object('stepId',st->>'id','fieldIds',
      coalesce((SELECT jsonb_agg(i->>'id') FROM jsonb_array_elements(coalesce(st->'information','[]')) i),'[]'))
      ORDER BY o) FROM jsonb_array_elements(r.workflow->'steps') WITH ORDINALITY x(st,o)),'[]'),
    'adoptedBenchmarks',CASE WHEN jsonb_typeof(ver.report#>'{generatedReport,data,data}')='object' THEN
      coalesce((SELECT jsonb_agg(jsonb_build_object('platform',a->>'platform','account',a->>'account',
        'metrics',CASE WHEN jsonb_typeof(a->'metrics')='object' THEN a->'metrics' ELSE NULL END))
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(accounts)='array' THEN accounts ELSE '[]'::jsonb END) a
        WHERE jsonb_typeof(a)='object'),'[]'::jsonb) END);
END $function$;
COMMIT;
