/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- FUSION-REVIEW PR-4a: the review record (FUSION-REVIEW §2.1, §3.3, §6 PR-4).
-- One row per review plus each round/phase step. Why a table: review progress (round, phase, each
-- step's group, final revision) is product state; bill2_runs holds money only, R14 keeps revisions in
-- artifact_requests, runtime_executions is per execution. No queue and no new scheduled job.
-- Lock order everywhere: review row -> runs -> balance (the group claim below runs inside the review lock).
BEGIN;

CREATE TABLE IF NOT EXISTS public.fusion_reviews (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT fusion_reviews_pk PRIMARY KEY,
  actor_id uuid NOT NULL CONSTRAINT fusion_reviews_actor_ref REFERENCES public.profiles(id),
  request_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  project_id uuid NOT NULL,
  source_session_id uuid NOT NULL,
  source_version_id uuid NOT NULL,
  version_hash text NOT NULL,
  -- Frozen copy of the confirmed fields of the reviewed version: {stepId: {fieldId: {value, status}}}.
  materials jsonb NOT NULL,
  materials_hash text NOT NULL CHECK (materials_hash ~ '^[a-f0-9]{64}$'),
  -- Frozen settings: models, rounds, output limits, review Skill identity, estimate.
  config jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('running','paused','stopped','interrupted','revision_failed','incomplete','completed')),
  round integer NOT NULL CHECK (round >= 1),
  phase text NOT NULL CHECK (phase IN ('review','summary')),
  attempt integer NOT NULL CHECK (attempt >= 1),
  -- [{round, phase, attempt, groupId, stepKey, claimedAt}] in order.
  steps jsonb NOT NULL DEFAULT '[]',
  outcome jsonb,
  revision_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  CONSTRAINT fusion_reviews_request_unique UNIQUE (actor_id, request_id),
  CHECK (octet_length(materials::text) <= 262144 AND octet_length(config::text) <= 65536 AND octet_length(steps::text) <= 65536)
);
-- One review in progress per user (paused still counts, FUSION-REVIEW §2.1).
CREATE UNIQUE INDEX IF NOT EXISTS fusion_reviews_active ON public.fusion_reviews(actor_id) WHERE state IN ('running','paused');
CREATE INDEX IF NOT EXISTS fusion_reviews_version_idx ON public.fusion_reviews(source_version_id, created_at);
ALTER TABLE public.fusion_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fusion_reviews FROM PUBLIC, anon, authenticated, service_role;

