/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- FUSION-REVIEW PR-4b: read-only helpers for the review flow. Number allocated by the controller.
-- All functions are service-role only with a fixed search_path. Only the administrator breaker clear writes
-- (marks rows; never deletes).
BEGIN;

-- Administrator unblock of the version breaker (Owner 2026-10-14 "边用边调"; 总控 2026-10-14): failed reviews of one
-- version can be marked as not counting, with a reason. Nothing is deleted; the marking is the audit record:
-- who, when, why and which reviews (one batch id per action).
-- Per-section adoption (Owner 2026-10-14 "评审结果逐章选择采用修订版或保留原文"): the user's choice, written once.
ALTER TABLE public.fusion_reviews ADD COLUMN IF NOT EXISTS adoption jsonb;
ALTER TABLE public.fusion_reviews ADD COLUMN IF NOT EXISTS breaker_cleared_at timestamptz,
  ADD COLUMN IF NOT EXISTS breaker_cleared_by uuid,
  ADD COLUMN IF NOT EXISTS breaker_clear_reason text,
  ADD COLUMN IF NOT EXISTS breaker_clear_batch uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fusion_reviews_breaker_clear_complete') THEN
    ALTER TABLE public.fusion_reviews ADD CONSTRAINT fusion_reviews_breaker_clear_complete CHECK (
      (breaker_cleared_at IS NULL AND breaker_cleared_by IS NULL AND breaker_clear_reason IS NULL AND breaker_clear_batch IS NULL)
      OR (breaker_cleared_at IS NOT NULL AND breaker_cleared_by IS NOT NULL AND breaker_clear_batch IS NOT NULL
        AND char_length(btrim(breaker_clear_reason)) BETWEEN 1 AND 500));
  END IF;
END $$;


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

