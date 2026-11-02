-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-12 B9: the research read functions no longer read runtime_executions. A research row was visible when it had a turn
-- (turn_id) OR an old execution that was still readable; the old execution branch is dropped, so only rows a turn made are visible
-- (staging holds test data only; the old path wrote them with execution_id and no turn_id). Rewritten whole:
--   research_session_owned, research_benchmark_qualified, research_benchmark_rounds, research_benchmark_shortfall_latest,
--   research_benchmark_shortfall_accepted, research_benchmark_table, research_chat_benchmark_accounts, research_user_benchmarks,
--   research_user_cards, research_user_evidence, research_user_unfinished_round, research_runtime_read.
-- research_session_owned keeps its signature; its third argument (an execution id) is no longer checked. research_user_evidence names a
-- session by its name, else by its first visible user message (as the conversation list does since 0444), not by an execution's input.
-- research_user_tool_charges (the credit record's "搜索明细") reads the turn's own spend row and turn_calls instead of bill2_calls: one line per
-- supplier subcall of the turn's tool rows (usage.results, which now also keeps each subcall's multiplier and what it asked for), with the
-- same unrounded credits (cost x m x q, 0 without data, none while unknown). Only the turn's first spend row ('turn:<id>:spend') lists them.
-- Not touched here: research_user_message (only the old runtime store calls it), research_runtime_link / call_charge / close_unsent /
-- plan_create, research_operation_settled (BILL2 and erasure users; they go with their callers).
-- Compatible: the turn path reads and writes the same rows by turn_id; results and signatures are unchanged.
-- Repeatable: whole-function CREATE OR REPLACE. Recovery: re-apply the previous text of the thirteen functions from git history
-- (0435 and earlier); no data is written or removed, so nothing needs restoring.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.research_session_owned(a uuid, s uuid, e uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Lock first, then check: an account closed while we waited for the lock is refused here. `e` (an old execution) is not checked.
  PERFORM id FROM profiles WHERE id=a FOR SHARE;
  PERFORM bill2_actor(a);
  PERFORM id FROM runtime_sessions WHERE id=s AND actor_id=a FOR SHARE;
  IF NOT EXISTS(SELECT 1 FROM runtime_sessions x WHERE x.id=s AND x.actor_id=a AND x.content_deleted_at IS NULL AND x.erased_at IS NULL)
  THEN RAISE EXCEPTION 'RESEARCH_SCOPE_DENIED' USING ERRCODE='42501';END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.research_benchmark_qualified(a uuid, s uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT count(*)::integer FROM research_benchmarks b
  WHERE b.actor_id=a AND b.session_id=s AND b.qualified AND b.turn_id IS NOT NULL
$function$;

CREATE OR REPLACE FUNCTION public.research_benchmark_rounds(a uuid, s uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT (
    SELECT count(*) FROM research_discoveries d
    WHERE d.actor_id=a AND d.session_id=s AND d.state='completed' AND d.turn_id IS NOT NULL
  )::integer + (
    -- A turn's pasted-link check, unless that turn also completed a discovery (one turn, one round, as above).
    SELECT count(DISTINCT p)::integer FROM research_account_fetches f CROSS JOIN LATERAL unnest(f.pasted_turns) p
    WHERE f.actor_id=a AND f.session_id=s AND NOT EXISTS (SELECT 1 FROM research_discoveries d
      WHERE d.turn_id=p AND d.actor_id=a AND d.session_id=s AND d.state='completed')
  )
$function$;

CREATE OR REPLACE FUNCTION public.research_benchmark_shortfall_latest(a uuid, s uuid)
 RETURNS research_benchmark_shortfalls
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT b.* FROM research_benchmark_shortfalls b
  WHERE b.actor_id=a AND b.session_id=s AND b.turn_id IS NOT NULL
  ORDER BY b.created_at DESC,b.id DESC LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION public.research_benchmark_shortfall_accepted(a uuid, s uuid, req integer)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT research_benchmark_qualified(a,s)>=1 AND research_benchmark_rounds(a,s)>=2
    AND EXISTS(SELECT 1 FROM research_benchmark_shortfalls b
      WHERE b.actor_id=a AND b.session_id=s AND b.choice='generate' AND b.required>=req AND b.turn_id IS NOT NULL)
$function$;

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
    WHERE b.actor_id=a AND b.session_id=s AND b.turn_id IS NOT NULL
    ORDER BY b.qualified DESC,b.followers DESC NULLS LAST,b.platform,b.account LIMIT 30) b;
  RETURN jsonb_build_object('rows',output,'hash',encode(sha256(convert_to(output::text,'utf8')),'hex'));
END $function$;

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
    WHERE rb.actor_id=a AND rb.session_id=ANY(sessions) AND rb.turn_id IS NOT NULL) t WHERE t.n<=30
   ORDER BY t.platform,t.account) b);
