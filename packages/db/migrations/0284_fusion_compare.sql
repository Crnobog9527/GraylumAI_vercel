/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- FUSION-COMPARE PR-1 (docs/launch/tasks/FUSION-COMPARE.md §3, §6 PR-1). Number allocated by the controller.
-- Multi-model compare in the free-conversation composer, on the merged Fusion foundation (0234 billing
-- groups, 0235 sessionless runs and outputs). This migration adds:
--  * the compare record (product state: source conversation, frozen history revision, question, models,
--    positioning-gate verdict, workspace dependencies, adoption) — bill2_runs holds money only and
--    fusion_call_outputs holds per-call bodies, so neither can carry it (same reason as fusion_reviews);
--  * a compare branch in fusion_group_admit (compare switch, membership, allowlist, [minModels, D3], budget);
--  * begin / gate / claim / read / stop / adopt functions;
--  * conversation, workspace-source and account erasure coverage for the record.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.fusion_compares (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT fusion_compares_pk PRIMARY KEY,
  actor_id uuid NOT NULL CONSTRAINT fusion_compares_actor_ref REFERENCES public.profiles(id),
  request_id uuid NOT NULL,
  session_id uuid NOT NULL CONSTRAINT fusion_compares_session_ref REFERENCES public.runtime_sessions(id),
  group_id uuid CONSTRAINT fusion_compares_group_ref REFERENCES public.fusion_billing_groups(id),
  history_revision bigint NOT NULL CHECK (history_revision >= 0),
  question text CHECK (question IS NULL OR octet_length(question) BETWEEN 1 AND 90000),
  question_hash text NOT NULL CHECK (question_hash ~ '^[a-f0-9]{64}$'),
  -- Hash of the whole frozen request (session, question, Skill, references, models, shown estimate): a replay
  -- of the same request id with anything else is a conflict, never the old result (like runtime_admission_replay).
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  -- Frozen choices: {models: [modelId...], skill: {moduleId, revisionId, instructionsHash} | null, settings}.
  config jsonb NOT NULL,
  -- clear | allow | block | unavailable; written once by the positioning gate before any group exists.
  gate_verdict text CHECK (gate_verdict IS NULL OR gate_verdict IN ('clear','allow','block','unavailable')),
  workspace_dependencies jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(workspace_dependencies) = 'array'),
  state text NOT NULL CHECK (state IN ('admitting','refused','running','finished','stopped')),
  -- Written once, only by a successful direct write-back: {column, runId, executionId, fromRevision, toRevision}.
  adoption jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fusion_compares_request_unique UNIQUE (actor_id, request_id),
  CHECK (octet_length(config::text) <= 65536 AND octet_length(workspace_dependencies::text) <= 65536)
);
CREATE INDEX IF NOT EXISTS fusion_compares_session_idx ON public.fusion_compares(session_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS fusion_compares_group_idx ON public.fusion_compares(group_id) WHERE group_id IS NOT NULL;
ALTER TABLE public.fusion_compares ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fusion_compares FROM PUBLIC, anon, authenticated, service_role;

-- Compare switch, membership permission and the compare settings, read inside the calling transaction
-- (same facts as fusion_review_settings: paid, consistent membership, then the plan's own compare switch).
CREATE OR REPLACE FUNCTION public.fusion_compare_settings(a uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v jsonb; member_level text;
BEGIN
  SELECT value INTO v FROM system_settings WHERE key='fusion_settings';
  IF jsonb_typeof(v)='string' THEN v:=(v#>>'{}')::jsonb; END IF;
  IF v#>>'{compare,enabled}' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'FUSION_COMPARE_DISABLED'; END IF;
  PERFORM report_membership_check(a);
  SELECT membership_level INTO member_level FROM profiles WHERE id=a;
  IF NOT EXISTS(SELECT 1 FROM membership_plans mp WHERE mp.level=member_level AND mp.allow_fusion_compare) THEN
    RAISE EXCEPTION 'FUSION_COMPARE_FORBIDDEN'; END IF;
  RETURN v;
END $$;

-- D3 (fusion_compare_max_models, 2..8, 0153) and the compare minimum (2 <= minModels <= D3).
CREATE OR REPLACE FUNCTION public.fusion_compare_limits(v jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE d3 integer; lo integer;
BEGIN
  SELECT (value::text)::int INTO d3 FROM system_settings WHERE key='fusion_compare_max_models';
  d3:=coalesce(d3,4);
  lo:=coalesce((v#>>'{compare,minModels}')::int,2);
  IF d3 NOT BETWEEN 2 AND 8 OR lo<2 OR lo>d3 THEN RAISE EXCEPTION 'FUSION_COMPARE_SETTINGS_INVALID'; END IF;
  RETURN jsonb_build_object('min',lo,'max',d3);
END $$;

-- A compare in progress for the user: admitting (fresh), running with an open run, or any Fusion call in
-- flight (a stopped compare whose dispatched calls have not settled still counts, like a review).
CREATE OR REPLACE FUNCTION public.fusion_compare_active(a uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM fusion_compares fc WHERE fc.actor_id=a AND fc.state='admitting'
      AND fc.created_at>clock_timestamp()-interval '5 minutes')
    OR EXISTS(SELECT 1 FROM fusion_compares fc JOIN bill2_runs br ON br.fusion_group_id=fc.group_id
      WHERE fc.actor_id=a AND fc.state='running' AND NOT br.closed)
    OR EXISTS(SELECT 1 FROM bill2_calls c JOIN bill2_runs br ON br.id=c.run_id WHERE br.actor_id=a
      AND br.fusion_group_id IS NOT NULL AND fusion_call_in_flight(c));
$$;

CREATE OR REPLACE FUNCTION public.fusion_compare_view(fc fusion_compares) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('compareId',fc.id,'requestId',fc.request_id,'sessionId',fc.session_id,'groupId',fc.group_id,
    'historyRevision',fc.history_revision,'state',CASE WHEN fc.state='admitting' AND fc.created_at<=clock_timestamp()-interval '5 minutes'
      THEN 'refused' ELSE fc.state END,'gateVerdict',fc.gate_verdict,'config',fc.config,'adoption',fc.adoption,'createdAt',fc.created_at);
$$;

-- Step 1 of a start (FUSION-COMPARE §3.2): record the request before any paid positioning judgement, so one
-- request id triggers at most one Decisions call. Idempotent by request with a request-hash check. Refuses:
-- switch off, no permission, a deleted or foreign conversation, a stale history revision, a model count outside
-- [minModels, D3], duplicates or models outside the allowlist, another compare or review in progress (any Fusion
-- call in flight counts), and the shared Fusion breaker. Nothing is billed here.
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
  models:=p_request#>'{config,models}';
  IF jsonb_typeof(models) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'FUSION_COMPARE_INVALID'; END IF;
  n:=jsonb_array_length(models);
  IF n<(lim->>'min')::int THEN RAISE EXCEPTION 'FUSION_COMPARE_TOO_FEW'; END IF;
  IF n>(lim->>'max')::int THEN RAISE EXCEPTION 'FUSION_COMPARE_TOO_MANY'; END IF;
  IF (SELECT count(DISTINCT x) FROM jsonb_array_elements_text(models) x)<>n
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(models) x WHERE NOT coalesce(v#>'{compare,allowedModelIds}','[]') ? x)
  THEN RAISE EXCEPTION 'FUSION_COMPARE_MODEL_NOT_ALLOWED'; END IF;
  IF fusion_compare_active(p_actor_id) OR EXISTS(SELECT 1 FROM fusion_reviews WHERE actor_id=p_actor_id AND state IN ('running','paused')) THEN
    RAISE EXCEPTION 'FUSION_COMPARE_ACTIVE'; END IF;
  usage:=fusion_review_breaker_usage(p_actor_id);
  IF (usage->>'noDeliveryCalls')::int>=coalesce((v#>>'{compare,breaker,noDeliveryCalls}')::int,10)
    OR (usage->>'platformUsd')::numeric>=coalesce((v#>>'{compare,breaker,platformUsd}')::numeric,2) THEN
    RAISE EXCEPTION 'FUSION_COMPARE_BREAKER'; END IF;
  INSERT INTO fusion_compares(actor_id,request_id,session_id,history_revision,question,question_hash,request_hash,config,
    workspace_dependencies,state)
  VALUES(p_actor_id,p_request_id,s.id,s.revision,p_request->>'question',p_request->>'questionHash',p_request->>'requestHash',
    p_request->'config',coalesce(p_request->'workspaceDependencies','[]'),'admitting')
  RETURNING * INTO fc;
  RETURN fusion_compare_view(fc)||jsonb_build_object('created',true);
END $$;

-- The positioning-gate verdict, written once by the request that created the record. block ends the compare
-- (refused, no group). Repeating the same verdict answers the same view; a different one is a conflict.
CREATE OR REPLACE FUNCTION public.fusion_compare_gate(p_actor_id uuid, p_compare_id uuid, p_verdict text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE fc fusion_compares;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  IF p_verdict NOT IN ('clear','allow','block','unavailable') THEN RAISE EXCEPTION 'FUSION_COMPARE_INVALID'; END IF;
  SELECT * INTO fc FROM fusion_compares WHERE id=p_compare_id AND actor_id=p_actor_id FOR UPDATE;
  IF fc.id IS NULL THEN RAISE EXCEPTION 'FUSION_COMPARE_DENIED'; END IF;
  IF fc.gate_verdict IS NOT NULL THEN
    IF fc.gate_verdict<>p_verdict THEN RAISE EXCEPTION 'FUSION_COMPARE_REQUEST_CONFLICT'; END IF;
    RETURN fusion_compare_view(fc);
  END IF;
  IF fc.state<>'admitting' OR fc.created_at<=clock_timestamp()-interval '5 minutes' THEN RAISE EXCEPTION 'FUSION_COMPARE_ENDED'; END IF;
  UPDATE fusion_compares SET gate_verdict=p_verdict,state=CASE WHEN p_verdict='block' THEN 'refused' ELSE state END,
    updated_at=clock_timestamp() WHERE id=fc.id RETURNING * INTO fc;
  RETURN fusion_compare_view(fc);
END $$;

-- Group admission (0235) with a compare branch. The review branch is unchanged. A compare group is admitted
-- only for a begun compare (same request id, positioning verdict written and not block, not expired): the
-- compare switch, membership permission, allowlist, [minModels, D3], the frozen model order and the compare
-- budget are read in this transaction. On success the compare record is bound to the group and runs.
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
    SELECT * INTO fc FROM fusion_compares WHERE actor_id=p_actor_id AND request_id=p_request_id FOR UPDATE;
    IF fc.id IS NULL OR fc.session_id IS DISTINCT FROM p_source_session_id THEN RAISE EXCEPTION 'FUSION_COMPARE_DENIED'; END IF;
    IF fc.state<>'admitting' OR fc.created_at<=clock_timestamp()-interval '5 minutes' THEN RAISE EXCEPTION 'FUSION_COMPARE_ENDED'; END IF;
    IF fc.gate_verdict IS NULL OR fc.gate_verdict='block' THEN RAISE EXCEPTION 'FUSION_COMPARE_GATE_REQUIRED'; END IF;
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

-- The single group claim of a compare, inside the compare lock (compare row -> runs -> balance, as reviews):
-- a stopped compare never gets a call. Replays return the same batch (0234).
CREATE OR REPLACE FUNCTION public.fusion_compare_claim(p_actor_id uuid, p_compare_id uuid, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE fc fusion_compares;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  SELECT * INTO fc FROM fusion_compares WHERE id=p_compare_id AND actor_id=p_actor_id FOR UPDATE;
  IF fc.id IS NULL OR fc.group_id IS NULL THEN RAISE EXCEPTION 'FUSION_COMPARE_DENIED'; END IF;
  IF fc.state<>'running' THEN RAISE EXCEPTION 'FUSION_COMPARE_ENDED'; END IF;
  RETURN fusion_group_claim(p_actor_id,fc.group_id,'compare:1',1,p_items);
END $$;

-- Columns of a compare in model order: run billing projection (held and charged credits), call progress,
-- verdict and the saved body. Nothing is returned once the conversation is deleted. A running compare whose
-- runs are all closed is reported (and stored) as finished.
CREATE OR REPLACE FUNCTION public.fusion_compare_read(p_actor_id uuid, p_compare_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE fc fusion_compares; cols jsonb;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  SELECT * INTO fc FROM fusion_compares WHERE id=p_compare_id AND actor_id=p_actor_id;
  IF fc.id IS NULL THEN RETURN NULL; END IF;
  PERFORM 1 FROM runtime_sessions WHERE id=fc.session_id AND actor_id=p_actor_id AND content_deleted_at IS NULL AND erased_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF fc.state='running' AND NOT EXISTS(SELECT 1 FROM bill2_runs WHERE fusion_group_id=fc.group_id AND NOT closed) THEN
    UPDATE fusion_compares SET state='finished',updated_at=clock_timestamp() WHERE id=fc.id RETURNING * INTO fc;
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('column',(r.payload#>>'{input,fusion,index}')::int,'runId',r.id,
    'modelId',r.payload->>'modelId','billing',bill2_public(r),
    'call',(SELECT jsonb_build_object('callId',c.id,'state',c.state,'dispatched',c.dispatched_at IS NOT NULL,
      'settled',c.settled_at IS NOT NULL,'verdict',c.fusion_verdict,'inFlight',fusion_call_in_flight(c))
      FROM bill2_calls c WHERE c.run_id=r.id ORDER BY c.sequence LIMIT 1),
    'body',(SELECT o.body FROM fusion_call_outputs o JOIN bill2_calls c ON c.id=o.call_id WHERE c.run_id=r.id LIMIT 1))
    ORDER BY (r.payload#>>'{input,fusion,index}')::int),'[]') INTO cols
  FROM bill2_runs r WHERE r.fusion_group_id=fc.group_id AND r.actor_id=p_actor_id;
  RETURN fusion_compare_view(fc)||jsonb_build_object('question',fc.question,'columns',cols,
    'chargedCredits',(SELECT coalesce(sum(coalesce(r.charged,0)),0) FROM bill2_runs r WHERE r.fusion_group_id=fc.group_id));
END $$;

-- Stop the whole compare (p_run_id NULL) or one column. Undispatched calls are released free; dispatched
-- calls only settle (BILL2 cancel after dispatch). Repeating is a no-op that answers the same view.
CREATE OR REPLACE FUNCTION public.fusion_compare_stop(p_actor_id uuid, p_compare_id uuid, p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE fc fusion_compares; run record;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  SELECT * INTO fc FROM fusion_compares WHERE id=p_compare_id AND actor_id=p_actor_id FOR UPDATE;
  IF fc.id IS NULL THEN RAISE EXCEPTION 'FUSION_COMPARE_DENIED'; END IF;
  IF fc.state='admitting' THEN
    UPDATE fusion_compares SET state='stopped',updated_at=clock_timestamp() WHERE id=fc.id RETURNING * INTO fc;
    RETURN fusion_compare_view(fc);
  END IF;
  IF fc.group_id IS NULL THEN RETURN fusion_compare_view(fc); END IF;
  IF p_run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM bill2_runs WHERE id=p_run_id AND fusion_group_id=fc.group_id) THEN
    RAISE EXCEPTION 'FUSION_COMPARE_DENIED'; END IF;
  IF p_run_id IS NULL AND fc.state='running' THEN
    UPDATE fusion_compares SET state='stopped',updated_at=clock_timestamp() WHERE id=fc.id RETURNING * INTO fc;
  END IF;
  FOR run IN SELECT br.id,br.closed FROM bill2_runs br WHERE br.actor_id=p_actor_id AND br.fusion_group_id=fc.group_id
    AND (p_run_id IS NULL OR br.id=p_run_id) ORDER BY br.id LOOP
    IF NOT run.closed THEN PERFORM bill2_cancel(p_actor_id,run.id); PERFORM bill2_finalize(p_actor_id,run.id); END IF;
  END LOOP;
  RETURN fusion_compare_view(fc);
END $$;

-- "Use this answer" (FUSION-COMPARE §3.4). The chosen column must be closed, judged usable, with its body saved.
-- The main conversation must still be at the frozen revision with no execution in progress; otherwise the
-- answer is returned as a quote (state stale) and nothing changes, repeatably. A successful adoption writes,
-- in one transaction, a zero-amount adoption run frozen exactly like an ordinary turn of this conversation
-- (scope = session scope, the Skill identity and model of that turn; built by the host), an execution bound to
-- it the way runtime_admit binds (prepare -> execution -> session_ref while prepared), then cancels and
-- finalizes the run at zero with no call. The execution ends cancelled: account erasure binds a settled
-- non-delivered run to a cancelled execution (0187). The question and answer become two history items.
-- Written once; the same request id replays the same result; another column is refused.
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
    IF fc.adoption->>'requestId'=p_request_id::text THEN RETURN jsonb_build_object('state','adopted','adoption',fc.adoption); END IF;
    RAISE EXCEPTION 'FUSION_COMPARE_ADOPTED';
  END IF;
  IF fc.group_id IS NULL OR fc.state NOT IN ('running','finished','stopped') THEN RAISE EXCEPTION 'FUSION_COMPARE_DENIED'; END IF;
  SELECT * INTO r FROM bill2_runs WHERE fusion_group_id=fc.group_id AND actor_id=p_actor_id
    AND payload#>>'{input,fusion,index}'=p_column::text;
  SELECT o2.* INTO o FROM fusion_call_outputs o2 JOIN bill2_calls c ON c.id=o2.call_id
    WHERE o2.run_id=r.id AND c.fusion_verdict='usable' AND c.settled_at IS NOT NULL;
  IF r.id IS NULL OR NOT r.closed OR o.call_id IS NULL THEN RAISE EXCEPTION 'FUSION_COMPARE_NOT_ADOPTABLE'; END IF;
  -- The main conversation moved on (or a turn is running): hand back a quote, change nothing.
  IF s.revision<>fc.history_revision OR s.active_execution IS NOT NULL THEN
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

-- A review start also waits for a compare in progress (one multi-model task per user, FUSION-COMPARE §3.4).
DO $$ DECLARE src text; a text; BEGIN
  src:=pg_get_functiondef('public.fusion_review_start(uuid,uuid,uuid,uuid,jsonb)'::regprocedure);
  IF position('fusion_compare_active' IN src)=0 THEN
    a:=$x$  IF EXISTS(SELECT 1 FROM fusion_reviews WHERE actor_id=p_actor_id AND state IN ('running','paused'))$x$;
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: fusion_review_start 0284'; END IF;
    EXECUTE replace(src,a,$x$  IF fusion_compare_active(p_actor_id) OR EXISTS(SELECT 1 FROM fusion_reviews WHERE actor_id=p_actor_id AND state IN ('running','paused'))$x$);
  END IF;
END $$;

-- Erasure. A compare holds the question text and frozen copies of workspace sources (FUSION-COMPARE §3.7).
-- Deleting its conversation (or a project whose draft conversation it came from) deletes the record; 0235
-- already scrubs the group's runs and outputs by source conversation. Deleting a workspace source a compare
-- froze scrubs that compare's runs the same per-run way, deletes its outputs and the record (like ordinary
-- answers whose read_source copied the source, 0218). Account erasure removes and counts the records.
DO $$ DECLARE src text; a text; BEGIN
  src:=pg_get_functiondef('public.content_erasure_confirm(uuid,text,uuid,text)'::regprocedure);
  IF position('-- 0284 fusion compares' IN src)=0 THEN
    a:=$x$ -- 0236 fusion reviews$x$;
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: content_erasure_confirm 0284'; END IF;
    EXECUTE replace(src,a,$x$ -- 0284 fusion compares
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
$x$||a);
  END IF;
END $$;

-- The one-step conversation delete skips the full cleanup only when nothing outside the conversation holds a
-- copy; a compare record (question text) begun from it is such a copy even before it has a billing group.
DO $$ DECLARE src text; a text; BEGIN
  src:=pg_get_functiondef('public.content_erasure_mark_session(uuid,uuid)'::regprocedure);
  IF position('fusion_compares' IN src)=0 THEN
    a:=$x$  AND NOT EXISTS(SELECT 1 FROM fusion_billing_groups fg WHERE fg.source_session_id=target)$x$;
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: content_erasure_mark_session 0284'; END IF;
    EXECUTE replace(src,a,a||$x$
  AND NOT EXISTS(SELECT 1 FROM fusion_compares fcmp WHERE fcmp.session_id=target)$x$);
  END IF;
END $$;

DO $$ DECLARE src text; a text; BEGIN
  src:=pg_get_functiondef('public.account_erasure_scrub_content(uuid)'::regprocedure);
  IF position('fusion_compares' IN src)=0 THEN
    a:=$x$  RETURN counts;$x$;
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: account_erasure_scrub_content 0284'; END IF;
    EXECUTE replace(src,a,$x$  DELETE FROM fusion_compares WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;
  counts := counts || jsonb_build_object('fusion_compares', n);
$x$||a);
  END IF;
  src:=pg_get_functiondef('public.account_erasure_body_remaining(uuid)'::regprocedure);
  IF position('fusion_compares' IN src)=0 THEN
    a:=$x$+(SELECT count(*) FROM fusion_reviews WHERE actor_id=p_profile_id)$x$;
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: account_erasure_body_remaining 0284'; END IF;
    EXECUTE replace(src,a,a||$x$+(SELECT count(*) FROM fusion_compares WHERE actor_id=p_profile_id)$x$);
  END IF;
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['fusion_compare_begin(uuid,uuid,uuid,jsonb)','fusion_compare_gate(uuid,uuid,text)',
    'fusion_compare_claim(uuid,uuid,jsonb)','fusion_compare_read(uuid,uuid)','fusion_compare_stop(uuid,uuid,uuid)',
    'fusion_compare_adopt(uuid,uuid,integer,uuid,jsonb,jsonb)','fusion_group_admit(uuid,uuid,text,uuid,jsonb)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['fusion_compare_settings(uuid)','fusion_compare_limits(jsonb)','fusion_compare_active(uuid)',
    'fusion_compare_view(fusion_compares)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role', f);
  END LOOP;
END $$;

COMMIT;