-- Source and preview are VOLATILE: the actor and readability checks they call take row locks (FOR SHARE),
-- which PostgREST refuses for STABLE functions (it runs those in a read-only transaction).
-- The frozen inputs of a review, read from its own immutable version: the reviewed report body, the
-- template sections and length, and the declared steps and fields. Refused once the version is erased.
CREATE OR REPLACE FUNCTION public.fusion_review_source(p_actor_id uuid, p_review_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
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

-- Sizes of a version before a review starts, for the worst-case estimate and context check: report bytes,
-- confirmed-field bytes and the number of declared fields. Same ownership and readability rules as start.
CREATE OR REPLACE FUNCTION public.fusion_review_preview(p_actor_id uuid, p_draft_id uuid, p_source_version_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts; ver artifact_versions; r artifact_rounds;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
  SELECT * INTO ver FROM artifact_versions WHERE id=p_source_version_id AND project_id=d.project_id AND erased_at IS NULL;
  SELECT * INTO r FROM artifact_rounds WHERE id=ver.round_id;
  IF d.draft_id IS NULL OR ver.id IS NULL OR r.id IS NULL OR NOT content_erasure_artifact_readable(p_actor_id,ver.id) THEN
    RAISE EXCEPTION 'FUSION_REVIEW_STALE'; END IF;
  RETURN jsonb_build_object('reportBytes',octet_length(coalesce(ver.report#>>'{generatedReport,body}','')),
    'materialsBytes',octet_length(coalesce((SELECT jsonb_object_agg(s.key,s.value->'information') FROM jsonb_each(r.steps) s),'{}')::text),
    'fieldCount',(SELECT count(*) FROM jsonb_array_elements(r.workflow->'steps') st,
      jsonb_array_elements(coalesce(st->'information','[]')) i));
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

-- The review view also names each call's model (the flow re-claims only models without a finished call) and
-- its dispatch and settlement times (the progress events are ordered by them).
-- Same signature and grants as 0236.
CREATE OR REPLACE FUNCTION public.fusion_review_view(rv fusion_reviews) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('reviewId',rv.id,'state',rv.state,'round',rv.round,'phase',rv.phase,'attempt',rv.attempt,
    'draftId',rv.draft_id,'sourceVersionId',rv.source_version_id,'sourceSessionId',rv.source_session_id,
    'versionHash',rv.version_hash,'materials',rv.materials,'materialsHash',rv.materials_hash,'config',rv.config,
    'steps',rv.steps,'outcome',rv.outcome,'revisionId',rv.revision_id,'endedAt',rv.ended_at,'adoption',rv.adoption,
    -- Per call: its run, verdict and whether it settled, for continueReview.
    'calls',coalesce((SELECT jsonb_agg(jsonb_build_object('groupId',br.fusion_group_id,'runId',br.id,'callId',c.id,'modelId',br.payload->>'modelId',
      'phase',c.payload->>'phase','dispatched',c.dispatched_at IS NOT NULL,'verdict',c.fusion_verdict,
      'settled',c.settled_at IS NOT NULL,'state',c.state,'dispatchedAt',c.dispatched_at,'settledAt',c.settled_at) ORDER BY c.created_at,c.id)
      FROM bill2_runs br JOIN bill2_calls c ON c.run_id=br.id
      WHERE br.actor_id=rv.actor_id AND br.fusion_group_id IN (SELECT (x->>'groupId')::uuid FROM jsonb_array_elements(rv.steps) x)),'[]'));
$$;

-- Administrators look back at real reviews to tune the panel (Owner 2026-10-14 "边用边调"). Newest first, keyset
-- paged by (created_at, id); totals are provider cost and credits charged. Bodies are only in the single read.
CREATE OR REPLACE FUNCTION public.fusion_review_admin_list(p_limit integer, p_before_created timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT coalesce(jsonb_agg(x ORDER BY (x->>'createdAt')::timestamptz DESC, x->>'reviewId' DESC),'[]') FROM (
    SELECT jsonb_build_object('reviewId',rv.id,'actorId',rv.actor_id,'draftId',rv.draft_id,'state',rv.state,'outcome',rv.outcome,
      'round',rv.round,'createdAt',rv.created_at,'endedAt',rv.ended_at,'sourceVersionId',rv.source_version_id,
      'breakerCleared',CASE WHEN rv.breaker_cleared_at IS NULL THEN NULL ELSE jsonb_build_object('at',rv.breaker_cleared_at,
        'by',rv.breaker_cleared_by,'reason',rv.breaker_clear_reason,'batch',rv.breaker_clear_batch) END,'reviewers',rv.config->'reviewers','summary',rv.config->'summary',
      'costUsd',coalesce((SELECT sum(coalesce(c.selected_cost_usd,0)) FROM bill2_runs br JOIN bill2_calls c ON c.run_id=br.id
        WHERE br.actor_id=rv.actor_id AND br.fusion_group_id IN (SELECT (s->>'groupId')::uuid FROM jsonb_array_elements(rv.steps) s)),0),
      'chargedCredits',coalesce((SELECT sum(coalesce(br.charged,0)) FROM bill2_runs br
        WHERE br.actor_id=rv.actor_id AND br.fusion_group_id IN (SELECT (s->>'groupId')::uuid FROM jsonb_array_elements(rv.steps) s)),0)) x
    FROM fusion_reviews rv
    WHERE p_before_created IS NULL OR (rv.created_at,rv.id)<(p_before_created,coalesce(p_before_id,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
    ORDER BY rv.created_at DESC, rv.id DESC LIMIT least(greatest(coalesce(p_limit,20),1),100)) q;
$$;

-- One review with every call's saved output and cost, for the administrator's look-back. Outputs already erased
-- with the draft or account are simply absent.
CREATE OR REPLACE FUNCTION public.fusion_review_admin_read(p_review_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT fusion_review_view(rv)||jsonb_build_object('actorId',rv.actor_id,'createdAt',rv.created_at,'outputs',
    coalesce((SELECT jsonb_agg(jsonb_build_object('callId',c.id,'costUsd',c.selected_cost_usd,'body',o.body) ORDER BY c.created_at,c.id)
      FROM bill2_runs br JOIN bill2_calls c ON c.run_id=br.id LEFT JOIN fusion_call_outputs o ON o.call_id=c.id
      WHERE br.actor_id=rv.actor_id AND br.fusion_group_id IN (SELECT (s->>'groupId')::uuid FROM jsonb_array_elements(rv.steps) s)),'[]'))
  FROM fusion_reviews rv WHERE rv.id=p_review_id;
$$;

-- Version breaker counts only unmarked reviews. Anchor patch of the live definition (not a full redefinition),
-- so guards other migrations inject into fusion_review_start (0249 read-only drafts) are kept. Idempotent; refuses
-- loudly when neither the original nor the patched condition is found.
DO $$ DECLARE source text; patched text;
  old_cond text:='SELECT state FROM fusion_reviews WHERE source_version_id=ver.id
      ORDER BY created_at DESC LIMIT 3';
  new_cond text:='SELECT state FROM fusion_reviews WHERE source_version_id=ver.id AND breaker_cleared_at IS NULL
      ORDER BY created_at DESC LIMIT 3';
BEGIN
  source:=pg_get_functiondef('public.fusion_review_start(uuid,uuid,uuid,uuid,jsonb)'::regprocedure);
  IF position(new_cond IN source)=0 THEN
    IF position(old_cond IN source)=0 THEN RAISE EXCEPTION 'FUSION_REVIEW_START_SOURCE_MISMATCH'; END IF;
    patched:=replace(source,old_cond,new_cond);
    EXECUTE patched;
  END IF;
  IF position(new_cond IN pg_get_functiondef('public.fusion_review_start(uuid,uuid,uuid,uuid,jsonb)'::regprocedure))=0 THEN
    RAISE EXCEPTION 'FUSION_REVIEW_BREAKER_PATCH_MISSING'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fusion_review_breaker_clear(p_admin_id uuid, p_source_version_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE batch uuid:=gen_random_uuid(); ids jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id=p_admin_id AND role='admin' AND status='active' AND is_deleted::text='false') THEN
    RAISE EXCEPTION 'FUSION_ADMIN_REQUIRED'; END IF;
  IF p_source_version_id IS NULL OR char_length(btrim(coalesce(p_reason,''))) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'FUSION_REVIEW_INVALID'; END IF;
  -- Only ended failures of this one version that still count; running and successful reviews are never touched.
  WITH marked AS (
    UPDATE fusion_reviews SET breaker_cleared_at=clock_timestamp(), breaker_cleared_by=p_admin_id,
      breaker_clear_reason=btrim(p_reason), breaker_clear_batch=batch
    WHERE source_version_id=p_source_version_id AND state IN ('incomplete','revision_failed') AND breaker_cleared_at IS NULL
    RETURNING id, created_at)
  SELECT coalesce(jsonb_agg(id ORDER BY created_at, id),'[]') INTO ids FROM marked;
  RETURN jsonb_build_object('batch',batch,'sourceVersionId',p_source_version_id,'reviewIds',ids,'reason',btrim(p_reason));
END $$;

-- Records the user's per-section choice once, for a completed review whose summary passed. The same request
-- returns the same record; another request after the first is refused. Who and when are set here, so the
-- choice is auditable: sections adopted and kept, wording-only confirmations, the R14 revision and new version.
CREATE OR REPLACE FUNCTION public.fusion_review_adoption_record(p_actor_id uuid, p_review_id uuid, p_adoption jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rv fusion_reviews;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  SELECT * INTO rv FROM fusion_reviews WHERE id=p_review_id AND actor_id=p_actor_id FOR UPDATE NOWAIT;
  IF rv.id IS NULL THEN RAISE EXCEPTION 'FUSION_REVIEW_DENIED'; END IF;
  IF jsonb_typeof(p_adoption) IS DISTINCT FROM 'object' OR coalesce(p_adoption->>'requestId','')!~'^[0-9a-f-]{36}$'
    OR jsonb_typeof(p_adoption->'choices') IS DISTINCT FROM 'array' OR octet_length(p_adoption::text)>65536 THEN
    RAISE EXCEPTION 'FUSION_REVIEW_INVALID'; END IF;
  IF rv.adoption IS NOT NULL THEN
    IF rv.adoption->>'requestId' IS DISTINCT FROM p_adoption->>'requestId' THEN RAISE EXCEPTION 'FUSION_REVIEW_ADOPTED'; END IF;
    RETURN fusion_review_view(rv);
  END IF;
  IF rv.state IS DISTINCT FROM 'completed' OR rv.outcome->>'kind' IS DISTINCT FROM 'revised' THEN RAISE EXCEPTION 'FUSION_REVIEW_INVALID'; END IF;
  UPDATE fusion_reviews SET adoption=p_adoption||jsonb_build_object('by',p_actor_id,'at',clock_timestamp()),updated_at=clock_timestamp()
  WHERE id=rv.id RETURNING * INTO rv;
  RETURN fusion_review_view(rv);
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['fusion_review_skill_file(uuid,uuid,text,text)','fusion_review_source(uuid,uuid)',
    'fusion_review_preview(uuid,uuid,uuid)','fusion_review_admin_list(integer,timestamptz,uuid)','fusion_review_admin_read(uuid)',
    'fusion_review_breaker_clear(uuid,uuid,text)','fusion_review_adoption_record(uuid,uuid,jsonb)',
    'fusion_review_unjudged(integer)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;
COMMIT;