END $function$;

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
    LEFT JOIN research_account_fetches f ON f.id=b.fetch_id AND f.actor_id=a
    WHERE b.actor_id=a AND b.session_id=s AND b.turn_id IS NOT NULL
    ORDER BY b.qualified DESC,topic_relevance DESC NULLS LAST,b.followers DESC NULLS LAST,b.platform,b.account LIMIT 30) b;
  RETURN output;
END $function$;

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
 WHERE c.actor_id=a AND c.session_id=s AND c.turn_id IS NOT NULL;
 RETURN output;
END $function$;

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
   'sessionId',s.id,'sessionTitle',coalesce(n.name,(SELECT left(nullif(btrim(m.content),''),80)
     FROM session_messages m WHERE m.session_id=s.id AND m.role='user' AND m.visible AND m.deleted_at IS NULL
     ORDER BY m.seq LIMIT 1)),
   'createdAt',o.created_at) row
  FROM research_operations o JOIN research_plans p ON p.id=o.plan_id AND p.actor_id=a
  JOIN runtime_sessions s ON s.id=p.session_id AND s.actor_id=a
  LEFT JOIN runtime_session_names n ON n.session_id=s.id AND n.actor_id=a
  WHERE o.erased_at IS NULL AND p.erased_at IS NULL AND p.turn_id IS NOT NULL
   AND s.content_deleted_at IS NULL AND s.erased_at IS NULL AND o.state IN ('succeeded','failed','unknown')
   AND (p_cursor_time IS NULL OR (o.created_at,o.id)<(p_cursor_time,p_cursor_id))
  ORDER BY o.created_at DESC,o.id DESC LIMIT p_limit
 ) records;
 RETURN output;
END $function$;

CREATE OR REPLACE FUNCTION public.research_user_unfinished_round(a uuid, s uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d research_discoveries; marker text; t turns;
BEGIN
  PERFORM research_session_owned(a,s,NULL);
  SELECT * INTO d FROM research_discoveries WHERE actor_id=a AND session_id=s ORDER BY created_at DESC, id DESC LIMIT 1;
  IF d.id IS NULL OR d.state<>'running' THEN RETURN NULL; END IF;
  marker:=d.cursor->>'continueFrom';
  IF marker IS NULL OR marker !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
  -- A round a turn stopped: the marker is that turn's request id.
  SELECT * INTO t FROM turns WHERE actor_id=a AND session_id=s AND request_id=marker::uuid;
  IF t.id IS NULL THEN RETURN NULL; END IF;
  IF t.state<>'closed' OR t.close_kind<>'completed' OR t.closed_at < clock_timestamp() - interval '30 minutes'
   OR EXISTS(SELECT 1 FROM turns y WHERE y.actor_id=a AND y.session_id=s AND y.id>t.id) THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('discoveryId',d.id,'executionId',t.request_id,
    'replies',greatest(1,CASE WHEN jsonb_typeof(d.cursor->'executions')='array' THEN jsonb_array_length(d.cursor->'executions') ELSE 1 END));
END $function$;

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
    WHERE o.id=p_id AND p.actor_id=a AND p.session_id=s AND o.erased_at IS NULL AND p.erased_at IS NULL AND p.turn_id IS NOT NULL;
  WHEN 'plan' THEN
    SELECT jsonb_build_object('executionId',p.execution_id,'discoveryId',p.discovery_id,'operations',p.operations,
      'budgetUnits',p.budget_units,'cancelled',p.cancelled) INTO v FROM research_plans p
    WHERE p.id=p_id AND p.actor_id=a AND p.session_id=s AND p.erased_at IS NULL AND p.turn_id IS NOT NULL;
  WHEN 'discovery' THEN
    SELECT jsonb_build_object('discoveryId',d.id,'keywords',d.keywords,'platforms',d.platforms,'cursor',d.cursor,'state',d.state)
    INTO v FROM research_discoveries d
    JOIN research_selection_cards c ON c.confirmation_id=d.keyword_confirmation_id AND c.actor_id=a
    WHERE c.turn_id IS NOT NULL AND d.id=p_id AND d.actor_id=a AND d.session_id=s AND d.turn_id IS NOT NULL;
  WHEN 'refresh' THEN
    SELECT jsonb_build_object('platform',g.platform,'account',g.account,'used',g.used_at IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM research_account_fetches f WHERE f.actor_id=a AND f.session_id=s AND f.refresh_id=g.id
      AND f.state='prepared' AND f.platform=g.platform AND f.account_key=encode(sha256(convert_to(s::text||':'||research_account_key(g.platform,g.account),'utf8')),'hex')))
    INTO v FROM research_refresh_grants g
    WHERE g.id=p_id AND g.actor_id=a AND g.session_id=s AND g.source_turn_id IS NOT NULL;
  WHEN 'selected' THEN
    SELECT coalesce(jsonb_agg(item),'[]'::jsonb) INTO v FROM research_selection_cards c
    CROSS JOIN LATERAL jsonb_array_elements(c.confirmed_items) item
    WHERE c.actor_id=a AND c.session_id=s AND c.discovery_id=p_id AND c.kind='candidates' AND c.confirmation_id IS NOT NULL
    AND c.turn_id IS NOT NULL;
  WHEN 'card' THEN
    SELECT jsonb_build_object('cardId',c.id,'kind',c.kind,'options',c.options,'minSelect',c.min_select,'maxSelect',c.max_select,
      'confirmationId',c.confirmation_id,'items',c.confirmed_items)
    INTO v FROM research_selection_cards c
    WHERE c.id=p_id AND c.actor_id=a AND c.session_id=s AND c.turn_id IS NOT NULL;
  ELSE RAISE EXCEPTION 'RESEARCH_READ_INVALID';
  END CASE;
  RETURN v;
