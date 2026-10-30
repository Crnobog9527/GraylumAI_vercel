-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-5c (Owner 10-30 option A; ENGINEERING 5, plan 3.1): the mentor's benchmark tools on the turn core.
-- MIGRATION NUMBER IS A LOCAL PLACEHOLDER until the controller assigns one.
--   research_* tables  turn_actor_id/turn_id beside execution_id, which becomes nullable: a turn's research does not depend on
--                      runtime_executions (dropped in V2-12). A turn-keyed row is visible while its session is; erasure works by session.
--   opc_drafts         research_rounds, research_qualified: the fallback counts, written by turn_close, read by turn_mentor_context.
--   research_turn_apply  writes what one turn's research made, only at close, in the close transaction.
--   mentor_turn_prepare  the one read before a non-opening mentor turn: the source check plus the benchmark flow's state.
--   turn_call_begin    limits.toolRows: a benchmark tool call is settled in batches, one receipt each (a crash keeps what was paid).
-- Compatibility: additive columns; the old path keeps writing execution_id and reads the same rows. Idempotent. Recovery: the new
-- columns can stay; re-apply the previous bodies. Rows written by turn research have a NULL execution_id, so V2-12 must keep them.
ALTER TABLE public.research_plans ADD COLUMN IF NOT EXISTS turn_actor_id uuid, ADD COLUMN IF NOT EXISTS turn_id bigint;
ALTER TABLE public.research_selection_cards ADD COLUMN IF NOT EXISTS turn_actor_id uuid, ADD COLUMN IF NOT EXISTS turn_id bigint;
ALTER TABLE public.research_selection_cards ALTER COLUMN execution_id DROP NOT NULL;
ALTER TABLE public.research_discoveries ADD COLUMN IF NOT EXISTS turn_actor_id uuid, ADD COLUMN IF NOT EXISTS turn_id bigint;
ALTER TABLE public.research_discoveries ALTER COLUMN execution_id DROP NOT NULL;
ALTER TABLE public.research_account_fetches ADD COLUMN IF NOT EXISTS turn_actor_id uuid, ADD COLUMN IF NOT EXISTS turn_id bigint,
  ADD COLUMN IF NOT EXISTS last_success_turn_id bigint, ADD COLUMN IF NOT EXISTS pasted_turns bigint[] NOT NULL DEFAULT '{}';
