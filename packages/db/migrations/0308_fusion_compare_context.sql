/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- FUSION-COMPARE PR-2b (docs/launch/tasks/FUSION-COMPARE.md §3.1, §3.2). Number allocated by the controller.
-- Additions on top of 0290; one nullable column, no data migration:
--  * fusion_compare_context: the conversation as the next ordinary turn would see it, read in ONE transaction under the
--    session lock together with the history revision and the current work material, so the revision a compare freezes is
--    exactly the revision of the history it was built from (a turn appended in between makes the begin refuse as stale);
--  * fusion_compare_view returns snapshotHash (written at begin since 0290): a start resumed after the paid judgement
--    but before the group exists must rebuild exactly that snapshot;
--  * the positioning outcome's fallback flag is stored with the verdict (fusion_compares.gate_fallback, fusion_compare_gate gets a
--    fourth argument): a start resumed after the paid judgement replays the stored rule instead of rebuilding it from today's
--    refund count, which may have changed in between;
--  * fusion_compare_end: ends a compare that has no group yet (refused, nothing charged) when that resume finds the
--    snapshot changed. A compare with a group is stopped (fusion_compare_stop), never ended here.
-- Rollback (nothing depends on these in stored data, and no route calls them while the compare switch is off):
-- DROP FUNCTION public.fusion_compare_context(uuid,uuid,integer); DROP FUNCTION public.fusion_compare_material_token(uuid,uuid); DROP FUNCTION public.fusion_compare_material_guard(uuid,uuid); DROP FUNCTION public.fusion_compare_end(uuid,uuid);
-- DROP FUNCTION public.fusion_compare_gate(uuid,uuid,text,boolean); then re-run the fusion_compare_gate and
-- fusion_compare_view definitions of 0290_fusion_compare.sql (three-argument gate, view without 'snapshotHash' and
-- 'gateFallback'), and the fusion_group_admit, fusion_compare_begin and fusion_compare_adopt definitions of 0290 (without the work-material checks); ALTER TABLE public.fusion_compares DROP COLUMN gate_fallback. The TypeScript treats a missing
-- snapshotHash as "no check" and a missing gateFallback as "derive it from the gate state".
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.fusion_compares ADD COLUMN IF NOT EXISTS gate_fallback boolean;

CREATE OR REPLACE FUNCTION public.fusion_compare_view(fc fusion_compares) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('compareId',fc.id,'requestId',fc.request_id,'sessionId',fc.session_id,'groupId',fc.group_id,
    'historyRevision',fc.history_revision,'state',CASE WHEN fc.state='admitting' AND fc.created_at<=clock_timestamp()-interval '5 minutes'
      THEN 'refused' ELSE fc.state END,'gateVerdict',fc.gate_verdict,'config',fc.config,'adoption',fc.adoption,'createdAt',fc.created_at,
    'snapshotHash',fc.snapshot_hash,'gateFallback',fc.gate_fallback);
$$;
REVOKE ALL ON FUNCTION public.fusion_compare_view(fusion_compares) FROM PUBLIC,anon,authenticated,service_role;