END $function$;

CREATE OR REPLACE FUNCTION public.research_user_tool_charges(a uuid, p_transaction uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE tx credit_transactions; t turns; q numeric; output jsonb;
BEGIN
 PERFORM bill2_actor(a);
 SELECT * INTO tx FROM credit_transactions WHERE id=p_transaction AND user_id=a;
 IF tx.id IS NULL THEN RAISE EXCEPTION 'RESEARCH_SCOPE_DENIED' USING ERRCODE='42501';END IF;
 IF tx.source_type IS DISTINCT FROM 'ai_task' OR coalesce(tx.metadata->>'turnId','') !~ '^[0-9]+$' THEN RETURN '[]'::jsonb;END IF;
 SELECT * INTO t FROM turns WHERE actor_id=a AND id=(tx.metadata->>'turnId')::bigint;
 -- A turn that paid in parts lists its searches under its first spend row only.
 IF t.id IS NULL OR tx.idempotency_key IS DISTINCT FROM 'turn:'||t.id||':spend' THEN RETURN '[]'::jsonb;END IF;
 IF NOT EXISTS(SELECT 1 FROM runtime_sessions s WHERE s.id=t.session_id AND s.actor_id=a
   AND s.content_deleted_at IS NULL AND s.erased_at IS NULL) THEN RETURN '[]'::jsonb;END IF;
 q:=(t.policy->>'q')::numeric;
 SELECT coalesce(jsonb_agg(x.line ORDER BY x.seq,x.n),'[]'::jsonb) INTO output FROM (
  SELECT c.seq,l.n,jsonb_build_object(
   'callId',md5(t.id::text||':'||c.seq||':'||l.n)::uuid,'toolName',c.tool_name,'args',NULL::jsonb,
   'query',l.v->'call'->>'query','platform',l.v->'call'->>'platform','dataKind',l.v->'call'->>'dataKind',
   'source',CASE
     WHEN l.v IS NULL OR l.v->>'outcome'='unknown' OR jsonb_typeof(l.v->'costUsd')<>'string' THEN 'tool_unknown'
     WHEN l.v->>'outcome' IN ('ok','partial') AND coalesce((l.v->>'items')::integer,0)>0 THEN 'tool_usage'
     WHEN (l.v->>'costUsd')::numeric>0 THEN 'tool_failed_charged'
     ELSE 'tool_failed' END,
   -- Before the turn's cumulative ceil, as the stream showed it: cost x the subcall's m x q.
   'credits',CASE
     WHEN l.v IS NULL OR l.v->>'outcome'='unknown' OR jsonb_typeof(l.v->'costUsd')<>'string' THEN NULL
     WHEN l.v->>'outcome' IN ('ok','partial') AND coalesce((l.v->>'items')::integer,0)>0
       THEN ((l.v->>'costUsd')::numeric*coalesce((l.v->>'multiplier')::numeric,c.multiplier)*q)::text
     ELSE '0' END) line
  FROM turn_calls c
  CROSS JOIN LATERAL (
   SELECT r.v,r.n FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.usage->'results')='array' THEN c.usage->'results' ELSE '[]'::jsonb END)
     WITH ORDINALITY r(v,n)
   UNION ALL
   SELECT NULL::jsonb,0::bigint WHERE NOT (jsonb_typeof(c.usage->'results')='array' AND jsonb_array_length(c.usage->'results')>0)
  ) l
  WHERE c.turn_id=t.id AND c.actor_id=a AND c.call_kind='tool' AND c.status IN ('ok','unusable','unknown')
 ) x;
 RETURN output;
END $function$;

COMMIT;