ALTER TABLE public.research_benchmarks ADD COLUMN IF NOT EXISTS turn_actor_id uuid, ADD COLUMN IF NOT EXISTS turn_id bigint;
ALTER TABLE public.research_benchmarks ALTER COLUMN execution_id DROP NOT NULL;
ALTER TABLE public.research_benchmark_shortfalls ADD COLUMN IF NOT EXISTS turn_actor_id uuid, ADD COLUMN IF NOT EXISTS turn_id bigint;
ALTER TABLE public.research_benchmark_shortfalls ALTER COLUMN execution_id DROP NOT NULL;
ALTER TABLE public.research_refresh_grants ADD COLUMN IF NOT EXISTS source_turn_id bigint, ADD COLUMN IF NOT EXISTS used_turn_id bigint;
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.research_refresh_grants'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%used_execution_id%' LOOP
    EXECUTE format('ALTER TABLE public.research_refresh_grants DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE public.research_refresh_grants ADD CONSTRAINT research_refresh_grants_used_check
  CHECK ((used_at IS NULL) = (used_execution_id IS NULL AND used_turn_id IS NULL));
ALTER TABLE public.opc_drafts ADD COLUMN IF NOT EXISTS research_rounds integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS research_qualified integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.research_user_cards(a uuid, s uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE output jsonb;
BEGIN
 PERFORM research_session_owned(a,s,NULL);
 SELECT coalesce(jsonb_agg(jsonb_build_object('cardId',c.id,'kind',c.kind,'options',c.options,
  'minSelect',c.min_select,'maxSelect',c.max_select,'confirmationId',c.confirmation_id,'items',c.confirmed_items)
  ORDER BY c.created_at,c.id),'[]'::jsonb) INTO output FROM research_selection_cards c
 LEFT JOIN runtime_executions x ON x.id=c.execution_id AND x.actor_id=a AND x.session_id=s
 WHERE c.actor_id=a AND c.session_id=s AND (c.turn_id IS NOT NULL OR (x.id IS NOT NULL AND x.content_deleted_at IS NULL AND x.erased_at IS NULL));
 RETURN output;
END $function$;;

CREATE OR REPLACE FUNCTION public.research_benchmark_qualified(a uuid, s uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT count(*)::integer FROM research_benchmarks b
  LEFT JOIN runtime_executions x ON x.id=b.execution_id AND x.actor_id=a AND x.session_id=s
  WHERE b.actor_id=a AND b.session_id=s AND b.qualified AND (b.turn_id IS NOT NULL OR (x.id IS NOT NULL AND x.content_deleted_at IS NULL AND x.erased_at IS NULL))
$function$;;

CREATE OR REPLACE FUNCTION public.research_benchmark_shortfall_latest(a uuid, s uuid)
 RETURNS research_benchmark_shortfalls
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT b.* FROM research_benchmark_shortfalls b
  LEFT JOIN runtime_executions x ON x.id=b.execution_id AND x.actor_id=a AND x.session_id=s
  WHERE b.actor_id=a AND b.session_id=s AND (b.turn_id IS NOT NULL OR (x.id IS NOT NULL AND x.content_deleted_at IS NULL AND x.erased_at IS NULL))
  ORDER BY b.created_at DESC,b.id DESC LIMIT 1
$function$;;

CREATE OR REPLACE FUNCTION public.research_benchmark_shortfall_accepted(a uuid, s uuid, req integer)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT research_benchmark_qualified(a,s)>=1 AND research_benchmark_rounds(a,s)>=2
    AND EXISTS(SELECT 1 FROM research_benchmark_shortfalls b
      LEFT JOIN runtime_executions x ON x.id=b.execution_id AND x.actor_id=a AND x.session_id=s
      WHERE b.actor_id=a AND b.session_id=s AND b.choice='generate' AND b.required>=req
        AND (b.turn_id IS NOT NULL OR (x.id IS NOT NULL AND x.content_deleted_at IS NULL AND x.erased_at IS NULL)))
$function$;;

CREATE OR REPLACE FUNCTION public.research_benchmark_table(a uuid, s uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE output jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object('platform',b.platform,'account',b.account,'followers',b.followers,
    'medianViews',b.median_views,'engagementRate',b.engagement_rate,'postsPerWeek',b.posts_per_week,
    'lastPublishedAt',b.last_published_at,'postsAnalyzed',b.posts_analyzed,'category',b.category,'qualified',b.qualified,
    'excluded',b.excluded,'missing',to_jsonb(b.missing),'fetchedAt',b.fetched_at)
    ORDER BY b.qualified DESC,b.followers DESC NULLS LAST,b.platform,b.account),'[]'::jsonb) INTO output
  FROM (SELECT b.* FROM research_benchmarks b
    LEFT JOIN runtime_executions x ON x.id=b.execution_id AND x.actor_id=a AND x.session_id=s
    WHERE b.actor_id=a AND b.session_id=s AND (b.turn_id IS NOT NULL OR (x.id IS NOT NULL AND x.content_deleted_at IS NULL AND x.erased_at IS NULL))
    ORDER BY b.qualified DESC,b.followers DESC NULLS LAST,b.platform,b.account LIMIT 30) b;
  RETURN jsonb_build_object('rows',output,'hash',encode(sha256(convert_to(output::text,'utf8')),'hex'));
END $function$;;

CREATE OR REPLACE FUNCTION public.research_chat_benchmark_accounts(a uuid, s uuid, e uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE sessions uuid[];
BEGIN
 PERFORM research_session_owned(a,s,e);
 -- Exactly the tables a free chat can read: the benchmark entries runtime_workspace_source lists for this caller (the
 -- confirmed positioning's own session, positioning version still allowed), never an older or unconfirmed table.
 SELECT coalesce(array_agg((x->>'sessionId')::uuid),ARRAY[]::uuid[]) INTO sessions
 FROM jsonb_array_elements(runtime_workspace_source(a,s,'')->'entries') x WHERE x->>'kind'='benchmarks';
 -- Same rows and order as the entry's body (live answers of that session, at most 30).
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('platform',b.platform,'account',b.account)),'[]'::jsonb)
  FROM (SELECT DISTINCT ON (t.platform,t.account) t.platform,t.account FROM (
    SELECT rb.platform,rb.account,row_number() OVER (PARTITION BY rb.session_id
      ORDER BY rb.qualified DESC,rb.followers DESC NULLS LAST,rb.platform,rb.account) n
    FROM research_benchmarks rb
    LEFT JOIN runtime_executions x ON x.id=rb.execution_id AND x.actor_id=a AND x.session_id=rb.session_id
     AND (rb.turn_id IS NOT NULL OR (x.id IS NOT NULL AND x.content_deleted_at IS NULL AND x.erased_at IS NULL))
    WHERE rb.actor_id=a AND rb.session_id=ANY(sessions)) t WHERE t.n<=30
   ORDER BY t.platform,t.account) b);
END $function$;;

CREATE OR REPLACE FUNCTION public.research_user_benchmarks(a uuid, s uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE output jsonb;
BEGIN
  PERFORM research_session_owned(a,s,NULL);
  SELECT coalesce(jsonb_agg(jsonb_build_object('platform',b.platform,'account',b.account,'followers',b.followers,
    'medianViews',b.median_views,'engagementRate',b.engagement_rate,'postsPerWeek',b.posts_per_week,
    'lastPublishedAt',b.last_published_at,'postsAnalyzed',b.posts_analyzed,'category',b.category,'qualified',b.qualified,
    'excluded',b.excluded,'fetchedAt',b.fetched_at,'topicRelevance',b.topic_relevance,
    'refs',jsonb_build_object(
      'followers',CASE WHEN b.followers IS NULL OR b.excluded='EVIDENCE_UNVERIFIED' THEN '[]'::jsonb ELSE coalesce(b.refs->'followers','[]'::jsonb) END,
      'medianViews',CASE WHEN b.median_views IS NULL OR b.excluded='EVIDENCE_UNVERIFIED' THEN '[]'::jsonb ELSE coalesce(b.refs->'medianViews','[]'::jsonb) END,
      'engagementRate',CASE WHEN b.engagement_rate IS NULL OR b.excluded='EVIDENCE_UNVERIFIED' THEN '[]'::jsonb ELSE coalesce(b.refs->'engagementRate','[]'::jsonb) END,
      'postsPerWeek',CASE WHEN b.posts_per_week IS NULL OR b.excluded='EVIDENCE_UNVERIFIED' THEN '[]'::jsonb ELSE coalesce(b.refs->'postsPerWeek','[]'::jsonb) END,
      'lastPublishedAt',CASE WHEN b.last_published_at IS NULL OR b.excluded='EVIDENCE_UNVERIFIED' THEN '[]'::jsonb ELSE coalesce(b.refs->'lastPublishedAt','[]'::jsonb) END))
    ORDER BY b.qualified DESC,b.topic_relevance DESC NULLS LAST,b.followers DESC NULLS LAST,b.platform,b.account),'[]'::jsonb) INTO output
  FROM (SELECT b.*,
      -- The relevance benchmark_fetch computed into this row's own fetch evidence (a 0–1 share; anything else is NULL).
      CASE WHEN jsonb_typeof(f.last_success->'relevance'->'value')='number'
        AND (f.last_success->'relevance'->>'value')::numeric BETWEEN 0 AND 1
        THEN (f.last_success->'relevance'->>'value')::numeric END AS topic_relevance
    FROM research_benchmarks b
    LEFT JOIN runtime_executions x ON x.id=b.execution_id AND x.actor_id=a AND x.session_id=s
    LEFT JOIN research_account_fetches f ON f.id=b.fetch_id AND f.actor_id=a
    WHERE b.actor_id=a AND b.session_id=s AND (b.turn_id IS NOT NULL OR (x.id IS NOT NULL AND x.content_deleted_at IS NULL AND x.erased_at IS NULL))
    ORDER BY b.qualified DESC,topic_relevance DESC NULLS LAST,b.followers DESC NULLS LAST,b.platform,b.account LIMIT 30) b;
  RETURN output;
END $function$;;

CREATE OR REPLACE FUNCTION public.research_runtime_read(a uuid, s uuid, e uuid, p_kind text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v jsonb;
BEGIN
  PERFORM research_session_owned(a,s,e);
  CASE p_kind
  WHEN 'operation' THEN
    SELECT jsonb_build_object('identityHash',o.identity_hash,'state',o.state,'result',o.result,'executionId',p.execution_id) INTO v
    FROM research_operations o JOIN research_plans p ON p.id=o.plan_id
    LEFT JOIN runtime_executions x ON x.id=p.execution_id AND x.actor_id=a AND x.session_id=s
    WHERE o.id=p_id AND p.actor_id=a AND p.session_id=s AND o.erased_at IS NULL AND p.erased_at IS NULL
    AND (p.turn_id IS NOT NULL OR (x.id IS NOT NULL AND x.content_deleted_at IS NULL AND x.erased_at IS NULL));
  WHEN 'plan' THEN
    SELECT jsonb_build_object('executionId',p.execution_id,'discoveryId',p.discovery_id,'operations',p.operations,
      'budgetUnits',p.budget_units,'cancelled',p.cancelled) INTO v FROM research_plans p
    LEFT JOIN runtime_executions x ON x.id=p.execution_id AND x.actor_id=a AND x.session_id=s
    WHERE p.id=p_id AND p.actor_id=a AND p.session_id=s AND p.erased_at IS NULL
    AND (p.turn_id IS NOT NULL OR (x.id IS NOT NULL AND x.content_deleted_at IS NULL AND x.erased_at IS NULL));
  WHEN 'discovery' THEN
    SELECT jsonb_build_object('discoveryId',d.id,'keywords',d.keywords,'platforms',d.platforms,'cursor',d.cursor,'state',d.state)
    INTO v FROM research_discoveries d
    JOIN research_selection_cards c ON c.confirmation_id=d.keyword_confirmation_id AND c.actor_id=a
    LEFT JOIN runtime_executions src ON src.id=c.execution_id
    LEFT JOIN runtime_executions x ON x.id=d.execution_id AND x.actor_id=a AND x.session_id=s
    WHERE (c.turn_id IS NOT NULL OR (src.id IS NOT NULL AND src.content_deleted_at IS NULL AND src.erased_at IS NULL))
      AND d.id=p_id AND d.actor_id=a AND d.session_id=s AND (d.turn_id IS NOT NULL OR (x.id IS NOT NULL AND x.content_deleted_at IS NULL AND x.erased_at IS NULL));
  WHEN 'refresh' THEN
    SELECT jsonb_build_object('platform',g.platform,'account',g.account,'used',g.used_at IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM research_account_fetches f WHERE f.actor_id=a AND f.session_id=s AND f.refresh_id=g.id
      AND f.state='prepared' AND f.platform=g.platform AND f.account_key=encode(sha256(convert_to(s::text||':'||research_account_key(g.platform,g.account),'utf8')),'hex')))
    INTO v FROM research_refresh_grants g
    LEFT JOIN runtime_executions x ON x.id=g.source_execution_id AND x.actor_id=a AND x.session_id=s
    WHERE g.id=p_id AND g.actor_id=a AND g.session_id=s
    AND (g.source_turn_id IS NOT NULL OR (x.id IS NOT NULL AND x.content_deleted_at IS NULL AND x.erased_at IS NULL))
    AND (g.used_execution_id IS NULL OR EXISTS(SELECT 1 FROM runtime_executions u WHERE u.id=g.used_execution_id
      AND u.actor_id=a AND u.session_id=s AND u.content_deleted_at IS NULL AND u.erased_at IS NULL));
  WHEN 'selected' THEN
    SELECT coalesce(jsonb_agg(item),'[]'::jsonb) INTO v FROM research_selection_cards c
    LEFT JOIN runtime_executions x ON x.id=c.execution_id AND x.actor_id=a AND x.session_id=s
    CROSS JOIN LATERAL jsonb_array_elements(c.confirmed_items) item
    WHERE c.actor_id=a AND c.session_id=s AND c.discovery_id=p_id AND c.kind='candidates' AND c.confirmation_id IS NOT NULL
    AND (c.turn_id IS NOT NULL OR (x.id IS NOT NULL AND x.content_deleted_at IS NULL AND x.erased_at IS NULL));
  WHEN 'card' THEN
    SELECT jsonb_build_object('cardId',c.id,'kind',c.kind,'options',c.options,'minSelect',c.min_select,'maxSelect',c.max_select,
      'confirmationId',c.confirmation_id,'items',c.confirmed_items)
    INTO v FROM research_selection_cards c
    LEFT JOIN runtime_executions x ON x.id=c.execution_id AND x.actor_id=a AND x.session_id=s
    WHERE c.id=p_id AND c.actor_id=a AND c.session_id=s AND (c.turn_id IS NOT NULL OR (x.id IS NOT NULL AND x.content_deleted_at IS NULL AND x.erased_at IS NULL));
  ELSE RAISE EXCEPTION 'RESEARCH_READ_INVALID';
  END CASE;
  RETURN v;
END $function$;;

CREATE OR REPLACE FUNCTION public.research_user_evidence(a uuid, p_limit integer, p_cursor_time timestamp with time zone, p_cursor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE output jsonb;
BEGIN
 PERFORM bill2_actor(a);
 IF p_limit NOT BETWEEN 1 AND 101 OR (p_cursor_time IS NULL)<>(p_cursor_id IS NULL)
 THEN RAISE EXCEPTION 'RESEARCH_SCOPE_DENIED' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(row ORDER BY stamp DESC,oid DESC),'[]'::jsonb) INTO output FROM (
  SELECT o.created_at stamp,o.id oid,jsonb_build_object(
   'operationId',o.id,'toolName',o.result->>'toolName','args',o.result->'args','state',o.state,
   'query',o.result->'call'->>'query','platform',o.result->'call'->>'platform','dataKind',o.result->'call'->>'dataKind',
   'fetchedAt',o.result->>'fetchedAt',
   'itemCount',CASE WHEN jsonb_typeof(o.result->'items')='array' THEN jsonb_array_length(o.result->'items') END,
   'truncated',o.result->'truncated',
   'sources',coalesce((SELECT jsonb_agg(item->>'url') FROM jsonb_array_elements(
     CASE WHEN jsonb_typeof(o.result->'items')='array' THEN o.result->'items' ELSE '[]'::jsonb END) item
     WHERE jsonb_typeof(item->'url')='string'),'[]'::jsonb),
   'sessionId',s.id,'sessionTitle',coalesce(n.name,(SELECT left(nullif(btrim(t.payload->>'input'),''),80)
     FROM runtime_executions t WHERE t.session_id=s.id AND t.actor_id=a
     AND t.content_deleted_at IS NULL AND t.erased_at IS NULL ORDER BY t.created_at,t.id LIMIT 1)),
   'createdAt',o.created_at) row
  FROM research_operations o JOIN research_plans p ON p.id=o.plan_id AND p.actor_id=a
  JOIN runtime_sessions s ON s.id=p.session_id AND s.actor_id=a
  LEFT JOIN runtime_executions x ON x.id=p.execution_id AND x.actor_id=a AND x.session_id=s.id
  LEFT JOIN runtime_session_names n ON n.session_id=s.id AND n.actor_id=a
  WHERE o.erased_at IS NULL AND p.erased_at IS NULL AND (p.turn_id IS NOT NULL OR (x.id IS NOT NULL AND x.content_deleted_at IS NULL AND x.erased_at IS NULL))
   AND s.content_deleted_at IS NULL AND s.erased_at IS NULL AND o.state IN ('succeeded','failed','unknown')
   AND (p_cursor_time IS NULL OR (o.created_at,o.id)<(p_cursor_time,p_cursor_id))
  ORDER BY o.created_at DESC,o.id DESC LIMIT p_limit
 ) records;
 RETURN output;
END $function$;;

CREATE OR REPLACE FUNCTION public.research_user_unfinished_round(a uuid, s uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d research_discoveries; x runtime_executions; marker text; t turns;
BEGIN
  PERFORM research_session_owned(a,s,NULL);
  SELECT * INTO d FROM research_discoveries WHERE actor_id=a AND session_id=s ORDER BY created_at DESC, id DESC LIMIT 1;
  IF d.id IS NULL OR d.state<>'running' THEN RETURN NULL; END IF;
  marker:=d.cursor->>'continueFrom';
  IF marker IS NULL OR marker !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
  -- A round a turn stopped: the marker is that turn's request id.
  SELECT * INTO t FROM turns WHERE actor_id=a AND session_id=s AND request_id=marker::uuid;
  IF t.id IS NOT NULL THEN
    IF t.state<>'closed' OR t.close_kind<>'completed' OR t.closed_at < clock_timestamp() - interval '30 minutes'
     OR EXISTS(SELECT 1 FROM turns y WHERE y.actor_id=a AND y.session_id=s AND y.id>t.id) THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('discoveryId',d.id,'executionId',t.request_id,
      'replies',greatest(1,CASE WHEN jsonb_typeof(d.cursor->'executions')='array' THEN jsonb_array_length(d.cursor->'executions') ELSE 1 END));
  END IF;
  SELECT * INTO x FROM runtime_executions WHERE id=marker::uuid AND actor_id=a AND session_id=s;
  IF x.id IS NULL OR x.state<>'completed' OR x.content_deleted_at IS NOT NULL OR x.erased_at IS NOT NULL
   OR x.result->>'completeness' IS NOT DISTINCT FROM 'stopped' OR x.result->>'stopped' IS NOT DISTINCT FROM 'true'
   OR x.created_at < clock_timestamp() - interval '30 minutes' THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM runtime_executions y WHERE y.actor_id=a AND y.session_id=s AND y.id<>x.id
    AND (y.created_at,y.id)>(x.created_at,x.id)) THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('discoveryId',d.id,'executionId',x.id,
    'replies',greatest(1,CASE WHEN jsonb_typeof(d.cursor->'executions')='array' THEN jsonb_array_length(d.cursor->'executions') ELSE 1 END));
END $function$;;

CREATE OR REPLACE FUNCTION public.research_refresh_create(a uuid, s uuid, p_platform text, p_account text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE g uuid; src uuid; src_turn bigint;
BEGIN
  PERFORM research_session_owned(a,s,NULL);
  SELECT last_success_execution_id, last_success_turn_id INTO src, src_turn FROM research_account_fetches WHERE session_id=s AND actor_id=a AND platform=p_platform
    AND account_key=encode(sha256(convert_to(s::text||':'||research_account_key(p_platform,p_account),'utf8')),'hex') AND last_success IS NOT NULL AND state NOT IN ('prepared','in_progress','failed_charged');
  IF src IS NULL AND src_turn IS NULL THEN RAISE EXCEPTION 'RESEARCH_REFRESH_INVALID';END IF;
  INSERT INTO research_refresh_grants(actor_id,session_id,platform,account,source_execution_id,source_turn_id)
    VALUES(a,s,p_platform,p_account,src,src_turn) RETURNING id INTO g;
  RETURN g;
END $function$;;

CREATE OR REPLACE FUNCTION public.research_operation_settled(o research_operations)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT o.state IN ('succeeded','failed','cancelled')
    OR (o.bill2_call_id IS NOT NULL AND o.state IN ('prepared','dispatched','unknown')
      AND EXISTS(SELECT 1 FROM bill2_calls c WHERE c.id=o.bill2_call_id AND c.settled_at IS NOT NULL))
    -- A turn's operation is written at close: its unknown cost is the turn's receipt, kept on turn_calls for recovery.
    OR EXISTS(SELECT 1 FROM research_plans p WHERE p.id=o.plan_id AND p.turn_id IS NOT NULL)
$function$;;

CREATE OR REPLACE FUNCTION public.runtime_workspace_source(p_actor_id uuid, p_session_id uuid, p_query text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE entries jsonb;entry jsonb;body text;version_id uuid;cap integer:=4000;produced jsonb;strategy jsonb;fit jsonb;profile jsonb;
BEGIN
 IF NOT runtime_workspace_session(p_actor_id,p_session_id) THEN RAISE EXCEPTION 'RUNTIME_WORKSPACE_DENIED';END IF;
 IF length(coalesce(p_query,''))>2000 THEN RAISE EXCEPTION 'RUNTIME_WORKSPACE_QUERY_DENIED';END IF;
 -- Metadata is requested by the model, not loaded into every conversation.
 SELECT coalesce(jsonb_agg(x.entry ORDER BY x.rank,x.id),'[]') INTO entries FROM (
  SELECT 0 rank,b.id::text id,jsonb_build_object('id',b.id,'kind','positioning','name',b.name,'confirmedAt',v.created_at,'sourceVersionId',b.current_source_version_id)
   -- 0301: a finalized report with strategy data is read by its own id; it takes none of the 40 places.
   ||CASE WHEN opc_strategy_data(b.current_source_version_id) IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('strategyReport',
    jsonb_build_object('id','strategy_report:'||b.id,'use','Finalized report strategy data with these confirmed fields: next steps, '
     ||'this week, 30-day plan and metrics, monetization, audience, benchmarks, assumptions.')) END entry
  FROM opc_businesses b JOIN artifact_versions v ON v.id=b.current_source_version_id WHERE b.actor_id=p_actor_id AND b.erased_at IS NULL AND b.current_source_version_id IS NOT NULL
   AND opc_source_allowed(p_actor_id,b.current_source_version_id)
  UNION ALL
  SELECT 1,s.session_id::text,jsonb_build_object('id',s.session_id,'kind','benchmarks','name',b.name,'sessionId',s.session_id,
   'accounts',s.accounts,'qualified',s.qualified,'fetchedAt',s.fetched_at,'sourceVersionId',b.current_source_version_id,
   'producedBy',s.produced_by,
   'use','Real public data of benchmark accounts fetched during positioning research; numbers come only from this table.')
  FROM opc_businesses b CROSS JOIN LATERAL (
   SELECT d.session_id,count(*)::int accounts,(count(*) FILTER (WHERE rb.qualified))::int qualified,max(rb.fetched_at) fetched_at,
    jsonb_agg(DISTINCT jsonb_strip_nulls(jsonb_build_object('executionId',rb.execution_id,'turnId',rb.turn_id))) produced_by
   FROM opc_draft_businesses db JOIN opc_drafts d ON d.draft_id=db.draft_id AND d.actor_id=p_actor_id
    AND d.project_id=(SELECT cv.project_id FROM artifact_versions cv WHERE cv.id=b.current_source_version_id)
   JOIN runtime_sessions rs ON rs.id=d.session_id AND rs.actor_id=p_actor_id AND rs.content_deleted_at IS NULL AND rs.erased_at IS NULL
   JOIN research_benchmarks rb ON rb.session_id=d.session_id AND rb.actor_id=p_actor_id
   LEFT JOIN runtime_executions x ON x.id=rb.execution_id AND x.actor_id=p_actor_id AND x.session_id=d.session_id
   WHERE db.business_id=b.id AND (rb.turn_id IS NOT NULL OR (x.id IS NOT NULL AND x.content_deleted_at IS NULL AND x.erased_at IS NULL)) GROUP BY d.session_id ORDER BY max(rb.fetched_at) DESC,d.session_id LIMIT 1) s
  WHERE b.actor_id=p_actor_id AND b.erased_at IS NULL AND b.current_source_version_id IS NOT NULL
   AND opc_source_allowed(p_actor_id,b.current_source_version_id)
  UNION ALL
  SELECT 2,ac.project_id::text,jsonb_build_object('id',ac.project_id,'kind','strategy','platform',ac.platform,'account',coalesce((SELECT display_name FROM opc_account_ui WHERE actor_id=p_actor_id AND account_project_id=ac.project_id),ac.account_key),'sourceVersionId',ac.source_version_id)
  FROM opc_accounts ac WHERE ac.actor_id=p_actor_id AND opc_source_allowed(p_actor_id,ac.source_version_id)
  UNION ALL
  SELECT 2,i.work_item_id::text,jsonb_build_object('id',i.work_item_id,'kind','topic','platform',ac.platform,'account',coalesce((SELECT display_name FROM opc_account_ui WHERE actor_id=p_actor_id AND account_project_id=ac.project_id),ac.account_key),'title',coalesce((SELECT title FROM opc_item_edits WHERE work_item_id=i.work_item_id),p.work_title),'sourceVersionId',i.source_version_id)
  FROM opc_items i JOIN opc_accounts ac ON ac.project_id=i.account_project_id JOIN artifact_projects p ON p.id=i.work_item_id AND p.actor_id=p_actor_id
  WHERE ac.actor_id=p_actor_id AND opc_source_allowed(p_actor_id,i.source_version_id)
  ORDER BY rank,id LIMIT 40
 ) x;
 -- B2 own posts: no changes to the existing directory entries or dependencies.
 DECLARE post_entries jsonb:='[]';days integer:=0;chosen jsonb;
 BEGIN
  IF (SELECT value='true'::jsonb FROM system_settings WHERE key='chat_my_posts_enabled')
   AND (SELECT value='true'::jsonb FROM system_settings WHERE key='publish_monitor_enabled') THEN
   days:=runtime_workspace_post_window(p_actor_id);
   SELECT jsonb_agg(jsonb_build_object('id','my_posts:'||d,'kind','my_posts','name','我的作品 · '||d||' 天',
    'windowDays',d,'use','Saved own post metrics, free to read. Default 14 days. At most two reads per answer.') ORDER BY d)
    INTO post_entries FROM unnest(ARRAY[14,30,90]) d WHERE d=14 OR d<=days;
  END IF;
  IF coalesce(p_query,'')='' THEN
   RETURN jsonb_build_object('kind','workspace_index','entries',entries||post_entries,'limit',40+jsonb_array_length(post_entries),
    'dependencies',(SELECT coalesce(jsonb_agg(DISTINCT x->>'sourceVersionId'),'[]') FROM jsonb_array_elements(entries) x));
  END IF;
  IF p_query IN ('my_posts','my_posts:14','my_posts:30','my_posts:90') THEN
   SELECT x INTO chosen FROM jsonb_array_elements(post_entries) x WHERE x->>'id'=CASE WHEN p_query='my_posts' THEN 'my_posts:14' ELSE p_query END;
   IF chosen IS NULL THEN RETURN jsonb_build_object('kind','unavailable','dependencies','[]'::jsonb);END IF;
   -- The current claim is already journaled: a third attempt must stop before the host calls PR-3a's data reader.
   IF (SELECT count(*) FROM runtime_sessions active_s JOIN runtime_tool_calls t ON t.execution_id=active_s.active_execution
    WHERE active_s.id=p_session_id AND active_s.actor_id=p_actor_id AND t.name='read_source'
     AND t.arguments->>'query' IN ('my_posts','my_posts:14','my_posts:30','my_posts:90'))>2 THEN
    RETURN jsonb_build_object('kind','unavailable','reason','read_limit','dependencies','[]'::jsonb,'note','本条回答的作品读取次数已用完');
   END IF;
   RETURN jsonb_build_object('kind','workspace_posts_request','windowDays',(chosen->>'windowDays')::int,'entitled',days>0,'review',coalesce((SELECT value='true'::jsonb
   FROM system_settings WHERE key='publish_monitor_review_enabled'),false)); -- PR6 review descriptor
  END IF;
 END;
 IF coalesce(p_query,'')='' THEN
  RETURN jsonb_build_object('kind','workspace_index','entries',entries,'limit',40,'dependencies',(SELECT coalesce(jsonb_agg(DISTINCT x->>'sourceVersionId'),'[]') FROM jsonb_array_elements(entries) x));
 END IF;
 -- 0301: one read gives the confirmed fields and both strategy groups; over 48000 bytes whole strategy fields are
 -- dropped in the fixed order (listed in strategyDropped), never the confirmed fields and never a cut JSON.
 IF p_query LIKE 'strategy\_report:%' THEN
  SELECT x INTO entry FROM jsonb_array_elements(entries) x WHERE x->>'kind'='positioning' AND x->'strategyReport'->>'id'=p_query;
  strategy:=CASE WHEN entry IS NULL THEN NULL ELSE opc_strategy_data((entry->>'sourceVersionId')::uuid) END;
  IF strategy IS NULL THEN RETURN jsonb_build_object('kind','unavailable','dependencies','[]'::jsonb);END IF;
  version_id:=(entry->>'sourceVersionId')::uuid;profile:=opc_profile(version_id);
  fit:=report_strategy_fit(strategy->'data',report_strategy_fields(),greatest(0,48000-octet_length(coalesce(profile,'null'::jsonb)::text)));
  RETURN jsonb_build_object('kind','workspace_source',
   'identity',(entry-'strategyReport')||jsonb_build_object('id',p_query,'kind','strategy_report','positioningId',entry->'id'),
   'body',jsonb_build_object('profile',profile,'strategy',fit->'strategy','strategyTextEdited',strategy->'textEdited',
    'strategyDropped',fit->'dropped','use',opc_strategy_use()),
   'truncated',jsonb_array_length(fit->'dropped')>0,'dependencies',jsonb_build_array(version_id));
 END IF;
 SELECT x INTO entry FROM jsonb_array_elements(entries) x WHERE x->>'id'=p_query;
 IF entry IS NULL THEN RETURN jsonb_build_object('kind','unavailable','dependencies','[]'::jsonb);END IF;
 version_id:=(entry->>'sourceVersionId')::uuid;
 IF entry->>'kind' IN ('strategy','positioning') THEN body:=opc_profile(version_id)::text;
 ELSIF entry->>'kind'='benchmarks' THEN
  -- 0299 unchanged: one statement, one snapshot. The rows (same projection as research_benchmark_table: live answers of
  -- this session, at most 30, same order) and the answers they came from are computed together, so producedBy always
  -- describes the body even if a content erasure commits meanwhile.
  SELECT coalesce(jsonb_agg(jsonb_build_object('platform',b.platform,'account',b.account,'followers',b.followers,
    'medianViews',b.median_views,'engagementRate',b.engagement_rate,'postsPerWeek',b.posts_per_week,
    'lastPublishedAt',b.last_published_at,'postsAnalyzed',b.posts_analyzed,'category',b.category,'qualified',b.qualified,
    'excluded',b.excluded,'missing',to_jsonb(b.missing),'fetchedAt',b.fetched_at)
    ORDER BY b.qualified DESC,b.followers DESC NULLS LAST,b.platform,b.account),'[]'::jsonb)::text,
   coalesce(jsonb_agg(DISTINCT jsonb_strip_nulls(jsonb_build_object('executionId',b.execution_id,'turnId',b.turn_id))),'[]'::jsonb) INTO body,produced
  FROM (SELECT rb.* FROM research_benchmarks rb
    LEFT JOIN runtime_executions x ON x.id=rb.execution_id AND x.actor_id=p_actor_id AND x.session_id=rb.session_id
    WHERE rb.actor_id=p_actor_id AND rb.session_id=(entry->>'sessionId')::uuid
      AND (rb.turn_id IS NOT NULL OR (x.id IS NOT NULL AND x.content_deleted_at IS NULL AND x.erased_at IS NULL))
    ORDER BY rb.qualified DESC,rb.followers DESC NULLS LAST,rb.platform,rb.account LIMIT 30) b;
  cap:=8000;
  RETURN jsonb_build_object('kind','workspace_source','identity',entry-'producedBy'-'accounts'-'qualified'-'fetchedAt','body',left(body,cap),'truncated',length(body)>cap,
   'producedBy',produced,'dependencies',jsonb_build_array(version_id));
 ELSE SELECT coalesce((SELECT ed.brief FROM opc_item_edits ed WHERE ed.work_item_id=i.work_item_id),i.brief) INTO body FROM opc_items i WHERE i.work_item_id=(entry->>'id')::uuid;END IF;
 RETURN jsonb_build_object('kind','workspace_source','identity',entry,'body',left(body,cap),'truncated',length(body)>cap,'dependencies',jsonb_build_array(version_id));
END $function$;;

CREATE OR REPLACE FUNCTION public.runtime_workspace_benchmark_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE a uuid;s uuid;sessions uuid[];one jsonb;
BEGIN
 -- A read of one benchmark table ('workspace_source') or an index listing one ('workspace_index'): both carry producedBy.
 IF NEW.name<>'read_source' OR NEW.result IS NULL THEN RETURN NEW;END IF;
 IF NEW.result->>'kind'='workspace_source' AND NEW.result#>>'{identity,kind}'='benchmarks' THEN
  sessions:=ARRAY[(NEW.result#>>'{identity,sessionId}')::uuid];
 ELSIF NEW.result->>'kind'='workspace_index' THEN
  sessions:=ARRAY(SELECT (e->>'sessionId')::uuid FROM jsonb_array_elements(NEW.result->'entries') e WHERE e->>'kind'='benchmarks');
 END IF;
 IF coalesce(cardinality(sessions),0)=0 THEN RETURN NEW;END IF;
 SELECT actor_id INTO a FROM runtime_executions WHERE id=NEW.execution_id;
 PERFORM p.id FROM artifact_projects p JOIN opc_drafts od ON od.project_id=p.id
  WHERE od.session_id=ANY(sessions) AND p.actor_id=a ORDER BY p.id FOR SHARE OF p;
 FOR one IN SELECT x FROM jsonb_array_elements(CASE WHEN NEW.result->>'kind'='workspace_index'
   THEN (SELECT coalesce(jsonb_agg(e),'[]') FROM jsonb_array_elements(NEW.result->'entries') e WHERE e->>'kind'='benchmarks')
   ELSE jsonb_build_array(NEW.result||jsonb_build_object('sessionId',NEW.result#>>'{identity,sessionId}')) END) x LOOP
  s:=(one->>'sessionId')::uuid;
  IF NOT EXISTS(SELECT 1 FROM runtime_sessions rs WHERE rs.id=s AND rs.actor_id=a AND rs.content_deleted_at IS NULL AND rs.erased_at IS NULL)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(one->'producedBy','[]'::jsonb)) i
    WHERE i ? 'executionId' AND NOT EXISTS(SELECT 1 FROM runtime_executions x WHERE x.id=(i->>'executionId')::uuid AND x.actor_id=a
     AND x.session_id=s AND x.content_deleted_at IS NULL AND x.erased_at IS NULL))
  THEN RAISE EXCEPTION 'RUNTIME_WORKSPACE_SOURCE_REVOKED';END IF;
 END LOOP;
 RETURN NEW;
END $function$;;

CREATE OR REPLACE FUNCTION public.opc_draft_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP='DELETE' AND public.erasure_business_delete_allowed('opc_drafts',to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;
 IF TG_OP='DELETE' OR to_jsonb(OLD)-ARRAY['round_id','research_rounds','research_qualified'] IS DISTINCT FROM to_jsonb(NEW)-ARRAY['round_id','research_rounds','research_qualified'] THEN RAISE EXCEPTION 'OPC_IMMUTABLE_DRAFT';END IF;RETURN NEW;
END $function$;;

CREATE OR REPLACE FUNCTION public.research_benchmark_rounds(a uuid, s uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT (
    SELECT count(*) FROM research_discoveries d
    LEFT JOIN runtime_executions x ON x.id=d.execution_id AND x.actor_id=a AND x.session_id=s
    WHERE d.actor_id=a AND d.session_id=s AND d.state='completed'
      AND (d.turn_id IS NOT NULL OR (x.id IS NOT NULL AND x.content_deleted_at IS NULL AND x.erased_at IS NULL))
  )::integer + (
    SELECT count(*) FROM runtime_executions x
    WHERE x.actor_id=a AND x.session_id=s AND x.content_deleted_at IS NULL AND x.erased_at IS NULL
      AND EXISTS (SELECT 1 FROM research_account_fetches f
        WHERE f.actor_id=a AND f.session_id=s AND x.id=ANY(f.pasted_executions))
      AND NOT EXISTS (SELECT 1 FROM research_discoveries d
        WHERE d.execution_id=x.id AND d.actor_id=a AND d.session_id=s AND d.state='completed')
  )::integer + (
    -- A turn's pasted-link check, unless that turn also completed a discovery (one turn, one round, as above).
    SELECT count(DISTINCT p)::integer FROM research_account_fetches f CROSS JOIN LATERAL unnest(f.pasted_turns) p
    WHERE f.actor_id=a AND f.session_id=s AND NOT EXISTS (SELECT 1 FROM research_discoveries d
      WHERE d.turn_id=p AND d.actor_id=a AND d.session_id=s AND d.state='completed')
  )
$function$;;

CREATE OR REPLACE FUNCTION public.research_benchmark_project(f research_account_fetches)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE e jsonb:=f.last_success; m jsonb; c jsonb; refs jsonb:='{}'; ops uuid[]:='{}'; key text; ref text; item jsonb;
  ok boolean:=true; expected double precision; actual double precision; viewed text[]; rated text[]; analyzed_refs text[]; analyzed_count integer;
BEGIN
  IF e IS NULL OR (f.last_success_execution_id IS NULL AND f.last_success_turn_id IS NULL) OR f.account IS NULL OR f.last_success_attempt IS NULL THEN
    DELETE FROM research_benchmarks WHERE fetch_id=f.id;
    RETURN;
  END IF;
  -- research_account_fetch_finish already validated the shape of a successful cache.
  m:=e->'metrics';c:=e->'classification';
  -- Numbers built on erased research evidence go with it (content erasure deletes such rows): never (re)create one,
  -- not even as an unverified row, e.g. when the migration backfills a cache whose evidence was erased since.
  IF EXISTS(SELECT 1 FROM research_operations o WHERE o.erased_at IS NOT NULL AND o.id IN (
      SELECT split_part(r,'#',1)::uuid FROM jsonb_each(m) k
      CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(k.value->'refs')='array' THEN k.value->'refs' ELSE '[]' END) r
      WHERE r ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}#[1-9][0-9]{0,4}$'
      UNION SELECT research_benchmark_operation_id(f.id,f.last_success_attempt,k) FROM unnest(ARRAY['account_profile','account_posts']) k)) THEN
    DELETE FROM research_benchmarks WHERE fetch_id=f.id;
    RETURN;
  END IF;
  FOREACH key IN ARRAY ARRAY['followers','medianViews','engagementRate','postsPerWeek','lastPublishedAt','earliestPublishedAt'] LOOP
    refs:=refs||jsonb_build_object(key,m->key->'refs');
    FOR ref IN SELECT jsonb_array_elements_text(m->key->'refs') LOOP
      item:=research_benchmark_item(f.actor_id,f.session_id,ref);
      IF item IS NULL THEN ok:=false;
      ELSE ops:=ops||(split_part(ref,'#',1))::uuid;END IF;
    END LOOP;
  END LOOP;
  -- Every cited operation is a subcall of this very fetch attempt (not another account fetched in the same session).
  -- 0315 paged posts: a later page of the posts list is a subcall of this fetch attempt too.
  ok:=ok AND ops<@(ARRAY(SELECT research_benchmark_operation_id(f.id,f.last_success_attempt,k)
    FROM unnest(ARRAY['account_profile','account_posts','account_relation','post_detail']) k)||research_benchmark_post_operations(f.id,f.last_success_attempt));
  -- A whole-history claim (the new-account exception to the 20-post minimum) needs this fetch's own profile to report
  -- no more posts than were analyzed (suppliedWholeHistory in research/benchmark/metrics.ts).
  IF ok AND (m->'wholeHistory')::boolean THEN
    item:=research_benchmark_item(f.actor_id,f.session_id,research_benchmark_operation_id(f.id,f.last_success_attempt,'account_profile')::text||'#1');
    ok:=coalesce(jsonb_typeof(item->'postsCount')='number' AND (m->>'postsAnalyzed')::numeric>=(item->>'postsCount')::numeric,false)
      -- ...counting distinct post ids: every item carries one and none repeats (as suppliedWholeHistory).
      AND coalesce((SELECT count(*)=count(DISTINCT x->'fields'->>'id') AND coalesce(bool_and(jsonb_typeof(x->'fields'->'id')='string'
          AND length(x->'fields'->>'id')>0),true) AND count(DISTINCT x->'fields'->>'id')>=(item->>'postsCount')::numeric
        FROM research_operations o JOIN research_plans p ON p.id=o.plan_id
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.result->'items')='array' THEN o.result->'items' ELSE '[]' END) x
        JOIN unnest(research_benchmark_post_operations(f.id,f.last_success_attempt)) WITH ORDINALITY pg(op,page) ON pg.op=o.id
        WHERE p.actor_id=f.actor_id
          AND p.session_id=f.session_id AND o.state='succeeded' AND o.erased_at IS NULL
          -- As benchmark_fetch: a later page's repeat of an earlier page's post is dropped before counting.
          AND NOT EXISTS(SELECT 1 FROM research_operations o2 JOIN research_plans p2 ON p2.id=o2.plan_id
            JOIN unnest(research_benchmark_post_operations(f.id,f.last_success_attempt)) WITH ORDINALITY pg2(op,page) ON pg2.op=o2.id
            CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o2.result->'items')='array' THEN o2.result->'items' ELSE '[]' END) x2
            WHERE pg2.page<pg.page AND p2.actor_id=f.actor_id AND p2.session_id=f.session_id AND o2.state='succeeded'
              AND o2.erased_at IS NULL AND x2->'fields'->>'id'=x->'fields'->>'id')),false);
  END IF;
  -- Single-item numbers equal the item field they name.
  IF ok AND m->'followers'->'value'<>'null'::jsonb THEN
    item:=research_benchmark_item(f.actor_id,f.session_id,m->'followers'->'refs'->>0);
    ok:=jsonb_array_length(m->'followers'->'refs')=1 AND jsonb_typeof(item->'followers')='number'
      AND (item->>'followers')::numeric=(m->'followers'->>'value')::numeric;
  END IF;
  FOREACH key IN ARRAY ARRAY['lastPublishedAt','earliestPublishedAt'] LOOP
    IF ok AND m->key->'value'<>'null'::jsonb THEN
      item:=research_benchmark_item(f.actor_id,f.session_id,m->key->'refs'->>0);
      ok:=jsonb_array_length(m->key->'refs')=1 AND jsonb_typeof(item->'publishedAt')='string'
        AND pg_input_is_valid(item->>'publishedAt','timestamp with time zone')
        AND abs(extract(epoch FROM (item->>'publishedAt')::timestamptz-(m->key->>'value')::timestamptz))<0.001;
    END IF;
  END LOOP;
  -- The medians cite exactly the eligible posts, not a chosen subset: of this attempt's own account_posts items, the
  -- newest 30 (accountMetrics: dated newest first, then undated in supplier order; a time over 5 minutes ahead is
  -- missing), those with views (median), and those with views > 0 and all three counters (engagement).
  IF ok THEN
    -- One entry per post identity (the first in supplier order), as accountMetrics: a repeated post is not more posts.
    WITH entries AS (
      SELECT pg.page,pg.op,t.i,t.x->'fields' fl,coalesce(nullif(t.x->'fields'->>'id',''),'#'||pg.page||':'||t.i) post_key,CASE WHEN jsonb_typeof(t.x->'fields'->'publishedAt')='string'
          AND pg_input_is_valid(t.x->'fields'->>'publishedAt','timestamp with time zone')
          AND (t.x->'fields'->>'publishedAt')::timestamptz<=(e->>'fetchedAt')::timestamptz+interval '5 minutes'
        THEN (t.x->'fields'->>'publishedAt')::timestamptz END published
      FROM research_operations o JOIN research_plans p ON p.id=o.plan_id
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.result->'items')='array' THEN o.result->'items' ELSE '[]' END)
        WITH ORDINALITY t(x,i)
      JOIN unnest(research_benchmark_post_operations(f.id,f.last_success_attempt)) WITH ORDINALITY pg(op,page) ON pg.op=o.id
      WHERE p.actor_id=f.actor_id
        AND p.session_id=f.session_id AND o.state='succeeded' AND o.erased_at IS NULL
    ), items AS (SELECT DISTINCT ON (post_key) * FROM entries ORDER BY post_key,page,i),
    analyzed AS (SELECT * FROM items ORDER BY published DESC NULLS LAST,page,i LIMIT 30)
    SELECT coalesce(array_agg(r ORDER BY r) FILTER (WHERE v),'{}'),coalesce(array_agg(r ORDER BY r) FILTER (WHERE v AND rate),'{}'),
        coalesce(array_agg(r ORDER BY r),'{}'),count(*)
      INTO viewed,rated,analyzed_refs,analyzed_count FROM (SELECT op::text||'#'||i r,
        jsonb_typeof(fl->'views')='number' AND (fl->>'views')::numeric>=0 v,
        coalesce((fl->>'views')::numeric>0,false) AND jsonb_typeof(fl->'likes')='number' AND (fl->>'likes')::numeric>=0
        AND jsonb_typeof(fl->'comments')='number' AND (fl->>'comments')::numeric>=0
        AND jsonb_typeof(fl->'shares')='number' AND (fl->>'shares')::numeric>=0 rate FROM analyzed) z;
    ok:=ARRAY(SELECT jsonb_array_elements_text(m->'medianViews'->'refs') ORDER BY 1)=viewed
      AND ARRAY(SELECT jsonb_array_elements_text(m->'engagementRate'->'refs') ORDER BY 1)=rated
      -- A known weekly frequency cites every analyzed post once (all of them are dated).
      AND (m->'postsPerWeek'->'value'='null'::jsonb
        OR ARRAY(SELECT jsonb_array_elements_text(m->'postsPerWeek'->'refs') ORDER BY 1)=analyzed_refs);
  END IF;
  -- Medians are recomputed from the items (same rule as accountMetrics: the middle value, or the mean of the two).
  IF ok AND m->'medianViews'->'value'<>'null'::jsonb THEN
    SELECT bool_and(jsonb_typeof(x->'views')='number'),percentile_cont(0.5) WITHIN GROUP (ORDER BY (x->>'views')::double precision)
      INTO ok,actual FROM (SELECT research_benchmark_item(f.actor_id,f.session_id,r) x
        FROM jsonb_array_elements_text(m->'medianViews'->'refs') r) z;
    expected:=(m->'medianViews'->>'value')::double precision;
    ok:=coalesce(ok,false) AND abs(actual-expected)<=1e-9*greatest(1,abs(expected));
  END IF;
  IF ok AND m->'engagementRate'->'value'<>'null'::jsonb THEN
    SELECT bool_and(jsonb_typeof(x->'views')='number' AND (x->>'views')::numeric>0 AND jsonb_typeof(x->'likes')='number'
        AND jsonb_typeof(x->'comments')='number' AND jsonb_typeof(x->'shares')='number'),
      percentile_cont(0.5) WITHIN GROUP (ORDER BY ((x->>'likes')::double precision+(x->>'comments')::double precision
        +(x->>'shares')::double precision)/nullif((x->>'views')::double precision,0))
      INTO ok,actual FROM (SELECT research_benchmark_item(f.actor_id,f.session_id,r) x
        FROM jsonb_array_elements_text(m->'engagementRate'->'refs') r) z;
    expected:=(m->'engagementRate'->>'value')::double precision;
    ok:=coalesce(ok,false) AND abs(actual-expected)<=1e-9*greatest(1,abs(expected));
  END IF;
  -- Weekly frequency (accountMetrics: posts in the 30 days before the fetch × 7 ÷ 30, known only when every analyzed
  -- post is dated) is recounted from its refs, which are then exactly the analyzed posts. The metrics time precedes
  -- fetchedAt by moments, so a post on the window edge may count either way (5 minutes, as for qualification).
  IF ok AND m->'postsPerWeek'->'value'<>'null'::jsonb THEN
    SELECT bool_and(jsonb_typeof(x->'publishedAt')='string' AND pg_input_is_valid(x->>'publishedAt','timestamp with time zone')),
      count(*) FILTER (WHERE (x->>'publishedAt')::timestamptz>=(e->>'fetchedAt')::timestamptz-interval '30 days'),
      count(*) FILTER (WHERE (x->>'publishedAt')::timestamptz>=(e->>'fetchedAt')::timestamptz-interval '30 days 5 minutes')
      INTO ok,actual,expected FROM (SELECT research_benchmark_item(f.actor_id,f.session_id,r) x
        FROM jsonb_array_elements_text(m->'postsPerWeek'->'refs') r) z;
    -- Known only for the whole history, or when the oldest analyzed post is already outside the window (a page whose
    -- oldest post is still inside may hide more posts: accountMetrics reports the frequency as unknown).
    ok:=coalesce(ok,false) AND jsonb_array_length(m->'postsPerWeek'->'refs')=(m->>'postsAnalyzed')::integer
      AND ((m->'wholeHistory')::boolean OR (SELECT min((x->>'publishedAt')::timestamptz) FROM (
        SELECT research_benchmark_item(f.actor_id,f.session_id,r) x FROM jsonb_array_elements_text(m->'postsPerWeek'->'refs') r) z)
        <(e->>'fetchedAt')::timestamptz-interval '30 days')
      AND round((m->'postsPerWeek'->>'value')::numeric*30/7,6) BETWEEN actual AND expected
      AND round((m->'postsPerWeek'->>'value')::numeric*30/7,6)=trunc(round((m->'postsPerWeek'->>'value')::numeric*30/7,6));
  END IF;
  -- The analyzed count is exactly accountMetrics' newest 30 distinct posts of this attempt's own account_posts operation.
  IF ok THEN
    ok:=coalesce((m->>'postsAnalyzed')::integer=analyzed_count AND EXISTS(SELECT 1 FROM research_operations o
      JOIN research_plans p ON p.id=o.plan_id
      WHERE o.id=research_benchmark_operation_id(f.id,f.last_success_attempt,'account_posts') AND p.actor_id=f.actor_id
        AND p.session_id=f.session_id AND o.state='succeeded' AND o.erased_at IS NULL AND jsonb_typeof(o.result->'items')='array'),false);
  END IF;
  -- The category must agree with the thresholds the numbers support.
  IF ok THEN
    ok:=CASE
      WHEN c->>'category'='head_reference' THEN (m->'followers'->>'value')::numeric>200000
      WHEN c->>'category' IN ('imitable','fast_rising') THEN (m->'followers'->>'value')::numeric BETWEEN 10000 AND 200000
        AND (m->>'postsAnalyzed')::integer>0 AND m->'lastPublishedAt'->'value'<>'null'::jsonb
        AND (m->'lastPublishedAt'->>'value')::timestamptz>=(e->>'fetchedAt')::timestamptz-interval '30 days 5 minutes'
        AND ((m->>'postsAnalyzed')::integer>=20 OR (m->'wholeHistory')::boolean)
      ELSE NOT coalesce((c->'qualified')::boolean,false) END;
  END IF;
  -- Any check that could not be evaluated (a missing item) counts as failed, never as unknown.
  ok:=coalesce(ok,false);
  INSERT INTO research_benchmarks AS b(fetch_id,actor_id,session_id,execution_id,turn_actor_id,turn_id,platform,account,followers,median_views,
    engagement_rate,posts_per_week,last_published_at,earliest_published_at,posts_analyzed,whole_history,category,qualified,
    excluded,refs,operation_ids,missing,fetched_at)
  VALUES(f.id,f.actor_id,f.session_id,f.last_success_execution_id,f.turn_actor_id,f.last_success_turn_id,f.platform,f.account,
    CASE WHEN ok THEN (m->'followers'->>'value')::numeric END,CASE WHEN ok THEN (m->'medianViews'->>'value')::numeric END,
    CASE WHEN ok THEN (m->'engagementRate'->>'value')::numeric END,CASE WHEN ok THEN (m->'postsPerWeek'->>'value')::numeric END,
    CASE WHEN ok THEN (m->'lastPublishedAt'->>'value')::timestamptz END,
    CASE WHEN ok THEN (m->'earliestPublishedAt'->>'value')::timestamptz END,
    CASE WHEN ok THEN (m->>'postsAnalyzed')::integer ELSE 0 END,
    ok AND (m->'wholeHistory')::boolean,
    CASE WHEN ok THEN c->>'category' END,ok AND (c->'qualified')::boolean,
    CASE WHEN ok THEN c->>'excluded' ELSE 'EVIDENCE_UNVERIFIED' END,
    -- Every operation the row was derived or checked from, cited or not (an uncited posts request still gives the
    -- analyzed count), so erasing any of them deletes the row.
    refs,ARRAY(SELECT DISTINCT x FROM unnest(ops||ARRAY(SELECT o.id FROM research_operations o
      WHERE o.id IN (SELECT research_benchmark_operation_id(f.id,f.last_success_attempt,k)
        FROM unnest(ARRAY['account_profile','account_posts','account_relation','post_detail']) k)
        OR o.id=ANY(research_benchmark_post_operations(f.id,f.last_success_attempt)))) x ORDER BY x),
    ARRAY(SELECT jsonb_array_elements_text(m->'missing')),(e->>'fetchedAt')::timestamptz)
  ON CONFLICT (fetch_id) DO UPDATE SET execution_id=excluded.execution_id,turn_actor_id=excluded.turn_actor_id,turn_id=excluded.turn_id,account=excluded.account,
    followers=excluded.followers,median_views=excluded.median_views,engagement_rate=excluded.engagement_rate,
    posts_per_week=excluded.posts_per_week,last_published_at=excluded.last_published_at,
    earliest_published_at=excluded.earliest_published_at,posts_analyzed=excluded.posts_analyzed,whole_history=excluded.whole_history,
    category=excluded.category,
    qualified=excluded.qualified,excluded=excluded.excluded,refs=excluded.refs,operation_ids=excluded.operation_ids,
    missing=excluded.missing,fetched_at=excluded.fetched_at,updated_at=clock_timestamp();
END $function$;;

CREATE OR REPLACE FUNCTION public.research_account_fetch_finish(a uuid, p_fetch uuid, p_attempt uuid, p_state text, p_evidence jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE f research_account_fetches; metric text;
BEGIN
  -- A success must carry its evidence: a paid result without it could be neither reused nor refreshed.
  IF p_state NOT IN ('succeeded','unknown','failed','failed_charged') OR (p_state='succeeded' AND jsonb_typeof(p_evidence) IS DISTINCT FROM 'object')
  THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
  IF p_state='succeeded' THEN
    SELECT * INTO f FROM research_account_fetches WHERE id=p_fetch AND actor_id=a;
    -- The host cache is accountMetrics + classification; query/source/call records remain in research_operations.
    IF p_evidence->>'platform' IS DISTINCT FROM f.platform
     OR research_account_key(f.platform,p_evidence->>'account') IS DISTINCT FROM research_account_key(f.platform,f.account)
     OR jsonb_typeof(p_evidence->'fetchedAt') IS DISTINCT FROM 'string'
     OR NOT pg_input_is_valid(p_evidence->>'fetchedAt','timestamp with time zone')
     OR jsonb_typeof(p_evidence->'metrics') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_evidence->'metrics'->'postsAnalyzed') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_evidence->'metrics'->'missing') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_evidence->'metrics'->'wholeHistory') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(p_evidence->'classification'->'qualified') IS DISTINCT FROM 'boolean'
     OR NOT coalesce(p_evidence->'classification' ?& ARRAY['category','excluded'],false)
    THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
    FOREACH metric IN ARRAY ARRAY['followers','medianViews','engagementRate','postsPerWeek','lastPublishedAt','earliestPublishedAt'] LOOP
      IF jsonb_typeof(p_evidence->'metrics'->metric) IS DISTINCT FROM 'object'
       OR NOT (p_evidence->'metrics'->metric ? 'value')
       OR jsonb_typeof(p_evidence->'metrics'->metric->'refs') IS DISTINCT FROM 'array'
      THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
    END LOOP;
    IF (p_evidence->'metrics'->>'postsAnalyzed')::numeric NOT BETWEEN 0 AND 30
     OR trunc((p_evidence->'metrics'->>'postsAnalyzed')::numeric)<>(p_evidence->'metrics'->>'postsAnalyzed')::numeric
     OR NOT isfinite((p_evidence->>'fetchedAt')::timestamptz)
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_evidence->'metrics'->'missing') x
       WHERE jsonb_typeof(x)<>'string' OR x#>>'{}' NOT IN ('followers','medianViews','engagementRate','postsPerWeek','lastPublishedAt'))
    THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
    FOREACH metric IN ARRAY ARRAY['followers','medianViews','engagementRate','postsPerWeek','lastPublishedAt','earliestPublishedAt'] LOOP
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_evidence->'metrics'->metric->'refs') x
         WHERE jsonb_typeof(x)<>'string' OR length(btrim(x#>>'{}'))=0)
       OR ((p_evidence->'metrics'->metric->'value'='null'::jsonb)
         IS DISTINCT FROM (jsonb_array_length(p_evidence->'metrics'->metric->'refs')=0))
      THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
      IF p_evidence->'metrics'->metric->'value'<>'null'::jsonb THEN
        IF metric IN ('lastPublishedAt','earliestPublishedAt') THEN
          IF jsonb_typeof(p_evidence->'metrics'->metric->'value')<>'string'
           OR NOT pg_input_is_valid(p_evidence->'metrics'->metric->>'value','timestamp with time zone')
          THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
          IF NOT isfinite((p_evidence->'metrics'->metric->>'value')::timestamptz)
          THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
        ELSE
          IF jsonb_typeof(p_evidence->'metrics'->metric->'value')<>'number'
          THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
          IF (p_evidence->'metrics'->metric->>'value')::numeric NOT BETWEEN 0 AND 1.7976931348623157e308
          THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
        END IF;
      END IF;
    END LOOP;
    -- Classification is a tagged union: a known category with no exclusion, or an unqualified exclusion.
    IF NOT coalesce((p_evidence->'classification'->>'category' IN ('head_reference','imitable','fast_rising')
       AND p_evidence->'classification'->'excluded'='null'::jsonb
       AND (p_evidence->'classification'->>'category'<>'head_reference' OR p_evidence->'classification'->'qualified'='false'::jsonb))
      OR (p_evidence->'classification'->'category'='null'::jsonb
       AND p_evidence->'classification'->'qualified'='false'::jsonb
       AND p_evidence->'classification'->>'excluded' IN ('FOLLOWERS_MISSING','FOLLOWERS_BELOW_MIN','NO_PUBLISH_TIME','INACTIVE_30_DAYS','NO_POSTS',
       -- 0268 too few posts
       'TOO_FEW_POSTS')),false)
    THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
  END IF;
  -- A sent attempt ends in any state; an attempt never sent can only end as a (free) failure.
  UPDATE research_account_fetches SET state=p_state,evidence=p_evidence,updated_at=clock_timestamp(),
    last_success=CASE WHEN p_state='succeeded' THEN p_evidence ELSE last_success END,
    last_success_execution_id=CASE WHEN p_state='succeeded' THEN execution_id ELSE last_success_execution_id END,
    last_success_turn_id=CASE WHEN p_state='succeeded' THEN turn_id ELSE last_success_turn_id END
  WHERE id=p_fetch AND actor_id=a AND attempt=p_attempt AND (state='in_progress' OR (state='prepared' AND p_state='failed'));
  IF NOT FOUND AND NOT EXISTS(SELECT 1 FROM research_account_fetches WHERE id=p_fetch AND actor_id=a AND attempt=p_attempt
    AND state=p_state AND evidence IS NOT DISTINCT FROM p_evidence) THEN RAISE EXCEPTION 'RESEARCH_FETCH_CONFLICT';END IF;
  -- 0411: the whole verification of this account just completed (this is the only place a fetch ends as succeeded). When the
  -- answer that ran it did so for links the user pasted (a succeeded supplier operation of that answer for this account, whose
  -- source is user_message), keep that answer in pasted_executions. The list only ever grows: a later refresh re-claims the
  -- row and moves its execution_id and state, but never takes this record away. research_benchmark_rounds counts it.
  IF p_state='succeeded' THEN
    UPDATE research_account_fetches u SET pasted_executions=array_append(u.pasted_executions,u.execution_id)
    WHERE u.id=p_fetch AND u.actor_id=a AND u.attempt=p_attempt AND u.state='succeeded' AND u.execution_id IS NOT NULL
      AND NOT (u.execution_id=ANY(u.pasted_executions))
      AND EXISTS(SELECT 1 FROM research_plans p JOIN research_operations o ON o.plan_id=p.id
        WHERE p.execution_id=u.execution_id AND p.actor_id=a AND p.session_id=u.session_id AND p.erased_at IS NULL
          AND o.erased_at IS NULL AND o.state='succeeded' AND o.result->'args'->'source'->>'kind'='user_message'
          AND o.result->'call'->>'platform'=u.platform
          AND research_account_key(u.platform,o.result->'call'->>'query')=research_account_key(u.platform,u.account));
  END IF;
END $function$;;

CREATE OR REPLACE FUNCTION public.turn_call_begin(p_actor_id uuid, p_turn_id bigint, p_seq integer, p_call_kind text, p_model_id uuid, p_tool_name text, p_paid boolean, p_request_hash text, p_upper_usd numeric, p_multiplier numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; c turn_calls; q numeric; used integer; need integer; n_model integer; n_paid integer; n_free integer;
  n_decision integer;
BEGIN
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id FOR UPDATE;
  IF t.id IS NULL THEN RAISE EXCEPTION 'TURN_DENIED' USING ERRCODE='42501'; END IF;
  SELECT * INTO c FROM turn_calls WHERE turn_id = p_turn_id AND seq = p_seq;
  IF c.turn_id IS NOT NULL THEN
    IF c.request_hash <> p_request_hash THEN RAISE EXCEPTION 'TURN_CALL_CONFLICT' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('state', t.state, 'status', c.status, 'replay', true) || turn_tombstones(p_actor_id, t.session_id, t.policy);
  END IF;
  IF t.state <> 'running' THEN RAISE EXCEPTION 'TURN_NOT_RUNNING' USING ERRCODE='55000'; END IF;
  IF p_seq <> coalesce((SELECT max(seq) FROM turn_calls WHERE turn_id = p_turn_id), 0) + 1 THEN
    RAISE EXCEPTION 'TURN_CALL_SEQUENCE' USING ERRCODE='22023';
  END IF;
  IF (p_call_kind = 'tool') IS DISTINCT FROM (p_paid IS NOT NULL) THEN RAISE EXCEPTION 'TURN_CALL_INVALID' USING ERRCODE='22023'; END IF;
  -- A model whose cost went above its bound is blocked until an administrator has checked its price and metering (BILL2).
  IF p_call_kind = 'model' AND EXISTS (SELECT 1 FROM turn_calls WHERE model_id = p_model_id AND budget_conflict
      AND conflict_reviewed_at IS NULL) THEN
    RAISE EXCEPTION 'TURN_MODEL_METERING_BLOCKED' USING ERRCODE='P0001';
  END IF;
  -- Frozen limits (2.5.3): attempts that certainly cost nothing (not_sent, rejected, 402) do not count against them. M counts
  -- the model calls the user pays for; the positioning check (decision) is its own limit outside M (Fable 10-28).
  SELECT count(*) FILTER (WHERE call_kind = 'model'),
         count(*) FILTER (WHERE call_kind = 'tool' AND upper_usd > 0),
         count(*) FILTER (WHERE call_kind = 'tool' AND upper_usd = 0),
         count(*) FILTER (WHERE call_kind = 'decision')
    INTO n_model, n_paid, n_free, n_decision
  FROM turn_calls WHERE turn_id = p_turn_id AND status NOT IN ('not_sent','rejected','no_charge_402');
  IF (p_call_kind = 'model' AND n_model >= (t.policy->'limits'->>'model')::int)
    OR (p_call_kind = 'decision' AND n_decision >= coalesce((t.policy->'limits'->>'decisions')::int, 0))
    OR (p_call_kind = 'tool' AND p_paid AND n_paid >= coalesce((t.policy->'limits'->>'toolRows')::int, (t.policy->'limits'->>'paidTools')::int))
    OR (p_call_kind = 'tool' AND NOT p_paid AND n_free >= (t.policy->'limits'->>'freeTools')::int)
    OR (p_call_kind = 'tool' AND NOT p_paid AND p_upper_usd <> 0) OR (p_paid AND p_upper_usd <= 0) THEN
    RAISE EXCEPTION 'TURN_CALL_LIMIT' USING ERRCODE='22023';
  END IF;
  -- The remaining freeze must cover min(G_i, L): this call's bound G_i = ceil(q x U_i x m_i), or the start threshold L when the
  -- freeze was capped by the balance (H = min(G, A), Owner 10-01 and 10-28: a balance that covers one normal turn starts it; the
  -- part of a call above the freeze is the platform's, E = N - D). Below that the turn waits for credits. The positioning check
  -- is never charged to the user (Owner 10-12): it needs no freeze; its upper bound counts in U_turn and the stop-loss only.
  q := (t.policy->>'q')::numeric;
  SELECT coalesce(sum(CASE WHEN status = 'ok' THEN ceil(q * nominal_usd * multiplier)
                           WHEN status IN ('dispatched','identified','unknown') THEN ceil(q * upper_usd * multiplier)
                           ELSE 0 END), 0) INTO used
  FROM turn_calls WHERE turn_id = p_turn_id AND call_kind <> 'decision';
  need := CASE WHEN p_call_kind = 'decision' THEN 0
    ELSE least(ceil(q * p_upper_usd * p_multiplier), coalesce((t.policy->>'minCredits')::numeric, ceil(q * p_upper_usd * p_multiplier))) END;
  IF t.reserved_credits - used < need THEN
    UPDATE turns SET state = 'paused', pause_reason = 'waiting_credits', updated_at = now() WHERE actor_id = p_actor_id AND id = p_turn_id;
    RETURN jsonb_build_object('state', 'paused', 'paused', true) || turn_tombstones(p_actor_id, t.session_id, t.policy);
  END IF;
  INSERT INTO turn_calls (actor_id, turn_id, seq, call_kind, model_id, tool_name, request_hash, upper_usd, multiplier)
    VALUES (p_actor_id, p_turn_id, p_seq, p_call_kind, p_model_id, p_tool_name, p_request_hash, p_upper_usd, p_multiplier);
  UPDATE turns SET updated_at = now() WHERE actor_id = p_actor_id AND id = p_turn_id;
  RETURN jsonb_build_object('state', 'running', 'status', 'dispatched', 'replay', false) || turn_tombstones(p_actor_id, t.session_id, t.policy);
END $function$;;

CREATE OR REPLACE FUNCTION public.turn_mentor_context(p_actor_id uuid, p_session_id uuid, p_mentor jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d opc_drafts; p artifact_projects; r artifact_rounds; spec jsonb; v_step text := p_mentor->>'stepId';
  b opc_businesses; st jsonb; step_id text; field_id text; metas jsonb; steps jsonb; suggestions jsonb := '{}';
  suggestion jsonb;
BEGIN
  SELECT * INTO d FROM opc_drafts WHERE actor_id = p_actor_id AND session_id = p_session_id;
  IF d.draft_id IS NULL THEN RAISE EXCEPTION 'TURN_MENTOR_DENIED' USING ERRCODE='42501'; END IF;
  -- The draft's own scope, narrow: revoked or tombstoned is refused here. What needs the whole source and evidence chain (an
  -- account-strategy draft, a business with a source) is mentor_source_check, which Node calls before this turn opens; a draft that needs it is refused unless it ran.
  IF NOT turn_mentor_draft_allowed(p_actor_id, d.draft_id) THEN RAISE EXCEPTION 'TURN_MENTOR_DENIED' USING ERRCODE='42501'; END IF;
  IF EXISTS (SELECT 1 FROM bill2_drafts WHERE actor_id = p_actor_id AND revoked
      AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(coalesce(p_mentor->'sourceDrafts', '[]')))) THEN
    RAISE EXCEPTION 'TURN_MENTOR_DENIED' USING ERRCODE='42501';
  END IF;
  -- An archived business is read-only (as opc_assert_business_writable, without its row lock).
  SELECT x.* INTO b FROM opc_draft_businesses db JOIN opc_businesses x ON x.id = db.business_id AND x.actor_id = p_actor_id
   WHERE db.draft_id = d.draft_id;
  IF b.archived_at IS NOT NULL THEN RAISE EXCEPTION 'TURN_MENTOR_ARCHIVED' USING ERRCODE='42501'; END IF;
  IF p_mentor->'sourceChecked' IS DISTINCT FROM 'true'::jsonb AND (b.current_source_version_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM opc_account_strategy_drafts WHERE draft_id = d.draft_id)) THEN
    RAISE EXCEPTION 'TURN_SOURCE_CHECK_REQUIRED' USING ERRCODE='42501';
  END IF;
  SELECT * INTO p FROM artifact_projects WHERE id = d.project_id AND actor_id = p_actor_id;
  SELECT * INTO r FROM artifact_rounds WHERE id = d.round_id AND project_id = p.id;
  IF p.id IS NULL OR r.id IS NULL OR p.erased_at IS NOT NULL OR p.content_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'TURN_MENTOR_DENIED' USING ERRCODE='42501';
  END IF;
  -- The turn was quoted for this module's model: any other module is refused.
  IF p.module_id::text IS DISTINCT FROM p_mentor->>'moduleId' THEN RAISE EXCEPTION 'TURN_MENTOR_DENIED' USING ERRCODE='42501'; END IF;
  SELECT x INTO spec FROM jsonb_array_elements(r.workflow->'steps') x WHERE x->>'id' = v_step;
  IF r.state <> 'draft' OR spec IS NULL OR NOT (r.steps ? v_step) THEN RAISE EXCEPTION 'TURN_MENTOR_STEP_DENIED' USING ERRCODE='42501'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(spec->'dependsOn', '[]')) dep
             WHERE (r.steps->dep->>'valid')::boolean IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'TURN_MENTOR_DEPENDENCIES_UNCONFIRMED' USING ERRCODE='42501';
  END IF;
  -- The Skill revision of the round is mentor_skill_available, read through the Skill catalog cache before any model call.
  -- The work projection the mentor sees: runtime_work_projection's per-field provenance and protection, computed here without
  -- its runtime_executions/opc_turns join (V2-12 drops those): a pending suggestion is one the field still carries.
  steps := r.steps;
  FOR step_id, st IN SELECT key, value FROM jsonb_each(r.steps) LOOP
    metas := '{}';
    FOR field_id IN SELECT f->>'id' FROM jsonb_array_elements(r.workflow->'steps') s, jsonb_array_elements(s->'information') f
                    WHERE s->>'id' = step_id LOOP
      -- The organizer sees a pending suggestion's content (to keep or withdraw it, captureFrozenInformation); the mentor sees
      -- only that one exists. Kept apart from the work projection, which goes to the mentor.
      suggestion := st#>ARRAY['fieldMeta',field_id,'suggestion'];
      IF jsonb_typeof(suggestion) = 'object' AND jsonb_typeof(suggestion->'value') = 'string' AND btrim(suggestion->>'value') <> '' THEN
        suggestions := jsonb_set(suggestions, ARRAY[step_id], coalesce(suggestions->step_id, '{}') || jsonb_build_object(field_id,
          jsonb_build_object('value', suggestion->'value', 'nature', suggestion->'nature', 'basis', suggestion->'basis')));
      END IF;
      metas := metas || jsonb_build_object(field_id, jsonb_build_object(
        'source', coalesce(st#>>ARRAY['fieldMeta',field_id,'source'], 'unknown'),
        'basis', coalesce(st#>>ARRAY['fieldMeta',field_id,'basis'], 'unknown'),
        'executionId', st#>ARRAY['fieldMeta',field_id,'executionId'],
        'origin', st#>ARRAY['fieldMeta',field_id,'origin'], 'createdAt', st#>ARRAY['fieldMeta',field_id,'createdAt'],
        'hasPendingSuggestion', jsonb_typeof(st#>ARRAY['fieldMeta',field_id,'suggestion']) = 'object',
        'protected', NOT coalesce(NOT coalesce((st->>'valid')::boolean,false)
 AND coalesce(st->'information'->(field_id)->>'status','unknown') NOT IN ('confirmed','deferred') AND (
  (st->'fieldMeta'->(field_id)->>'source'='capture' AND st->'fieldMeta'->(field_id)->>'fp'=artifact_hash(st->'information'->(field_id))
   AND EXISTS(SELECT 1 FROM artifact_requests cap WHERE cap.project_id=d.project_id AND cap.round_id=r.id
    AND cap.request_id=overlay(md5('opc_capture:'||(st->'fieldMeta'->(field_id)->>'executionId')) placing 'f' from 13 for 1)::uuid
    AND cap.action='opc_capture' AND cap.payload->>'executionId'=st->'fieldMeta'->(field_id)->>'executionId'
    AND cap.response->'versions' ? (step_id)
    AND NOT EXISTS(SELECT 1 FROM artifact_requests manual WHERE manual.project_id=d.project_id AND manual.round_id=r.id
     AND manual.action='opc_information' AND manual.payload->>'stepId'=(step_id)
     AND (manual.payload->>'expectedVersion')::integer >= (cap.response->'versions'->>(step_id))::integer
     AND artifact_hash(manual.payload->'values'->(field_id)) IS DISTINCT FROM st->'fieldMeta'->(field_id)->>'fp')))
  OR (st->'fieldMeta'->(field_id)->>'source' IS NULL AND coalesce(st->'information'->(field_id)->>'value','')='' AND coalesce(st->'information'->(field_id)->>'status','unknown')='unknown'
   AND NOT EXISTS(SELECT 1 FROM artifact_requests history WHERE history.project_id=d.project_id AND history.round_id=r.id
    AND ((history.action='opc_information' AND history.payload->>'stepId'=(step_id)
      AND coalesce(history.payload->'values'->(field_id)->>'value','')<>'')
     OR (history.action='opc_capture' AND history.response->'fields'->(step_id) ? (field_id)))))
 ),false)));
    END LOOP;
    steps := jsonb_set(steps, ARRAY[step_id], st || jsonb_build_object('fieldMeta', metas));
  END LOOP;
  RETURN jsonb_build_object('draftId', d.draft_id, 'projectId', p.id, 'roundId', r.id, 'mode', d.mode, 'moduleId', p.module_id,
    'skillId', p.skill_id, 'revisionId', r.revision_id, 'packageHash', r.package_hash, 'steps', r.workflow->'steps',
    'suggestions', suggestions,
    -- Fallback B (Owner 10-20, 10-27): at least one qualified benchmark and two confirmed search rounds; turn_close keeps the counts.
    'fallbackEligible', d.research_qualified >= 1 AND d.research_rounds >= 2,
    'work', jsonb_build_object('projectId', p.id, 'roundId', r.id, 'revisionId', r.revision_id, 'packageHash', r.package_hash,
      'steps', steps, 'source', NULL) || CASE WHEN b.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('businessContext',
      jsonb_build_object('version', 'opc-business-context.v1', 'businessId', b.id,
        'name', CASE WHEN b.name = '未命名业务' THEN NULL ELSE b.name END, 'source', NULL)) END);
END $function$;;

CREATE OR REPLACE FUNCTION public.turn_open(p_actor_id uuid, p_session_id uuid, p_request_id uuid, p_kind text, p_policy jsonb, p_resume_of bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  s runtime_sessions; t turns; prof profiles; existing turns;
  v_day date := (now() AT TIME ZONE 'UTC')::date; v_bucket smallint; total numeric; band numeric;
  u_turn numeric; g integer; h integer; available integer; hold uuid; frozen jsonb; history jsonb;
  carried integer := 0;
BEGIN
  IF p_kind NOT IN ('chat','mentor','report','compare','jury','jury_adopt','review') THEN
    RAISE EXCEPTION 'TURN_KIND_INVALID' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(p_policy) <> 'object'
    OR jsonb_typeof(p_policy->'q') <> 'number' OR (p_policy->>'q')::numeric <= 0
    OR jsonb_typeof(p_policy->'uTurnUsd') <> 'number' OR (p_policy->>'uTurnUsd')::numeric < 0
    OR jsonb_typeof(p_policy->'gCredits') <> 'number' OR (p_policy->>'gCredits')::numeric <> floor((p_policy->>'gCredits')::numeric)
    OR (p_policy->>'gCredits')::numeric < 0
    OR jsonb_typeof(p_policy->'minCredits') <> 'number' OR (p_policy->>'minCredits')::numeric < 0
    OR jsonb_typeof(p_policy->'historyItems') <> 'number' OR (p_policy->>'historyItems')::numeric NOT BETWEEN 0 AND 200
    OR jsonb_typeof(p_policy->'limits') <> 'object'
    OR coalesce((p_policy->'limits'->>'model')::numeric, 0) < 1
    OR coalesce((p_policy->'limits'->>'paidTools')::numeric, -1) < 0
    OR coalesce((p_policy->'limits'->>'freeTools')::numeric, -1) < 0
    OR coalesce((p_policy->'limits'->>'decisions')::numeric, 0) < 0
    OR jsonb_typeof(p_policy->'stopLoss') <> 'object'
    OR coalesce((p_policy->'stopLoss'->>'limitUsd')::numeric, 0) <= 0
    OR coalesce((p_policy->'stopLoss'->>'p')::numeric, 0) < 1
    OR coalesce((p_policy->'stopLoss'->>'poolSize')::numeric, 0) < 1
    OR coalesce((p_policy->'stopLoss'->>'uFastUsd')::numeric, -1) < 0
    OR coalesce((p_policy->'stopLoss'->>'uBigUsd')::numeric, -1) < 0
    OR p_policy ?| ARRAY['day','bucket','holdId','heldCredits','carriedCredits'] THEN
    RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
  END IF;

  -- 1. The account row first, then the session: one turn at a time per conversation (3a). The account comes first as in the
  -- erasure functions (they hold it before the session), so an open and a deletion of the same conversation never deadlock.
  SELECT * INTO prof FROM profiles WHERE id = p_actor_id FOR UPDATE;
  SELECT * INTO s FROM runtime_sessions WHERE id = p_session_id AND actor_id = p_actor_id FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'TURN_SESSION_DENIED' USING ERRCODE='42501'; END IF;
  -- 2. The same request again: the turn it opened, unchanged.
  SELECT * INTO existing FROM turns WHERE actor_id = p_actor_id AND request_id = p_request_id;
  IF existing.id IS NOT NULL THEN
    IF existing.session_id IS DISTINCT FROM p_session_id OR existing.kind <> p_kind
      OR existing.resume_of IS DISTINCT FROM p_resume_of THEN
      RAISE EXCEPTION 'TURN_REQUEST_CONFLICT' USING ERRCODE='22023';
    END IF;
    -- A replay reads the history too: a deleted conversation or an erasing account is refused here as for a new request,
    -- so the same old request can never read back deleted content (as runtime_session_context).
    IF s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'TURN_SESSION_ERASED' USING ERRCODE='42501'; END IF;
    IF prof.id IS NULL OR prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false'
      OR EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_actor_id) THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_ERASING' USING ERRCODE='42501';
    END IF;
    t := existing;
  ELSE
    IF s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'TURN_SESSION_ERASED' USING ERRCODE='42501'; END IF;
    IF EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_actor_id) THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_ERASING' USING ERRCODE='42501';
    END IF;
    IF p_resume_of IS NULL THEN
      IF s.active_turn_id IS NOT NULL THEN RAISE EXCEPTION 'TURN_SESSION_BUSY' USING ERRCODE='55P03'; END IF;
      -- V2-5c: the mentor's read before this turn is bound to it: a turn that closed since then makes that read stale (it could pay
      -- again for what that turn fetched, or use a grant it spent). Under this session's lock, so no close can slip in after it.
      IF p_kind = 'mentor' AND p_policy->'mentor'->>'preparedAt' IS NOT NULL AND EXISTS (SELECT 1 FROM turns x
          WHERE x.actor_id = p_actor_id AND x.session_id = p_session_id AND x.closed_at > (p_policy->'mentor'->>'preparedAt')::timestamptz) THEN
        RAISE EXCEPTION 'TURN_PREPARE_STALE' USING ERRCODE='55P03';
      END IF;
    ELSE
      -- Resume (V2-8): the paused turn is checked, locked and priced by turn_resume_carry.
      carried := public.turn_resume_carry(p_actor_id, p_session_id, s.active_turn_id, p_resume_of, p_kind, p_policy);
    END IF;
    -- The same account check as bill2_actor: active and not deleted.
    IF prof.id IS NULL OR prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_DENIED' USING ERRCODE='42501';
    END IF;

    -- 3. Stop-loss (2.5.1): reserve U_turn on the own bucket row first, then read the day's sum, then check with the band B.
    -- On a resume the paused turn's reservation is still counted here (it is released by its close below): refusing earlier,
    -- never later.
    IF (p_policy->'stopLoss'->>'p')::int < (p_policy->'stopLoss'->>'poolSize')::int THEN
      RAISE EXCEPTION 'TURN_STOP_LOSS_CONFIG' USING ERRCODE='22023';
    END IF;
    u_turn := (p_policy->>'uTurnUsd')::numeric;
    v_bucket := CASE WHEN p_kind IN ('report','compare','jury','jury_adopt') THEN -1 ELSE abs(hashtext(p_actor_id::text)) % 16 END;
    INSERT INTO daily_spend AS d (day, bucket, reserved_usd) VALUES (v_day, v_bucket, u_turn)
      ON CONFLICT (day, bucket) DO UPDATE SET reserved_usd = d.reserved_usd + excluded.reserved_usd;
    SELECT sum(reserved_usd + spent_usd) INTO total FROM daily_spend WHERE daily_spend.day = v_day;
    band := ((p_policy->'stopLoss'->>'p')::numeric - 1) * (p_policy->'stopLoss'->>'uFastUsd')::numeric
      + (p_policy->'stopLoss'->>'uBigUsd')::numeric;
    IF total + band > (p_policy->'stopLoss'->>'limitUsd')::numeric THEN
      RAISE EXCEPTION 'STOP_LOSS_REACHED' USING ERRCODE='P0001';
    END IF;

    -- The paused turn closes before the new freeze is sized: its whole freeze comes back (refund_all; what it would have charged
    -- is carried above) and counts in the balance read below. Its receipts stay its own for the stop-loss. Not delivered, no
    -- messages: the turn that continues it saves the conversation.
    IF p_resume_of IS NOT NULL THEN
      PERFORM public.turn_close(p_actor_id, p_resume_of, 'failed', '[]'::jsonb, false, true, 'resumed');
      -- What it carries is not borne by the platform: only what the chain finally does not charge is recorded as absorbed.
      UPDATE turns SET absorbed_credits = greatest(absorbed_credits - carried, 0)
        WHERE actor_id = p_actor_id AND id = p_resume_of AND absorbed_credits IS NOT NULL;
    END IF;

    -- 4. Credits: H = min(G_turn, available); below the start threshold the turn does not open. The balance is read under the
    -- account lock taken first: two sessions of one account in different stop-loss buckets never size H on the same balance.
    -- The account is checked again here (same lock) before anything is frozen.
    SELECT * INTO prof FROM profiles WHERE id = p_actor_id;
    IF prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false'
      OR EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_actor_id) THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_ERASING' USING ERRCODE='42501';
    END IF;
    -- The freeze covers the carried credits too (the continuation settles them).
    IF p_kind = 'report' THEN PERFORM public.turn_report_admit(p_actor_id, p_session_id, p_policy); END IF;
    g := (p_policy->>'gCredits')::int + carried;
    available := greatest(public.credit_available(p_actor_id), 0);
    -- The balance, not the freeze, is held against the start threshold L (as bill2_payg_claim): a balance that covers one
    -- normal turn starts it, and the freeze H may be below L when one call's bound G is (Owner 10-28, restating 10-01).
    -- On a resume the carried credits are owed already: the balance left after them must still cover one normal turn.
    IF available - carried < (p_policy->>'minCredits')::int THEN RAISE EXCEPTION 'TURN_INSUFFICIENT_CREDITS' USING ERRCODE='P0001'; END IF;
    h := least(g, available);
    IF h > 0 THEN
      SELECT pre_deduct_id INTO hold FROM public.atomic_pre_deduct(p_actor_id, h, 'AI turn freeze', p_request_id);
    END IF;

    frozen := p_policy || jsonb_build_object('day', v_day, 'bucket', v_bucket, 'holdId', hold, 'heldCredits', h)
      || CASE WHEN carried > 0 THEN jsonb_build_object('carriedCredits', carried) ELSE '{}'::jsonb END;
    INSERT INTO turns (actor_id, session_id, request_id, kind, state, resume_of, policy, reserved_credits, reserved_usd, input_bytes)
      -- reserved_credits is the freeze this turn's calls may use (turn_call_begin pauses on it); the carried part is added back
      -- at the close (turn_close), and the hold itself is the whole H (policy.heldCredits).
      VALUES (p_actor_id, p_session_id, p_request_id, p_kind, 'running', p_resume_of, frozen, h - carried, u_turn,
        (p_policy->>'inputBytes')::int)
      RETURNING * INTO t;
    UPDATE runtime_sessions SET active_turn_id = t.id WHERE id = s.id;
  END IF;

  -- 5. The visible history, newest N in order.
  SELECT coalesce(jsonb_agg(jsonb_build_object('seq', m.seq, 'role', m.role, 'content', m.content, 'contentHash', m.content_hash)
    ORDER BY m.seq), '[]'::jsonb) INTO history
  FROM (SELECT seq, role, content, content_hash FROM session_messages
        WHERE session_id = p_session_id AND visible AND deleted_at IS NULL
        ORDER BY seq DESC LIMIT (t.policy->>'historyItems')::int) m;
  -- 6. What the turn's prompt needs from the account, read here instead of in more round trips: the reply language and, for a
  -- free chat, the positioning gate (confirmed positioning; refusals in 24 hours, counted on the turns refused for it).
  RETURN jsonb_build_object('turnId', t.id, 'state', t.state, 'replay', existing.id IS NOT NULL,
    'reservedCredits', t.reserved_credits, 'reservedUsd', t.reserved_usd, 'history', history, 'resumeOf', t.resume_of,
    'replyLanguage', prof.reply_language,
    'positioning', CASE WHEN p_kind = 'chat' THEN jsonb_build_object(
      'positioned', public.turn_positioned(p_actor_id),
      'refusals24h', (SELECT count(*) FROM turns r WHERE r.actor_id = p_actor_id AND r.failure_code = 'positioning_required'
        AND r.closed_at > now() - interval '24 hours')) END,
    -- Per-kind context for the prompt (2.7). Each kind reads its input from p_policy->'<kind>' and adds its own branch here
    -- (CASE p_kind WHEN '<kind>' THEN public.turn_<kind>_context(...) END); no kind has one yet.
    'kindContext', CASE p_kind WHEN 'mentor' THEN public.turn_mentor_context(p_actor_id, p_session_id, p_policy->'mentor') END);
END $function$;;

CREATE OR REPLACE FUNCTION public.research_turn_apply(p_actor_id uuid, t turns, p jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE a uuid := p_actor_id; s uuid := t.session_id; item jsonb; f research_account_fetches; n bigint := t.id; key text;
BEGIN
  -- Replayed by a repeated close: every write below is keyed by the ids Node chose during the turn.
  -- The discovery first: a candidate card names it, and a short card needs its completed state.
  FOR item IN SELECT * FROM jsonb_array_elements(coalesce(p->'discoveries', '[]')) LOOP
    INSERT INTO research_discoveries(id, actor_id, session_id, turn_actor_id, turn_id, keyword_confirmation_id, platforms, keywords, cursor, state)
    SELECT (item->>'id')::uuid, a, s, a, n, c.confirmation_id, ARRAY(SELECT jsonb_array_elements_text(item->'platforms')), c.confirmed_items,
      item->'cursor', item->>'state'
    FROM research_selection_cards c WHERE c.confirmation_id = (item->>'keywordConfirmationId')::uuid AND c.actor_id = a AND c.session_id = s AND c.kind = 'keywords'
    ON CONFLICT (id) DO UPDATE SET cursor = excluded.cursor, state = excluded.state, updated_at = clock_timestamp()
      WHERE research_discoveries.actor_id = a AND research_discoveries.session_id = s;
    IF NOT FOUND AND NOT EXISTS (SELECT 1 FROM research_discoveries WHERE id = (item->>'id')::uuid AND actor_id = a AND session_id = s) THEN
      RAISE EXCEPTION 'RESEARCH_NOT_CONFIRMED';
    END IF;
  END LOOP;
  FOR item IN SELECT * FROM jsonb_array_elements(coalesce(p->'cards', '[]')) LOOP
    PERFORM research_card_create(a, (item->>'id')::uuid, s, NULL, item->'payload');
    UPDATE research_selection_cards SET turn_actor_id = a, turn_id = n WHERE id = (item->>'id')::uuid AND actor_id = a AND execution_id IS NULL;
  END LOOP;
  FOR item IN SELECT * FROM jsonb_array_elements(coalesce(p->'operations', '[]')) LOOP
    INSERT INTO research_plans(id, actor_id, budget_units, max_operations, operations, reserved_units, session_id, discovery_id, turn_actor_id, turn_id)
    VALUES ((item->>'id')::uuid, a, greatest(1, (item->>'quoteUnits')::bigint), 1, jsonb_build_array(jsonb_build_object('operationId', item->>'id',
      'identityHash', item->>'identityHash', 'maxQuoteUnits', (item->>'quoteUnits')::bigint)), (item->>'quoteUnits')::bigint, s,
      (item->>'discoveryId')::uuid, a, n) ON CONFLICT (id) DO NOTHING;
    INSERT INTO research_operations(id, plan_id, identity_hash, quote_units, dispatch_token, state, result)
    VALUES ((item->>'id')::uuid, (item->>'id')::uuid, item->>'identityHash', (item->>'quoteUnits')::bigint, gen_random_uuid(), item->>'state', item->'result')
    ON CONFLICT (id) DO NOTHING;
  END LOOP;
  -- After the operations: a fetch's evidence cites them (research_benchmark_project).
  FOR item IN SELECT * FROM jsonb_array_elements(coalesce(p->'fetches', '[]')) LOOP
    f := NULL;
    key := encode(sha256(convert_to(s::text || ':' || research_account_key(item->>'platform', item->>'account'), 'utf8')), 'hex');
    INSERT INTO research_account_fetches(id, actor_id, session_id, turn_actor_id, turn_id, platform, account, account_key, state, attempt)
    VALUES ((item->>'id')::uuid, a, s, a, n, item->>'platform', item->>'account', key, 'in_progress', (item->>'attempt')::uuid)
    ON CONFLICT (session_id, platform, account_key) DO UPDATE SET state = 'in_progress', attempt = excluded.attempt, execution_id = NULL,
      turn_actor_id = a, turn_id = n, evidence = NULL, updated_at = clock_timestamp()
      WHERE research_account_fetches.actor_id = a AND research_account_fetches.attempt <> excluded.attempt
    RETURNING * INTO f;
    IF f.id IS NULL THEN CONTINUE; END IF; -- This attempt was applied by an earlier close.
    IF item ? 'refreshId' THEN
      UPDATE research_refresh_grants SET used_at = coalesce(used_at, clock_timestamp()), used_turn_id = n
       WHERE id = (item->>'refreshId')::uuid AND actor_id = a AND session_id = s;
    END IF;
    PERFORM research_account_fetch_finish(a, f.id, f.attempt, item->>'state', nullif(item->'evidence', 'null'::jsonb));
    -- Only a check that succeeded counts as a round (Owner 10-27).
    IF (item->'pasted') = 'true'::jsonb AND item->>'state' = 'succeeded' THEN
      UPDATE research_account_fetches SET pasted_turns = array_append(pasted_turns, n) WHERE id = f.id AND NOT (n = ANY(pasted_turns));
    END IF;
  END LOOP;
  FOR item IN SELECT * FROM jsonb_array_elements(coalesce(p->'shortfalls', '[]')) LOOP
    BEGIN
      PERFORM research_benchmark_shortfall_offer(a, s, NULL, (item->>'id')::uuid);
      UPDATE research_benchmark_shortfalls SET turn_actor_id = a, turn_id = n WHERE id = (item->>'id')::uuid AND actor_id = a AND execution_id IS NULL;
    EXCEPTION WHEN raise_exception THEN NULL; -- Not due once the real counts are in: no card.
    END;
  END LOOP;
  UPDATE opc_drafts SET research_rounds = research_benchmark_rounds(a, s), research_qualified = research_benchmark_qualified(a, s)
   WHERE actor_id = a AND session_id = s;
END $function$;

-- The one read before a non-opening mentor turn: the source check (mentor_source_check) and, when the flow may run, what it continues
-- from. No write, no lock beyond a read.
CREATE OR REPLACE FUNCTION public.mentor_turn_prepare(p_actor_id uuid, p_session_id uuid, p_research boolean, p_refresh uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE a uuid := p_actor_id; s uuid := p_session_id; d opc_drafts; source jsonb;
BEGIN
  SELECT * INTO d FROM opc_drafts WHERE actor_id = a AND session_id = s;
  IF d.draft_id IS NULL THEN RETURN jsonb_build_object('source', jsonb_build_object('allowed', false)); END IF;
  -- Only a draft with a source pays for the whole chain, as turn_open requires.
  IF EXISTS (SELECT 1 FROM opc_account_strategy_drafts WHERE draft_id = d.draft_id)
    OR EXISTS (SELECT 1 FROM opc_draft_businesses db JOIN opc_businesses b ON b.id = db.business_id
      WHERE db.draft_id = d.draft_id AND b.current_source_version_id IS NOT NULL) THEN
    source := mentor_source_check(a, s);
  END IF;
  IF NOT p_research OR source->'allowed' = 'false'::jsonb THEN RETURN jsonb_build_object('source', source); END IF;
  RETURN jsonb_build_object('source', source, 'cards', research_user_cards(a, s),
    -- The user's Refresh of one account: null when it is not theirs, is used, or its answer was deleted.
    'refresh', CASE WHEN p_refresh IS NULL THEN NULL ELSE research_runtime_read(a, s, NULL, 'refresh', p_refresh) END,
    'cardDiscoveries', (SELECT coalesce(jsonb_object_agg(c.id, c.discovery_id), '{}'::jsonb) FROM research_selection_cards c
      WHERE c.actor_id = a AND c.session_id = s AND c.discovery_id IS NOT NULL), 'benchmarks', research_benchmark_rows(a, s),
    'shortfall', research_user_shortfall(a, s),
    'fetches', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'attempt', f.attempt, 'platform', f.platform, 'account', f.account,
        'state', f.state, 'evidence', f.last_success)), '[]'::jsonb) FROM research_account_fetches f WHERE f.actor_id = a AND f.session_id = s AND f.account IS NOT NULL),
    -- What a deleted answer left of a charged or unknown fetch: no account, only its digest, so the same account is not paid for again.
    'fetchGuards', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'platform', f.platform, 'accountKey', f.account_key, 'state', f.state)), '[]'::jsonb)
      FROM research_account_fetches f WHERE f.actor_id = a AND f.session_id = s AND f.account IS NULL),
    -- Every round of the session: a follow-up card reads a finished round's candidates, and a finished round is never run again.
    'discoveries', (SELECT coalesce(jsonb_agg(jsonb_build_object('discoveryId', x.id, 'keywords', x.keywords, 'platforms', to_jsonb(x.platforms),
        'cursor', x.cursor, 'state', x.state, 'keywordConfirmationId', x.keyword_confirmation_id)), '[]'::jsonb)
      FROM research_discoveries x WHERE x.actor_id = a AND x.session_id = s),
    -- turn_open refuses this read if a turn of the session closed after it: what is below would be stale, and could pay twice.
    'preparedAt', (SELECT coalesce(max(t.closed_at), 'epoch'::timestamptz) FROM turns t WHERE t.actor_id = a AND t.session_id = s),
    'operations', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'identityHash', o.identity_hash, 'state', o.state, 'result', o.result)), '[]'::jsonb)
      FROM research_operations o JOIN research_plans p ON p.id = o.plan_id
      WHERE p.actor_id = a AND p.session_id = s AND o.erased_at IS NULL AND p.erased_at IS NULL
        AND p.discovery_id IN (SELECT x.id FROM research_discoveries x WHERE x.actor_id = a AND x.session_id = s AND x.state = 'running')),
    -- Receipts of a turn that ended before it could apply them (a crash): their lookups are paid, so they are reused, not resent.
    'unapplied', (SELECT coalesce(jsonb_agg(r.body::jsonb), '[]'::jsonb) FROM turns t JOIN turn_calls c ON c.turn_id = t.id AND c.call_kind = 'tool'
      JOIN turn_call_raw r ON r.turn_id = c.turn_id AND r.seq = c.seq
      WHERE t.actor_id = a AND t.session_id = s AND t.kind = 'mentor' AND t.opened_at > clock_timestamp() - interval '1 day'
        AND NOT EXISTS (SELECT 1 FROM research_plans p WHERE p.actor_id = a AND p.turn_id = t.id)));