-- The positioning outcome (verdict and whether the turn carries the fallback rule), written once by the request that created
-- the record. Repeating the same outcome answers the same view; a different one is a conflict. block ends the compare.
DROP FUNCTION IF EXISTS public.fusion_compare_gate(uuid,uuid,text);
CREATE OR REPLACE FUNCTION public.fusion_compare_gate(p_actor_id uuid, p_compare_id uuid, p_verdict text, p_fallback boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE fc fusion_compares;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  IF p_verdict IS NULL OR p_verdict NOT IN ('clear','allow','block','unavailable') OR p_fallback IS NULL
    OR (p_verdict='block' AND p_fallback) THEN RAISE EXCEPTION 'FUSION_COMPARE_INVALID'; END IF;
  SELECT * INTO fc FROM fusion_compares WHERE id=p_compare_id AND actor_id=p_actor_id FOR UPDATE;
  IF fc.id IS NULL THEN RAISE EXCEPTION 'FUSION_COMPARE_DENIED'; END IF;
  IF fc.gate_verdict IS NOT NULL THEN
    IF fc.gate_verdict<>p_verdict OR fc.gate_fallback IS DISTINCT FROM p_fallback THEN RAISE EXCEPTION 'FUSION_COMPARE_REQUEST_CONFLICT'; END IF;
    RETURN fusion_compare_view(fc);
  END IF;
  IF fc.state<>'admitting' OR fc.created_at<=clock_timestamp()-interval '5 minutes' THEN RAISE EXCEPTION 'FUSION_COMPARE_ENDED'; END IF;
  UPDATE fusion_compares SET gate_verdict=p_verdict,gate_fallback=p_fallback,
    state=CASE WHEN p_verdict='block' THEN 'refused' ELSE state END,updated_at=clock_timestamp() WHERE id=fc.id RETURNING * INTO fc;
  RETURN fusion_compare_view(fc);
END $$;

-- The work material as one opaque token: its revision AND its active content hash. A revocation only flags the existing
-- row (the revision stays), so the revision alone cannot tell that the brief a compare was built from has been withdrawn.
CREATE OR REPLACE FUNCTION public.fusion_compare_material_token(p_actor_id uuid, p_session_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT coalesce(c->>'materialRevision','')||':'||coalesce(c#>>'{scopeMaterial,hash}','none')
  FROM (SELECT runtime_session_context(p_actor_id,p_session_id) c) x
$$;
REVOKE ALL ON FUNCTION public.fusion_compare_material_token(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- The current work material must still be allowed, exactly as an ordinary turn requires (runtime_material_allowed re-checks the
-- work package, source authorization and evidence it depends on); the token alone only proves the stored content is unchanged.
CREATE OR REPLACE FUNCTION public.fusion_compare_material_guard(p_actor_id uuid, p_session_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE material jsonb;
BEGIN
  material:=runtime_session_context(p_actor_id,p_session_id)->'scopeMaterial';
  IF material IS NOT NULL AND material<>'null'::jsonb THEN PERFORM runtime_material_allowed(p_actor_id,material); END IF;
END $$;
REVOKE ALL ON FUNCTION public.fusion_compare_material_guard(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- The last p_limit usable history items (oldest first) as {revision, item}, the session revision they belong to, whether a
-- turn is running (the same replaceable-pointer rule as runtime_admit and fusion_compare_adopt), and the current work
-- material exactly as runtime_session_context reports it. Items an ordinary turn would not be allowed to read (the
-- execution behind them is unavailable) are left out, as in runtime admission.
CREATE OR REPLACE FUNCTION public.fusion_compare_context(p_actor_id uuid, p_session_id uuid, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions; ctx jsonb; items jsonb; busy boolean;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 0 AND 1000 THEN RAISE EXCEPTION 'FUSION_COMPARE_INVALID'; END IF;
  SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id FOR SHARE;
  IF s.id IS NULL OR s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'FUSION_COMPARE_SESSION_GONE'; END IF;
  ctx:=runtime_session_context(p_actor_id,s.id);
  WITH bounded AS MATERIALIZED (
    SELECT h.revision,h.execution_id,h.item FROM runtime_session_history h
    WHERE h.session_id=s.id AND h.revision<=s.revision AND NOT h.internal_control
    ORDER BY h.revision DESC LIMIT p_limit+128
  ), availability AS MATERIALIZED (
    SELECT * FROM runtime_history_availability(ARRAY(SELECT DISTINCT execution_id FROM bounded))
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('revision',x.revision,'item',x.item) ORDER BY x.revision),'[]') INTO items
  FROM (SELECT b.revision,b.item FROM bounded b JOIN availability a ON a.execution_id=b.execution_id
    WHERE a.available ORDER BY b.revision DESC LIMIT p_limit) x;
  busy:=s.active_execution IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runtime_executions old_execution
    JOIN bill2_runs old_run ON old_run.id=old_execution.billing_run_id
    WHERE old_execution.id=s.active_execution AND old_execution.session_id=s.id
      AND old_execution.actor_id=p_actor_id AND old_run.actor_id=p_actor_id
      AND old_run.session_ref=s.id AND old_execution.state='cost_pending'
      AND old_run.closed AND old_run.cancel_requested);
  RETURN jsonb_build_object('revision',s.revision,'busy',busy,'items',items,
    'scopeMaterial',ctx->'scopeMaterial','materialRevision',to_jsonb(fusion_compare_material_token(p_actor_id,s.id)));
END $$;

-- Ends a compare that has no group yet: refused, nothing was held, nothing is charged. Idempotent for a compare that is
-- already over. A compare with a group is never ended here (its runs hold money; fusion_compare_stop settles them).
CREATE OR REPLACE FUNCTION public.fusion_compare_end(p_actor_id uuid, p_compare_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE fc fusion_compares;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  SELECT * INTO fc FROM fusion_compares WHERE id=p_compare_id AND actor_id=p_actor_id FOR UPDATE;
  IF fc.id IS NULL OR fc.group_id IS NOT NULL THEN RAISE EXCEPTION 'FUSION_COMPARE_DENIED'; END IF;
  IF fc.state='admitting' THEN
    UPDATE fusion_compares SET state='refused',updated_at=clock_timestamp() WHERE id=fc.id RETURNING * INTO fc;
  END IF;
  RETURN fusion_compare_view(fc);
END $$;

-- fusion_compare_begin: 0290's definition plus the work-material revision check under the session lock (before any record
-- or paid work), when the request carries config.materialRevision.
CREATE OR REPLACE FUNCTION public.fusion_compare_begin(p_actor_id uuid, p_request_id uuid, p_session_id uuid, p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE fc fusion_compares; s runtime_sessions; v jsonb; lim jsonb; models jsonb; usage jsonb; n integer;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  -- The same per-user lock as fusion_review_start: a compare and a review never start at the same time.
  PERFORM pg_advisory_xact_lock(hashtextextended('fusion-review:'||p_actor_id::text,0));
  IF jsonb_typeof(p_request) IS DISTINCT FROM 'object' OR coalesce(p_request->>'requestHash','')!~'^[a-f0-9]{64}$'
    OR coalesce(p_request->>'questionHash','')!~'^[a-f0-9]{64}$' OR jsonb_typeof(p_request->'question') IS DISTINCT FROM 'string'
    OR p_request->>'questionHash' IS DISTINCT FROM encode(sha256(convert_to(p_request->>'question','UTF8')),'hex')
    OR jsonb_typeof(p_request->'config') IS DISTINCT FROM 'object' OR coalesce(p_request->>'historyRevision','')!~'^[0-9]+$'
    OR jsonb_typeof(coalesce(p_request->'workspaceDependencies','[]')) IS DISTINCT FROM 'array'
    OR coalesce(p_request->>'snapshotHash','')!~'^[a-f0-9]{64}$'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_request->'workspaceDependencies','[]')) d
      WHERE jsonb_typeof(d) IS DISTINCT FROM 'object' OR coalesce(d->>'sourceVersionId','')
        !~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR (SELECT count(*) FROM jsonb_object_keys(d))<>1)
  THEN RAISE EXCEPTION 'FUSION_COMPARE_INVALID'; END IF;
  SELECT * INTO fc FROM fusion_compares WHERE actor_id=p_actor_id AND request_id=p_request_id;
  IF fc.id IS NOT NULL THEN
    IF fc.request_hash<>p_request->>'requestHash' OR fc.session_id<>p_session_id THEN RAISE EXCEPTION 'FUSION_COMPARE_REQUEST_CONFLICT'; END IF;
    RETURN fusion_compare_view(fc)||jsonb_build_object('created',false);
  END IF;
  v:=fusion_compare_settings(p_actor_id);
  lim:=fusion_compare_limits(v);
  SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id FOR SHARE;
  IF s.id IS NULL OR s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'FUSION_COMPARE_SESSION_GONE'; END IF;
  IF s.revision<>(p_request->>'historyRevision')::bigint THEN RAISE EXCEPTION 'FUSION_COMPARE_STALE'; END IF;
  -- The work material (brief) the caller read with the history must still be the current one: material edits do not move
  -- the session revision, and a start on an old brief would charge every model for it. TypeScript always sends the key.
  IF (p_request->'config') ? 'materialRevision'
    AND p_request#>>'{config,materialRevision}' IS DISTINCT FROM fusion_compare_material_token(p_actor_id,s.id)
  THEN RAISE EXCEPTION 'FUSION_COMPARE_STALE'; END IF;
  PERFORM fusion_compare_material_guard(p_actor_id,s.id);
  models:=p_request#>'{config,models}';
  IF jsonb_typeof(models) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'FUSION_COMPARE_INVALID'; END IF;
  n:=jsonb_array_length(models);
  IF n<(lim->>'min')::int THEN RAISE EXCEPTION 'FUSION_COMPARE_TOO_FEW'; END IF;
  IF n>(lim->>'max')::int THEN RAISE EXCEPTION 'FUSION_COMPARE_TOO_MANY'; END IF;
  IF (SELECT count(DISTINCT x) FROM jsonb_array_elements_text(models) x)<>n
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(models) x WHERE NOT coalesce(v#>'{compare,allowedModelIds}','[]') ? x)
  THEN RAISE EXCEPTION 'FUSION_COMPARE_MODEL_NOT_ALLOWED'; END IF;
  -- Frozen workspace sources: like runtime_workspace_tool_guard (0218), take the source projects in share mode
  -- first, then require each source still allowed. A deletion that committed earlier is refused here; one that
  -- comes later waits for this record and then finds it (content_erasure_confirm, below).
  PERFORM p.id FROM artifact_projects p JOIN artifact_versions v ON v.project_id=p.id
    WHERE p.actor_id=p_actor_id AND v.id::text IN (SELECT d->>'sourceVersionId'
      FROM jsonb_array_elements(coalesce(p_request->'workspaceDependencies','[]')) d) ORDER BY p.id FOR SHARE OF p;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_request->'workspaceDependencies','[]')) d
    WHERE NOT coalesce(opc_source_allowed(p_actor_id,(d->>'sourceVersionId')::uuid),false)) THEN
    RAISE EXCEPTION 'FUSION_COMPARE_SOURCE_REVOKED'; END IF;
  IF fusion_compare_active(p_actor_id) OR EXISTS(SELECT 1 FROM fusion_reviews WHERE actor_id=p_actor_id AND state IN ('running','paused')) THEN
    RAISE EXCEPTION 'FUSION_COMPARE_ACTIVE'; END IF;
  usage:=fusion_review_breaker_usage(p_actor_id);
  IF (usage->>'noDeliveryCalls')::int>=coalesce((v#>>'{compare,breaker,noDeliveryCalls}')::int,10)
    OR (usage->>'platformUsd')::numeric>=coalesce((v#>>'{compare,breaker,platformUsd}')::numeric,2) THEN
    RAISE EXCEPTION 'FUSION_COMPARE_BREAKER'; END IF;
  INSERT INTO fusion_compares(actor_id,request_id,session_id,history_revision,question,question_hash,request_hash,snapshot_hash,config,
    workspace_dependencies,state)
  VALUES(p_actor_id,p_request_id,s.id,s.revision,p_request->>'question',p_request->>'questionHash',p_request->>'requestHash',
    p_request->>'snapshotHash',p_request->'config',coalesce(p_request->'workspaceDependencies','[]'),'admitting')
  RETURNING * INTO fc;
  RETURN fusion_compare_view(fc)||jsonb_build_object('created',true);
END $$;

-- fusion_compare_adopt: 0290's definition plus one more stale condition, the work-material revision recorded with the
-- request (config.materialRevision) against the session's current one.
CREATE OR REPLACE FUNCTION public.fusion_compare_adopt(p_actor_id uuid, p_compare_id uuid, p_column integer,
  p_request_id uuid, p_billing jsonb, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE fc fusion_compares; s runtime_sessions; r bill2_runs; o fusion_call_outputs; b jsonb; e runtime_executions;
  answer text; user_text text;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  -- Lock order as runtime admission and conversation deletion: session, then the compare record.
  SELECT s2.* INTO s FROM runtime_sessions s2 JOIN fusion_compares f2 ON f2.session_id=s2.id
    WHERE f2.id=p_compare_id AND f2.actor_id=p_actor_id AND s2.actor_id=p_actor_id FOR UPDATE OF s2;
  SELECT * INTO fc FROM fusion_compares WHERE id=p_compare_id AND actor_id=p_actor_id FOR UPDATE;
  IF fc.id IS NULL OR s.id IS NULL THEN RAISE EXCEPTION 'FUSION_COMPARE_DENIED'; END IF;
  IF s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'FUSION_COMPARE_SESSION_GONE'; END IF;
  IF fc.adoption IS NOT NULL THEN
    IF fc.adoption->>'requestId'=p_request_id::text THEN
      IF fc.adoption->>'column' IS DISTINCT FROM p_column::text THEN RAISE EXCEPTION 'FUSION_COMPARE_REQUEST_CONFLICT'; END IF;
      RETURN jsonb_build_object('state','adopted','adoption',fc.adoption);
    END IF;
    RAISE EXCEPTION 'FUSION_COMPARE_ADOPTED';
  END IF;
  IF fc.group_id IS NULL OR fc.state NOT IN ('running','finished','stopped') THEN RAISE EXCEPTION 'FUSION_COMPARE_DENIED'; END IF;
  SELECT * INTO r FROM bill2_runs WHERE fusion_group_id=fc.group_id AND actor_id=p_actor_id
    AND payload#>>'{input,fusion,index}'=p_column::text;
  SELECT o2.* INTO o FROM fusion_call_outputs o2 JOIN bill2_calls c ON c.id=o2.call_id
    WHERE o2.run_id=r.id AND c.fusion_verdict='usable' AND c.settled_at IS NOT NULL;
  IF r.id IS NULL OR NOT r.closed OR o.call_id IS NULL THEN RAISE EXCEPTION 'FUSION_COMPARE_NOT_ADOPTABLE'; END IF;
  -- The main conversation moved on (or a turn is running): hand back a quote, change nothing.
  -- "A turn is running" uses runtime_admit's rule: a stopped turn whose cancelled run only waits for its cost
  -- (cost_pending, closed, cancel requested) is replaceable and does not block.
  -- The work material (brief) is fenced like the history: a change after the compare started makes the answer stale.
  PERFORM fusion_compare_material_guard(p_actor_id,s.id);
  IF s.revision<>fc.history_revision
    OR fc.config->>'materialRevision' IS DISTINCT FROM fusion_compare_material_token(p_actor_id,s.id) OR (s.active_execution IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runtime_executions old_execution
      JOIN bill2_runs old_run ON old_run.id=old_execution.billing_run_id
      WHERE old_execution.id=s.active_execution AND old_execution.session_id=s.id
        AND old_execution.actor_id=p_actor_id AND old_run.actor_id=p_actor_id
        AND old_run.session_ref=s.id AND old_execution.state='cost_pending'
        AND old_run.closed AND old_run.cancel_requested)) THEN
    RETURN jsonb_build_object('state','stale','quote',o.body);
  END IF;
  -- Two history items: the compare question as the user turn, the chosen answer as the assistant turn.
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)<>2 THEN RAISE EXCEPTION 'FUSION_COMPARE_INVALID'; END IF;
  user_text:=coalesce(p_items#>>'{0,content}',p_items#>>'{0,content,0,text}');
  answer:=coalesce(p_items#>>'{1,content,0,text}',p_items#>>'{1,content}');
  IF p_items#>>'{0,role}' IS DISTINCT FROM 'user' OR p_items#>>'{1,role}' IS DISTINCT FROM 'assistant'
    OR user_text IS DISTINCT FROM fc.question OR answer IS DISTINCT FROM o.body THEN RAISE EXCEPTION 'FUSION_COMPARE_INVALID'; END IF;
  -- The adoption run: the host freezes it like an ordinary turn of this conversation; zero calls, zero charge.
  IF p_billing->'scope' IS DISTINCT FROM s.scope OR p_billing->>'sessionRef' IS NOT NULL OR p_billing ? 'fusionGroupId'
    OR p_billing#>'{input,fusionAdoption}' IS DISTINCT FROM jsonb_build_object('compareId',fc.id,'column',p_column)
    OR p_billing#>>'{input,input}' IS DISTINCT FROM fc.question
    OR p_billing#>'{input,dependencies}' IS DISTINCT FROM fc.workspace_dependencies THEN
    RAISE EXCEPTION 'FUSION_COMPARE_INVALID'; END IF;
  -- The adoption carries the Skill identity the compare was frozen with (none when none was used).
  IF p_billing->>'moduleId' IS DISTINCT FROM fc.config#>>'{skill,moduleId}'
    OR p_billing->>'revisionId' IS DISTINCT FROM fc.config#>>'{skill,revisionId}'
    OR (fc.config#>>'{skill,skillId}' IS NOT NULL AND p_billing->>'skillId' IS DISTINCT FROM fc.config#>>'{skill,skillId}')
    OR (fc.config#>>'{skill,moduleId}' IS NULL AND p_billing ?| ARRAY['moduleId','skillId','revisionId'])
  THEN RAISE EXCEPTION 'FUSION_COMPARE_SKILL_MISMATCH'; END IF;
  IF p_billing->>'revisionId' IS NOT NULL THEN
    PERFORM id FROM modules WHERE id=(p_billing->>'moduleId')::uuid
      AND skill_id=(p_billing->>'skillId')::uuid AND active AND model_id=(p_billing->>'modelId')::uuid FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'RUNTIME_SKILL_MODEL_DENIED'; END IF;
  END IF;
  PERFORM runtime_context_allowed(p_actor_id,p_billing->'input');
  b:=bill2_prepare(p_actor_id,p_request_id,p_billing);
  INSERT INTO runtime_executions(actor_id,session_id,request_id,payload,billing_run_id,history_revision)
    VALUES(p_actor_id,s.id,p_request_id,p_billing->'input',(b->>'id')::uuid,s.revision) RETURNING * INTO e;
  UPDATE bill2_runs SET session_ref=s.id WHERE id=e.billing_run_id;
  PERFORM bill2_cancel(p_actor_id,e.billing_run_id);
  PERFORM bill2_finalize(p_actor_id,e.billing_run_id);
  IF EXISTS(SELECT 1 FROM bill2_runs WHERE id=e.billing_run_id AND (NOT closed OR coalesce(charged,0)<>0)) THEN
    RAISE EXCEPTION 'FUSION_COMPARE_ADOPTION_BILLING'; END IF;
  UPDATE runtime_executions SET state='cancelled',result=jsonb_build_object('body',o.body,'completeness','complete')
    WHERE id=e.id RETURNING * INTO e;
  INSERT INTO runtime_session_batches VALUES(s.id,e.id,0,p_items,s.revision,s.revision+2);
  INSERT INTO runtime_session_history(session_id,revision,execution_id,item)
    SELECT s.id,s.revision+ordinality,e.id,value FROM jsonb_array_elements(p_items) WITH ORDINALITY;
  UPDATE runtime_sessions SET revision=revision+2 WHERE id=s.id;
  UPDATE fusion_compares SET adoption=jsonb_build_object('requestId',p_request_id,'column',p_column,'runId',r.id,
      'adoptionRunId',e.billing_run_id,'executionId',e.id,'fromRevision',s.revision,'toRevision',s.revision+2),
    updated_at=clock_timestamp() WHERE id=fc.id RETURNING * INTO fc;
  RETURN jsonb_build_object('state','adopted','adoption',fc.adoption);
END $$;

-- fusion_group_admit: 0290's definition plus, for a compare, the work-material check (token and dependencies) in the
-- admission transaction, before any run is prepared. The review path is unchanged.
CREATE OR REPLACE FUNCTION public.fusion_group_admit(p_actor_id uuid, p_request_id uuid, p_kind text,
  p_source_session_id uuid, p_runs jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE g fusion_billing_groups; item jsonb; f jsonb; v jsonb; run jsonb; out jsonb:='[]'; member_level text;
  total numeric:=0; i integer:=0; gid uuid; fc fusion_compares; lim jsonb; budget jsonb; phase text;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  IF p_kind IS NULL OR p_kind NOT IN ('review','compare') THEN RAISE EXCEPTION 'FUSION_GROUP_INVALID'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fusion-admit:'||p_actor_id::text||':'||p_request_id::text,0));
  SELECT * INTO g FROM fusion_billing_groups WHERE actor_id=p_actor_id AND request_id=p_request_id;
  IF g.id IS NOT NULL THEN
    IF g.kind<>p_kind OR g.source_session_id IS DISTINCT FROM p_source_session_id THEN RAISE EXCEPTION 'FUSION_GROUP_CONFLICT'; END IF;
    -- The replay returns frozen private requests: take the conversation's share lock first and refuse
    -- once it is deleted, so a replay never returns content a committed deletion removed.
    PERFORM 1 FROM runtime_sessions WHERE id=g.source_session_id AND actor_id=p_actor_id
      AND content_deleted_at IS NULL AND erased_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'FUSION_GROUP_DENIED'; END IF;
    -- A compare whose record a source deletion removed (its runs scrubbed) has nothing left to replay.
    IF p_kind='compare' AND NOT EXISTS(SELECT 1 FROM fusion_compares WHERE actor_id=p_actor_id AND group_id=g.id) THEN
      RAISE EXCEPTION 'FUSION_GROUP_DENIED'; END IF;
    RETURN jsonb_build_object('groupId',g.id,'replayed',true,'runs',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'runId',r.id,'fusion',r.payload#>'{input,fusion}') ORDER BY (r.payload#>>'{input,fusion,index}')::int)
      FROM bill2_runs r WHERE r.fusion_group_id=g.id AND r.actor_id=p_actor_id),'[]'));
  END IF;
  IF jsonb_typeof(p_runs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_runs) NOT BETWEEN 1 AND 16 THEN
    RAISE EXCEPTION 'FUSION_GROUP_INVALID'; END IF;
  IF p_kind='review' THEN
    SELECT value INTO v FROM system_settings WHERE key='fusion_settings';
    IF jsonb_typeof(v)='string' THEN v:=(v#>>'{}')::jsonb; END IF;
    IF v#>>'{review,enabled}' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'FUSION_REVIEW_DISABLED'; END IF;
    -- Paid, consistent, unexpired membership (same facts as reports), then the plan's own Fusion switch.
    PERFORM report_membership_check(p_actor_id);
    SELECT membership_level INTO member_level FROM profiles WHERE id=p_actor_id;
    IF NOT EXISTS(SELECT 1 FROM membership_plans mp WHERE mp.level=member_level AND mp.allow_fusion_review) THEN
      RAISE EXCEPTION 'FUSION_MEMBERSHIP_REQUIRED'; END IF;
    budget:=v#>'{review,maxBudgetUsd}';
  ELSE
    -- Lock order as begin and adopt: the session first (shared), then the compare record.
    PERFORM 1 FROM runtime_sessions WHERE id=p_source_session_id AND actor_id=p_actor_id FOR SHARE;
    SELECT * INTO fc FROM fusion_compares WHERE actor_id=p_actor_id AND request_id=p_request_id FOR UPDATE;
    IF fc.id IS NULL OR fc.session_id IS DISTINCT FROM p_source_session_id THEN RAISE EXCEPTION 'FUSION_COMPARE_DENIED'; END IF;
    IF fc.state<>'admitting' OR fc.created_at<=clock_timestamp()-interval '5 minutes' THEN RAISE EXCEPTION 'FUSION_COMPARE_ENDED'; END IF;
    IF fc.gate_verdict IS NULL OR fc.gate_verdict='block' THEN RAISE EXCEPTION 'FUSION_COMPARE_GATE_REQUIRED'; END IF;
    -- The work material may have been withdrawn or changed while the paid judgement ran: nothing is admitted, held or sent
    -- with it. The token covers revision and content, the guard re-checks the dependencies (as an ordinary turn does).
    IF fc.config ? 'materialRevision' AND fc.config->>'materialRevision' IS DISTINCT FROM fusion_compare_material_token(p_actor_id,fc.session_id)
    THEN RAISE EXCEPTION 'FUSION_COMPARE_STALE'; END IF;
    PERFORM fusion_compare_material_guard(p_actor_id,fc.session_id);
    v:=fusion_compare_settings(p_actor_id);
    lim:=fusion_compare_limits(v);
    IF jsonb_array_length(p_runs)<(lim->>'min')::int THEN RAISE EXCEPTION 'FUSION_COMPARE_TOO_FEW'; END IF;
    IF jsonb_array_length(p_runs)>(lim->>'max')::int THEN RAISE EXCEPTION 'FUSION_COMPARE_TOO_MANY'; END IF;
    IF jsonb_array_length(p_runs)<>jsonb_array_length(fc.config->'models') THEN RAISE EXCEPTION 'FUSION_GROUP_INVALID'; END IF;
    budget:=v#>'{compare,maxBudgetUsd}';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_runs) LOOP
    f:=item#>'{payload,input,fusion}';
    phase:=f->>'phase';
    IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR (f->>'index') IS DISTINCT FROM i::text
      OR jsonb_typeof(f->'body') IS DISTINCT FROM 'string' OR jsonb_typeof(f->'call') IS DISTINCT FROM 'object'
      OR (p_kind='review' AND phase NOT IN ('fusion_review','fusion_summary'))
      OR (p_kind='compare' AND phase IS DISTINCT FROM 'fusion_compare')
      OR f#>>'{call,phase}' IS DISTINCT FROM phase
      OR f#>>'{call,requestHash}' IS DISTINCT FROM encode(sha256(convert_to(f->>'body','UTF8')),'hex')
      OR jsonb_array_length(item#>'{payload,callPolicy}')<>1 OR item#>>'{payload,limits,maxCalls}' IS DISTINCT FROM '1'
      OR item#>>'{payload,callPolicy,0,modelId}' IS DISTINCT FROM item#>>'{payload,modelId}'
      OR item#>>'{payload,contractVersion}' IS DISTINCT FROM 'bill2.v2' OR item#>'{payload,sessionRef}' IS NOT NULL
    THEN RAISE EXCEPTION 'FUSION_GROUP_INVALID'; END IF;
    IF p_kind='review' THEN
      -- Administrator allowlist: reviewers for review calls, the summary model for the summary call.
      IF (phase='fusion_review' AND NOT coalesce(v#>'{review,reviewerModelIds}','[]') ? (item#>>'{payload,modelId}'))
        OR (phase='fusion_summary' AND v#>>'{review,summaryModelId}' IS DISTINCT FROM item#>>'{payload,modelId}')
      THEN RAISE EXCEPTION 'FUSION_MODEL_DENIED'; END IF;
    ELSE
      -- The compare allowlist, in the order the user chose (frozen at begin). A compare run carries no
      -- top-level Skill identity (its columns use other models than the Skill's own; FUSION-COMPARE §3.4).
      IF NOT coalesce(v#>'{compare,allowedModelIds}','[]') ? (item#>>'{payload,modelId}')
        OR fc.config#>>ARRAY['models',i::text] IS DISTINCT FROM item#>>'{payload,modelId}' THEN
        RAISE EXCEPTION 'FUSION_COMPARE_MODEL_NOT_ALLOWED'; END IF;
      IF item->'payload' ?| ARRAY['moduleId','skillId','revisionId'] THEN RAISE EXCEPTION 'FUSION_GROUP_INVALID'; END IF;
    END IF;
    total:=total+bill2_decimal(item#>'{payload,limits,costUsd}');
    i:=i+1;
  END LOOP;
  IF coalesce(budget#>>'{}','')='' OR total>bill2_decimal(budget) THEN RAISE EXCEPTION 'FUSION_BUDGET_EXCEEDED'; END IF;
  gid:=fusion_group_create(p_actor_id,p_request_id,p_kind,p_source_session_id);
  FOR item IN SELECT value FROM jsonb_array_elements(p_runs) LOOP
    run:=bill2_prepare(p_actor_id,(item->>'requestId')::uuid,item->'payload');
    PERFORM fusion_group_attach(p_actor_id,gid,(run->>'id')::uuid);
    out:=out||jsonb_build_object('runId',run->>'id','fusion',item#>'{payload,input,fusion}');
  END LOOP;
  IF p_kind='compare' THEN
    UPDATE fusion_compares SET group_id=gid,state='running',updated_at=clock_timestamp() WHERE id=fc.id;
  END IF;
  RETURN jsonb_build_object('groupId',gid,'replayed',false,'runs',out);
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['fusion_compare_context(uuid,uuid,integer)','fusion_compare_end(uuid,uuid)',
    'fusion_compare_gate(uuid,uuid,text,boolean)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;
COMMIT;