-- Review mode switch and membership permission, read inside the calling transaction (same rules as
-- fusion_group_admit). Returns the stored settings.
CREATE OR REPLACE FUNCTION public.fusion_review_settings(a uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v jsonb; member_level text;
BEGIN
  SELECT value INTO v FROM system_settings WHERE key='fusion_settings';
  IF jsonb_typeof(v)='string' THEN v:=(v#>>'{}')::jsonb; END IF;
  IF v#>>'{review,enabled}' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'FUSION_REVIEW_DISABLED'; END IF;
  PERFORM report_membership_check(a);
  SELECT membership_level INTO member_level FROM profiles WHERE id=a;
  IF NOT EXISTS(SELECT 1 FROM membership_plans mp WHERE mp.level=member_level AND mp.allow_fusion_review) THEN
    RAISE EXCEPTION 'FUSION_MEMBERSHIP_REQUIRED'; END IF;
  RETURN v;
END $$;

-- Platform-borne outcomes of the last 7 days (§3.3 breaker): zero-charge verdicts and their provider cost.
CREATE OR REPLACE FUNCTION public.fusion_review_breaker_usage(a uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object(
    'noDeliveryCalls', count(*) FILTER (WHERE c.fusion_verdict='no_delivery'),
    'platformUsd', coalesce(sum(coalesce(c.selected_cost_usd,0)) FILTER (WHERE c.fusion_verdict IN
      ('no_delivery','format_invalid','revision_invalid','erased_before_verdict')),0))
  FROM bill2_calls c JOIN bill2_runs r ON r.id=c.run_id
  WHERE r.actor_id=a AND r.fusion_group_id IS NOT NULL AND c.created_at>=clock_timestamp()-interval '7 days';
$$;

-- A dispatched Fusion call still in flight: unsettled and still automatically recoverable. Once its lookup
-- budget is spent or its recovery deadline passed it waits for manual review and no longer occupies the
-- user's review slot (its own hold is kept, FUSION-REVIEW §3.3).
CREATE OR REPLACE FUNCTION public.fusion_call_in_flight(c bill2_calls) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT c.dispatched_at IS NOT NULL AND c.settled_at IS NULL AND c.recovery_attempts<3
    AND clock_timestamp()<=coalesce(c.recovery_deadline,c.created_at+interval '24 hours');
$$;

-- Start a review of the current formal version. Idempotent by request. Refuses: switch off, no
-- permission, a stale version, another review in progress or any dispatched Fusion call not yet settled
-- (in-flight risk counts, §3.3), the breaker, a version that ended in failure 3 times in a row, and an
-- estimate above the configured single-review budget. The materials are copied here from the
-- version's own round, never taken from the caller.
CREATE OR REPLACE FUNCTION public.fusion_review_start(p_actor_id uuid, p_request_id uuid, p_draft_id uuid,
  p_source_version_id uuid, p_config jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rv fusion_reviews; d opc_drafts; p artifact_projects; r artifact_rounds; ver artifact_versions; v jsonb;
  usage jsonb; m jsonb; h text;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('fusion-review:'||p_actor_id::text,0));
  SELECT * INTO rv FROM fusion_reviews WHERE actor_id=p_actor_id AND request_id=p_request_id;
  IF rv.id IS NOT NULL THEN
    IF rv.draft_id<>p_draft_id OR rv.source_version_id<>p_source_version_id THEN RAISE EXCEPTION 'FUSION_REVIEW_CONFLICT'; END IF;
    RETURN fusion_review_view(rv);
  END IF;
  IF jsonb_typeof(p_config) IS DISTINCT FROM 'object' OR coalesce(p_config->>'estimateUsd','')!~'^[0-9]+(\.[0-9]+)?$' THEN
    RAISE EXCEPTION 'FUSION_REVIEW_INVALID'; END IF;
  v:=fusion_review_settings(p_actor_id);
  SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
  SELECT * INTO p FROM artifact_projects WHERE id=d.project_id FOR SHARE;
  SELECT * INTO ver FROM artifact_versions WHERE id=p_source_version_id AND project_id=p.id AND erased_at IS NULL;
  SELECT * INTO r FROM artifact_rounds WHERE id=ver.round_id AND project_id=p.id;
  -- The same freshness rule as R14 propose: only the current formal version from a generated report.
  IF d.draft_id IS NULL OR p.id IS NULL OR ver.id IS NULL OR r.state IS DISTINCT FROM 'published' OR d.round_id IS DISTINCT FROM r.id
    OR ver.version IS DISTINCT FROM p.current_version OR NOT coalesce(ver.report ? 'generatedReport',false)
    OR NOT content_erasure_artifact_readable(p_actor_id,ver.id) THEN RAISE EXCEPTION 'FUSION_REVIEW_STALE'; END IF;
  IF EXISTS(SELECT 1 FROM fusion_reviews WHERE actor_id=p_actor_id AND state IN ('running','paused'))
    OR EXISTS(SELECT 1 FROM bill2_calls c JOIN bill2_runs br ON br.id=c.run_id WHERE br.actor_id=p_actor_id
      AND br.fusion_group_id IS NOT NULL AND fusion_call_in_flight(c)) THEN
    RAISE EXCEPTION 'FUSION_REVIEW_ACTIVE'; END IF;
  usage:=fusion_review_breaker_usage(p_actor_id);
  IF (usage->>'noDeliveryCalls')::int>=coalesce((v#>>'{review,breaker,noDeliveryCalls}')::int,10)
    OR (usage->>'platformUsd')::numeric>=coalesce((v#>>'{review,breaker,platformUsd}')::numeric,2) THEN
    RAISE EXCEPTION 'FUSION_REVIEW_BREAKER'; END IF;
  IF (SELECT count(*) FROM (SELECT state FROM fusion_reviews WHERE source_version_id=ver.id
      ORDER BY created_at DESC LIMIT 3) last3 WHERE state IN ('incomplete','revision_failed'))=3 THEN
    RAISE EXCEPTION 'FUSION_REVIEW_VERSION_BLOCKED'; END IF;
  IF coalesce(v#>>'{review,maxBudgetUsd}','')='' OR (p_config->>'estimateUsd')::numeric>(v#>>'{review,maxBudgetUsd}')::numeric THEN
    RAISE EXCEPTION 'FUSION_BUDGET_EXCEEDED'; END IF;
  SELECT coalesce(jsonb_object_agg(s.key,(SELECT coalesce(jsonb_object_agg(f.key,jsonb_build_object('value',f.value->'value',
      'status',f.value->'status')),'{}') FROM jsonb_each(coalesce(s.value->'information','{}')) f)),'{}')
    INTO m FROM jsonb_each(r.steps) s;
  h:=encode(sha256(convert_to(m::text,'UTF8')),'hex');
  INSERT INTO fusion_reviews(actor_id,request_id,draft_id,project_id,source_session_id,source_version_id,version_hash,
    materials,materials_hash,config,state,round,phase,attempt)
  VALUES(p_actor_id,p_request_id,d.draft_id,p.id,d.session_id,ver.id,ver.report_hash,m,h,p_config,'running',1,'review',1)
  RETURNING * INTO rv;
  RETURN fusion_review_view(rv);
END $$;

CREATE OR REPLACE FUNCTION public.fusion_review_view(rv fusion_reviews) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('reviewId',rv.id,'state',rv.state,'round',rv.round,'phase',rv.phase,'attempt',rv.attempt,
    'draftId',rv.draft_id,'sourceVersionId',rv.source_version_id,'sourceSessionId',rv.source_session_id,
    'versionHash',rv.version_hash,'materials',rv.materials,'materialsHash',rv.materials_hash,'config',rv.config,
    'steps',rv.steps,'outcome',rv.outcome,'revisionId',rv.revision_id,'endedAt',rv.ended_at,
    -- Per call: its run, verdict and whether it settled, for continueReview.
    'calls',coalesce((SELECT jsonb_agg(jsonb_build_object('groupId',br.fusion_group_id,'runId',br.id,'callId',c.id,
      'phase',c.payload->>'phase','dispatched',c.dispatched_at IS NOT NULL,'verdict',c.fusion_verdict,
      'settled',c.settled_at IS NOT NULL,'state',c.state) ORDER BY c.created_at,c.id)
      FROM bill2_runs br JOIN bill2_calls c ON c.run_id=br.id
      WHERE br.actor_id=rv.actor_id AND br.fusion_group_id IN (SELECT (x->>'groupId')::uuid FROM jsonb_array_elements(rv.steps) x)),'[]'));
$$;

CREATE OR REPLACE FUNCTION public.fusion_review_read(p_actor_id uuid, p_review_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rv fusion_reviews;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  SELECT * INTO rv FROM fusion_reviews WHERE id=p_review_id AND actor_id=p_actor_id;
  IF rv.id IS NULL THEN RETURN NULL; END IF;
  RETURN fusion_review_view(rv);
END $$;

-- The group claim of one step, inside the review lock: a stopped or otherwise ended review never gets a
-- new call, and a stop that commits first makes this refuse (§3.3 停止). Paused resumes to running.
-- The step must be the review's current position; the group must be bound to the review's conversation.
CREATE OR REPLACE FUNCTION public.fusion_review_claim(p_actor_id uuid, p_review_id uuid, p_round integer, p_phase text,
  p_attempt integer, p_group_id uuid, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rv fusion_reviews; g fusion_billing_groups; k text; res jsonb;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  SELECT * INTO rv FROM fusion_reviews WHERE id=p_review_id AND actor_id=p_actor_id FOR UPDATE;
  IF rv.id IS NULL THEN RAISE EXCEPTION 'FUSION_REVIEW_DENIED'; END IF;
  IF rv.state NOT IN ('running','paused') THEN RAISE EXCEPTION 'FUSION_REVIEW_ENDED'; END IF;
  IF rv.round<>p_round OR rv.phase<>p_phase OR rv.attempt<>p_attempt THEN RAISE EXCEPTION 'FUSION_REVIEW_STEP_CONFLICT'; END IF;
  SELECT * INTO g FROM fusion_billing_groups WHERE id=p_group_id AND actor_id=p_actor_id;
  IF g.id IS NULL OR g.kind<>'review' OR g.source_session_id IS DISTINCT FROM rv.source_session_id THEN RAISE EXCEPTION 'FUSION_GROUP_DENIED'; END IF;
  k:=format('review:%s:%s:%s',p_round,p_phase,p_attempt);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(rv.steps) x WHERE x->>'stepKey'=k AND x->>'groupId'<>p_group_id::text) THEN
    RAISE EXCEPTION 'FUSION_REVIEW_STEP_CONFLICT'; END IF;
  res:=fusion_group_claim(p_actor_id,p_group_id,k,1,p_items);
  IF res->>'state'='claimed' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(rv.steps) x WHERE x->>'stepKey'=k) THEN
    UPDATE fusion_reviews SET steps=steps||jsonb_build_array(jsonb_build_object('round',p_round,'phase',p_phase,
      'attempt',p_attempt,'groupId',p_group_id,'stepKey',k,'claimedAt',clock_timestamp())),
      state='running',updated_at=clock_timestamp() WHERE id=rv.id;
  END IF;
  RETURN res;
END $$;

-- Move to the next position or to an end state. Compare-and-set on the current position; an ended review
-- answers the same end state again (idempotent) and refuses any other change.
CREATE OR REPLACE FUNCTION public.fusion_review_advance(p_actor_id uuid, p_review_id uuid, p_from jsonb, p_to jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rv fusion_reviews; target text:=p_to->>'state';
BEGIN
  PERFORM bill2_actor(p_actor_id);
  SELECT * INTO rv FROM fusion_reviews WHERE id=p_review_id AND actor_id=p_actor_id FOR UPDATE;
  IF rv.id IS NULL THEN RAISE EXCEPTION 'FUSION_REVIEW_DENIED'; END IF;
  IF rv.state NOT IN ('running','paused') THEN
    IF rv.state=target AND rv.outcome IS NOT DISTINCT FROM p_to->'outcome' THEN RETURN fusion_review_view(rv); END IF;
    RAISE EXCEPTION 'FUSION_REVIEW_ENDED';
  END IF;
  IF rv.round::text IS DISTINCT FROM p_from->>'round' OR rv.phase IS DISTINCT FROM p_from->>'phase'
    OR rv.attempt::text IS DISTINCT FROM p_from->>'attempt' THEN RAISE EXCEPTION 'FUSION_REVIEW_STEP_CONFLICT'; END IF;
  IF target='running' THEN
    IF coalesce(p_to->>'round','')!~'^[1-9][0-9]?$' OR p_to->>'phase' NOT IN ('review','summary')
      OR coalesce(p_to->>'attempt','')!~'^[1-9][0-9]?$' OR (p_to->>'round')::int>coalesce((rv.config->>'maxRounds')::int,1)
    THEN RAISE EXCEPTION 'FUSION_REVIEW_INVALID'; END IF;
    UPDATE fusion_reviews SET state='running',round=(p_to->>'round')::int,phase=p_to->>'phase',attempt=(p_to->>'attempt')::int,
      updated_at=clock_timestamp() WHERE id=rv.id RETURNING * INTO rv;
  ELSIF target IN ('revision_failed','incomplete','completed') THEN
    UPDATE fusion_reviews SET state=target,outcome=p_to->'outcome',revision_id=nullif(p_to->>'revisionId','')::uuid,
      updated_at=clock_timestamp(),ended_at=clock_timestamp() WHERE id=rv.id RETURNING * INTO rv;
  ELSE RAISE EXCEPTION 'FUSION_REVIEW_INVALID'; END IF;
  RETURN fusion_review_view(rv);
END $$;

-- Stop (user) or end (user ends a paused review): one transaction locks the review, sets the end state,
-- then cancels every run of the review. Undispatched calls are released free; dispatched calls only
-- settle (BILL2 cancel after dispatch). Repeating returns the same end state.
CREATE OR REPLACE FUNCTION public.fusion_review_close(p_actor_id uuid, p_review_id uuid, p_state text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rv fusion_reviews; run record;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  IF p_state NOT IN ('stopped','interrupted') THEN RAISE EXCEPTION 'FUSION_REVIEW_INVALID'; END IF;
  SELECT * INTO rv FROM fusion_reviews WHERE id=p_review_id AND actor_id=p_actor_id FOR UPDATE;
  IF rv.id IS NULL THEN RAISE EXCEPTION 'FUSION_REVIEW_DENIED'; END IF;
  IF rv.state NOT IN ('running','paused') THEN
    IF rv.state=p_state THEN RETURN fusion_review_view(rv); END IF;
    RAISE EXCEPTION 'FUSION_REVIEW_ENDED';
  END IF;
  -- "End review" is for a paused review; a running one is stopped.
  IF p_state='interrupted' AND rv.state<>'paused' THEN RAISE EXCEPTION 'FUSION_REVIEW_STEP_CONFLICT'; END IF;
  UPDATE fusion_reviews SET state=p_state,updated_at=clock_timestamp(),ended_at=clock_timestamp() WHERE id=rv.id RETURNING * INTO rv;
  FOR run IN SELECT br.id,br.closed FROM bill2_runs br WHERE br.actor_id=p_actor_id
    AND br.fusion_group_id IN (SELECT (x->>'groupId')::uuid FROM jsonb_array_elements(rv.steps) x) ORDER BY br.id LOOP
    IF NOT run.closed THEN PERFORM bill2_cancel(p_actor_id,run.id); END IF;
    PERFORM bill2_finalize(p_actor_id,run.id);
  END LOOP;
  RETURN fusion_review_view(rv);
END $$;

-- Daily reconciliation, after the Fusion recovery: a review still in progress whose calls have all
-- settled and that has not moved for p_idle becomes paused (not an end state; holds are already
-- released). Ended reviews are never touched.
CREATE OR REPLACE FUNCTION public.fusion_review_pause_idle(p_idle interval) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
  -- Never waits on a review row a claim, advance or close holds: those are skipped until the next run.
  UPDATE fusion_reviews rv SET state='paused',updated_at=clock_timestamp()
  WHERE rv.id IN (SELECT id FROM fusion_reviews WHERE state='running' AND updated_at<=clock_timestamp()-p_idle
      ORDER BY updated_at LIMIT 500 FOR UPDATE SKIP LOCKED)
    AND rv.state='running' AND rv.updated_at<=clock_timestamp()-p_idle
    AND NOT EXISTS(SELECT 1 FROM bill2_runs br JOIN bill2_calls c ON c.run_id=br.id WHERE br.actor_id=rv.actor_id
      AND br.fusion_group_id IN (SELECT (x->>'groupId')::uuid FROM jsonb_array_elements(rv.steps) x)
      AND (fusion_call_in_flight(c) OR (c.dispatched_at IS NULL AND c.settled_at IS NULL)));
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n;
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['fusion_review_start(uuid,uuid,uuid,uuid,jsonb)','fusion_review_read(uuid,uuid)',
    'fusion_review_claim(uuid,uuid,integer,text,integer,uuid,jsonb)','fusion_review_advance(uuid,uuid,jsonb,jsonb)',
    'fusion_review_close(uuid,uuid,text)','fusion_review_pause_idle(interval)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['fusion_review_settings(uuid)','fusion_review_breaker_usage(uuid)','fusion_review_view(fusion_reviews)',
    'fusion_call_in_flight(bill2_calls)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role', f);
  END LOOP;
END $$;

-- Erasure: a review holds a frozen copy of confirmed fields. Deleting the draft/project, the reviewed
-- version or the source conversation deletes the review rows; account erasure removes and counts them.
DO $$ DECLARE src text; a text; BEGIN
  src:=pg_get_functiondef('public.content_erasure_confirm(uuid,text,uuid,text)'::regprocedure);
  IF position('-- 0236 fusion reviews' IN src)=0 THEN
    a:=$x$ -- 0235 fusion outputs$x$;
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: content_erasure_confirm 0236'; END IF;
    EXECUTE replace(src,a,$x$ -- 0236 fusion reviews
 DELETE FROM fusion_reviews fr WHERE fr.actor_id=a AND (fr.project_id=ANY(projects) OR fr.source_session_id=ANY(sessions)
  OR fr.source_version_id=ANY(versions));
$x$||a);
  END IF;
END $$;

DO $$ DECLARE src text; a text; BEGIN
  src:=pg_get_functiondef('public.account_erasure_scrub_content(uuid)'::regprocedure);
  IF position('fusion_reviews' IN src)=0 THEN
    a:=$x$  RETURN counts;$x$;
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: account_erasure_scrub_content 0236'; END IF;
    EXECUTE replace(src,a,$x$  DELETE FROM fusion_reviews WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;
  counts := counts || jsonb_build_object('fusion_reviews', n);
$x$||a);
  END IF;
  src:=pg_get_functiondef('public.account_erasure_body_remaining(uuid)'::regprocedure);
  IF position('fusion_reviews' IN src)=0 THEN
    a:=$x$+(SELECT count(*) FROM fusion_call_outputs WHERE actor_id=p_profile_id)$x$;
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: account_erasure_body_remaining 0236'; END IF;
    EXECUTE replace(src,a,a||$x$+(SELECT count(*) FROM fusion_reviews WHERE actor_id=p_profile_id)$x$);
  END IF;
END $$;
COMMIT;