END $function$;

CREATE OR REPLACE FUNCTION public.turn_close(p_actor_id uuid, p_turn_id bigint, p_close_kind text, p_messages jsonb DEFAULT '[]'::jsonb, p_delivered boolean DEFAULT false, p_refund_all boolean DEFAULT false, p_failure_code text DEFAULT NULL::text, p_kind_result jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  t turns; s runtime_sessions; q numeric; n_total numeric; pending_upper numeric; credits integer; charge integer; h integer;
  v_kind text := p_close_kind; tomb jsonb; next_seq integer; msg jsonb; pending boolean; user_pending boolean;
  marker timestamptz; kind_result jsonb;
BEGIN
  IF p_close_kind NOT IN ('completed','stopped','failed','interrupted','expired','erased') THEN
    RAISE EXCEPTION 'TURN_CLOSE_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id;
  IF t.id IS NULL THEN RAISE EXCEPTION 'TURN_DENIED' USING ERRCODE='42501'; END IF;
  -- Lock order: the profile, the session, the turn, then the stop-loss bucket (as turn_open and the erasure functions). The
  -- profile also serializes the actor's closes (the free-stop count) before the settlement locks it again.
  PERFORM 1 FROM profiles WHERE id = p_actor_id FOR UPDATE;
  IF t.session_id IS NOT NULL THEN SELECT * INTO s FROM runtime_sessions WHERE id = t.session_id FOR UPDATE; END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id FOR UPDATE;
  IF t.state = 'closed' THEN
    -- Closed with a provider cost still unknown: calling turn_close again settles what has become known since (recovery, a late
    -- receipt). The close itself (kind, messages) is kept; each receipt is counted once, by settled_at after the last pass
    -- (both stamped with clock_timestamp under this turn's row lock, so a receipt and a pass never miss each other).
    IF t.settlement = 'pending' THEN
      marker := clock_timestamp();
      SELECT coalesce(sum(turn_call_spent_usd(call_kind, nominal_usd, actual_usd)) FILTER (WHERE status = 'ok'), 0) + coalesce(sum(actual_usd) FILTER (WHERE status = 'unusable'), 0),
             coalesce(sum(upper_usd), 0)
        INTO n_total, pending_upper
      FROM turn_calls WHERE turn_id = p_turn_id AND NOT cost_pending AND settled_at > t.updated_at;
      UPDATE daily_spend SET spent_usd = spent_usd + n_total, reserved_usd = greatest(reserved_usd - pending_upper, 0)
        WHERE day = (t.policy->>'day')::date AND bucket = (t.policy->>'bucket')::smallint;
      q := (t.policy->>'q')::numeric;
      -- The user's base is what it was at the close plus the late model receipts: a tool whose result was unknown at the close
      -- stays 0 to the user (2.5.2) however late its receipt comes; only its cost goes to the stop-loss above.
      SELECT ceil(q * coalesce(sum(nominal_usd * multiplier) FILTER (WHERE status = 'ok' AND call_kind <> 'decision'
               AND NOT (call_kind = 'tool' AND settled_at > t.closed_at)), 0))::integer,
             coalesce(bool_or(cost_pending), false), coalesce(bool_or(cost_pending AND call_kind = 'model'), false)
        INTO credits, pending, user_pending
      FROM turn_calls WHERE turn_id = p_turn_id;
      credits := credits + coalesce((t.policy->>'carriedCredits')::int, 0);
      IF t.charged_credits IS NULL AND NOT user_pending THEN
        charge := CASE WHEN t.kind = 'report' THEN (public.turn_report_settlement(t, t.close_kind, t.delivered, credits,
            t.reserved_credits + coalesce((t.policy->>'carriedCredits')::int, 0), t.closed_at)).charge
          ELSE public.turn_user_charge(p_actor_id, p_turn_id, t.close_kind, t.delivered,
          coalesce((t.policy->>'closeRefundAll')::boolean, false), credits,
          t.reserved_credits + coalesce((t.policy->>'carriedCredits')::int, 0), (t.policy->>'fixedCredits')::int, t.closed_at) END;
        IF t.policy->>'holdId' IS NOT NULL THEN
          PERFORM public.turn_settle_credits(p_actor_id, (t.policy->>'holdId')::uuid, charge, p_turn_id);
        END IF;
        t.charged_credits := charge; t.absorbed_credits := greatest(credits - charge, 0);
      END IF;
      UPDATE turns SET charged_credits = t.charged_credits, absorbed_credits = t.absorbed_credits,
          settlement = CASE WHEN pending THEN 'pending' ELSE 'done' END, updated_at = marker
        WHERE actor_id = p_actor_id AND id = p_turn_id RETURNING * INTO t;
    END IF;
    RETURN jsonb_build_object('turnId', t.id, 'closeKind', t.close_kind, 'chargedCredits', t.charged_credits,
      'absorbedCredits', t.absorbed_credits, 'settlement', t.settlement, 'replay', true);
  END IF;
  -- Only a report can be stopped by its user (Owner 10-28).
  IF v_kind = 'stopped' AND t.kind <> 'report' THEN RAISE EXCEPTION 'TURN_STOP_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
  IF p_refund_all AND v_kind NOT IN ('failed','expired','erased') THEN RAISE EXCEPTION 'TURN_CLOSE_INVALID' USING ERRCODE='22023'; END IF;
  -- A tombstone wins: nothing is saved and the turn closes as erased.
  IF t.kind = 'report' THEN v_kind := public.turn_report_close_kind(t, v_kind); END IF;
  tomb := turn_tombstones(p_actor_id, t.session_id, t.policy);
  IF v_kind IN ('completed','stopped') AND ((tomb->>'sessionTombstoned')::boolean OR (tomb->>'accountErasing')::boolean
    OR (tomb->>'voiceSourceRevoked')::boolean) THEN v_kind := 'erased'; END IF;
  -- The per-kind hook: what a kind keeps from its result (a draft, a report, a verdict) is written in the same transaction as the
  -- close, by that kind's own function (e.g. turn_mentor_apply(t, v_kind, p_kind_result)), one branch per kind:
  --   IF t.kind = '<kind>' THEN PERFORM public.turn_<kind>_apply(...); ELSE ... END IF;
  -- A kind without a branch has its result refused rather than dropped.
  IF p_kind_result IS NOT NULL THEN
    IF t.kind = 'mentor' THEN
      -- V2-5c: what this turn's research made, on any close that saves anything (paid lookups stay paid when the reply failed).
      IF v_kind <> 'erased' AND p_kind_result ? 'research' THEN PERFORM public.research_turn_apply(p_actor_id, t, p_kind_result->'research'); END IF;
      -- V2-5: the organizer's checklist patches; only a delivered completed turn applies them (an erased one saves nothing).
      IF v_kind = 'completed' AND p_delivered AND p_kind_result ? 'organizerInput' THEN kind_result := public.turn_mentor_apply(p_actor_id, p_turn_id, p_kind_result); END IF;
    ELSIF t.kind = 'report' THEN
      PERFORM public.turn_report_apply(t, v_kind, p_kind_result);
    ELSE
      RAISE EXCEPTION 'TURN_KIND_RESULT_UNSUPPORTED' USING ERRCODE='22023';
    END IF;
  END IF;

  -- Calls without a final receipt: their cost is unknown; it is never presumed zero and never retried (2.5.2).
  UPDATE turn_calls SET status = 'unknown', cost_pending = true
   WHERE turn_id = p_turn_id AND status IN ('dispatched','identified');
  q := (t.policy->>'q')::numeric;
  -- N = ceil(q x sum(n_i x m_i)) over the known receipts the user pays for (never the positioning check); n_total is the provider
  -- cost of every receipt, the positioning check and the platform-paid unusable results included, which the stop-loss counts; a
  -- tool receipt counts its whole known supplier cost (turn_call_spent_usd), the subcalls the user does not pay for included.
  SELECT ceil(q * coalesce(sum(nominal_usd * multiplier) FILTER (WHERE status = 'ok' AND call_kind <> 'decision'), 0))::integer,
         coalesce(sum(turn_call_spent_usd(call_kind, nominal_usd, actual_usd)) FILTER (WHERE status = 'ok'), 0) + coalesce(sum(actual_usd) FILTER (WHERE status = 'unusable'), 0),
         coalesce(sum(upper_usd) FILTER (WHERE cost_pending), 0),
         coalesce(bool_or(cost_pending), false),
         -- Only an unknown model call holds the user's settlement: a third-party tool whose result is unknown is 0 to the user
         -- (Owner 10-13, plan 2.5.2) and the positioning check is never theirs; both keep only the provider cost pending.
         coalesce(bool_or(cost_pending AND call_kind = 'model'), false)
    INTO credits, n_total, pending_upper, pending, user_pending
  FROM turn_calls WHERE turn_id = p_turn_id;
  -- Credits a resumed turn carried from the turn it continues (V2-8): settled here, once, under this turn's rule.
  credits := credits + coalesce((t.policy->>'carriedCredits')::int, 0);
  -- H: the whole hold, the carried credits included (reserved_credits leaves them out for the calls' own checks).
  h := t.reserved_credits + coalesce((t.policy->>'carriedCredits')::int, 0);

  -- Stop-loss: what is known is spent; the reservation of calls with an unknown cost stays until recovery settles them.
  UPDATE daily_spend SET spent_usd = spent_usd + n_total,
      reserved_usd = greatest(reserved_usd - (t.reserved_usd - pending_upper), 0)
    WHERE day = (t.policy->>'day')::date AND bucket = (t.policy->>'bucket')::smallint;

  -- What the user pays (turn_user_charge: D = min(N, H), the stop and fixed-price rules).
  -- One instant for this close, taken under the account lock: the stop count, closed_at and the settlement pass all use it, so a
  -- concurrent close of the same actor that committed first is always before it, and a later settlement counts the same.
  marker := clock_timestamp();
  IF t.kind = 'report' THEN
    SELECT r.charge, user_pending AND NOT r.settle_now INTO charge, user_pending FROM public.turn_report_settlement(t, v_kind, p_delivered, credits, h, marker) r;
  ELSE
    charge := public.turn_user_charge(p_actor_id, p_turn_id, v_kind, p_delivered, p_refund_all, credits, h,
      (t.policy->>'fixedCredits')::int, marker);
  END IF;

  -- Credits: settled once; with an unknown model cost the whole freeze waits for recovery (one freeze is settled exactly once).
  -- settlement stays 'pending' while any provider cost is unknown, so recovery still settles the stop-loss; a repeated credit
  -- settlement of the same freeze returns the first one.
  IF NOT user_pending AND t.policy->>'holdId' IS NOT NULL THEN
    PERFORM public.turn_settle_credits(p_actor_id, (t.policy->>'holdId')::uuid, charge, p_turn_id);
  END IF;

  -- The messages of a delivered turn, appended in order.
  IF v_kind IN ('completed','stopped') AND t.session_id IS NOT NULL AND jsonb_typeof(p_messages) = 'array' THEN
    SELECT coalesce(max(seq), 0) INTO next_seq FROM session_messages WHERE session_id = t.session_id;
    FOR msg IN SELECT value FROM jsonb_array_elements(p_messages) LOOP
      next_seq := next_seq + 1;
      INSERT INTO session_messages (session_id, seq, role, turn_id, content, content_hash)
        VALUES (t.session_id, next_seq, msg->>'role', p_turn_id, msg->>'content', encode(sha256(convert_to(msg->>'content', 'UTF8')), 'hex'));
    END LOOP;
  END IF;

  -- updated_at marks this settlement pass (see the closed branch above); a full refund still owed is kept with the turn.
  UPDATE turns SET state = 'closed', pause_reason = NULL, close_kind = v_kind, closed_at = marker, updated_at = marker,
      policy = CASE WHEN user_pending AND p_refund_all THEN policy || '{"closeRefundAll": true}'::jsonb ELSE policy END,
      charged_credits = CASE WHEN user_pending THEN NULL ELSE charge END,
      absorbed_credits = CASE WHEN user_pending THEN NULL ELSE greatest(credits - charge, 0) END,
      settlement = CASE WHEN pending THEN 'pending' ELSE 'done' END,
      stopped_by_user = (v_kind = 'stopped'), delivered = p_delivered AND v_kind IN ('completed','stopped'),
      failure_code = p_failure_code
    WHERE actor_id = p_actor_id AND id = p_turn_id RETURNING * INTO t;
  IF s.id IS NOT NULL AND s.active_turn_id = p_turn_id THEN UPDATE runtime_sessions SET active_turn_id = NULL WHERE id = s.id; END IF;
  RETURN jsonb_build_object('turnId', t.id, 'closeKind', t.close_kind, 'chargedCredits', t.charged_credits,
    'absorbedCredits', t.absorbed_credits, 'settlement', t.settlement, 'replay', false, 'kindResult', kind_result) || tomb;
END $function$;;

DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.research_turn_apply(uuid,turns,jsonb) FROM PUBLIC, anon, authenticated, service_role';
  EXECUTE 'REVOKE ALL ON FUNCTION public.mentor_turn_prepare(uuid,uuid,boolean,uuid) FROM PUBLIC, anon, authenticated, service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.mentor_turn_prepare(uuid,uuid,boolean,uuid) TO service_role';
END $$;
