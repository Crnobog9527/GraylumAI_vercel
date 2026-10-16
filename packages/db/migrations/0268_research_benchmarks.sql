-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- RESEARCH-TOOLS RT-4b: the host-owned benchmark table and the report gate
-- (docs/launch/implementation/RESEARCH_TOOLS_PLAN.md §1.2–§1.5, §4.3; tasks/RESEARCH-TOOLS.md must-tests 3, 5, 6, 10).
--   * research_benchmarks: one row per fetched account of a session. Its numeric columns are copied only from the
--     successful fetch cache that benchmark_fetch computes from supplier evidence (research_account_fetches.last_success),
--     by a trigger; no function takes these numbers as input, and no client role can write the table. Every number is
--     checked against the research operation items its evidence refs name (same actor, same session, not erased):
--     followers and publication times must equal the item fields, median views and engagement rate must equal the
--     median recomputed from those items. A row whose evidence does not check out is kept as unqualified
--     (EVIDENCE_UNVERIFIED) with no numbers. A qualified row must also satisfy the product thresholds (10k–200k
--     followers, an update within 30 days of the fetch), enforced by a table CHECK.
--   * The report gate lives in report_admission_check (the REPORT-GEN admission checkpoint): a positioning
--     (positioning_draft) session always needs at least 3 qualified rows produced in this session; any other Skill
--     only when its workflow declares reportGeneration.minQualifiedBenchmarks (raised to at least 3).
-- Erasure: deleting a conversation, an answer (the one that produced the row) or an artifact whose evidence a row uses,
-- and account erasure, delete the rows. Rows hold no money.
-- Function patches are text-marker patches (packages/db/tests/content-erasure/md5-chain.mjs).
-- Compatibility: a new table and functions; old code never reads them. Old code freezes reports without benchmarkHash
-- (and without benchmark rows): only the qualified-count gate applies to those. New code on an old database treats the
-- missing research_benchmark_rows as an empty table. Repeatable: IF NOT EXISTS, CREATE OR REPLACE,
-- DROP TRIGGER IF EXISTS, marker-skipped patches. Recovery: drop the trigger, functions and table, and restore
-- report_admission_check, bill2_payg_claim, research_account_fetch_finish, content_erasure_confirm and account_erasure_scrub_content
-- from their previous definitions;
-- the rows are re-derivable from research_account_fetches.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE IF NOT EXISTS public.research_benchmarks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fetch_id uuid NOT NULL UNIQUE REFERENCES public.research_account_fetches(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES public.profiles(id),
  session_id uuid NOT NULL REFERENCES public.runtime_sessions(id),
  -- The answer whose paid fetch produced the evidence (research_account_fetches.last_success_execution_id).
  execution_id uuid NOT NULL REFERENCES public.runtime_executions(id),
  platform text NOT NULL CHECK (platform ~ '^[a-z]{1,20}$'),
  account text NOT NULL CHECK (length(account) BETWEEN 1 AND 200),
  followers numeric CHECK (followers >= 0),
  median_views numeric CHECK (median_views >= 0),
  engagement_rate numeric CHECK (engagement_rate >= 0),
  posts_per_week numeric CHECK (posts_per_week >= 0),
  last_published_at timestamptz,
  earliest_published_at timestamptz,
  posts_analyzed integer NOT NULL CHECK (posts_analyzed BETWEEN 0 AND 30),
  category text CHECK (category IN ('head_reference','imitable','fast_rising')),
  qualified boolean NOT NULL,
  excluded text CHECK (excluded IN ('FOLLOWERS_MISSING','FOLLOWERS_BELOW_MIN','NO_PUBLISH_TIME','INACTIVE_30_DAYS','NO_POSTS',
    'TOO_FEW_POSTS','EVIDENCE_UNVERIFIED')),
  -- The supplier confirmed the analyzed posts are the account's whole history (metrics.wholeHistory).
  whole_history boolean NOT NULL DEFAULT false,
  -- Per number, the evidence refs (`<research operation id>#<item>`) it was computed from.
  refs jsonb NOT NULL CHECK (jsonb_typeof(refs)='object' AND octet_length(refs::text)<=8192),
  -- Every research operation the refs name: deleting any of them deletes the row.
  operation_ids uuid[] NOT NULL,
  missing text[] NOT NULL,
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((category IS NULL) = (excluded IS NOT NULL)),
  CHECK (NOT qualified OR (category IN ('imitable','fast_rising') AND followers BETWEEN 10000 AND 200000
    AND posts_analyzed > 0 AND last_published_at >= fetched_at - interval '30 days 5 minutes'
    -- Owner 2026-10-16 ("同意 RT-4b 作品条数选 A"): at least 20 analyzed posts, unless that is the whole history.
    AND (posts_analyzed >= 20 OR whole_history))),
  CHECK (category IS DISTINCT FROM 'head_reference' OR (NOT qualified AND followers > 200000)),
  CHECK (excluded IS DISTINCT FROM 'EVIDENCE_UNVERIFIED' OR (followers IS NULL AND median_views IS NULL
    AND engagement_rate IS NULL AND posts_per_week IS NULL AND last_published_at IS NULL AND earliest_published_at IS NULL))
);
CREATE INDEX IF NOT EXISTS research_benchmarks_session_idx ON public.research_benchmarks(session_id);
CREATE INDEX IF NOT EXISTS research_benchmarks_execution_idx ON public.research_benchmarks(execution_id);
CREATE INDEX IF NOT EXISTS research_benchmarks_operations_idx ON public.research_benchmarks USING gin(operation_ids);
ALTER TABLE public.research_benchmarks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.research_benchmarks FROM PUBLIC,anon,authenticated,service_role;

-- The research operation item an evidence ref names, when it belongs to this actor's session and is still live.
CREATE OR REPLACE FUNCTION public.research_benchmark_item(a uuid, s uuid, ref text) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE op uuid; n integer; v jsonb;
BEGIN
  IF ref IS NULL OR ref !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}#[1-9][0-9]{0,4}$' THEN RETURN NULL;END IF;
  op:=split_part(ref,'#',1)::uuid;n:=split_part(ref,'#',2)::integer;
  SELECT o.result->'items'->(n-1)->'fields' INTO v
  FROM research_operations o JOIN research_plans p ON p.id=o.plan_id
  WHERE o.id=op AND p.actor_id=a AND p.session_id=s AND o.state='succeeded' AND o.erased_at IS NULL AND p.erased_at IS NULL
    AND jsonb_typeof(o.result->'items')='array' AND n<=jsonb_array_length(o.result->'items');
  RETURN CASE WHEN jsonb_typeof(v)='object' THEN v END;
END $$;

-- The research operation id benchmark_fetch gives one supplier subcall of a fetch attempt: stableResearchId(fetchId,
-- attempt, kind) in research/runtime/toolContext.ts (sha256 of the JSON array, laid out as a v4-style uuid).
CREATE OR REPLACE FUNCTION public.research_benchmark_operation_id(p_fetch uuid, p_attempt uuid, p_kind text) RETURNS uuid
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT (substr(h,1,8)||'-'||substr(h,9,4)||'-4'||substr(h,14,3)||'-a'||substr(h,18,3)||'-'||substr(h,21,12))::uuid
  -- JSON.stringify spelling (no spaces); uuids and the fixed kind names need no escaping.
  FROM (SELECT encode(sha256(convert_to('["'||p_fetch::text||'","'||p_attempt::text||'","'||p_kind||'"]','utf8')),'hex') h) z
  WHERE p_kind ~ '^[a-z_]{1,40}$'
$$;

-- The row for a fetch's current success, or no row. Called by the trigger only.
CREATE OR REPLACE FUNCTION public.research_benchmark_project(f research_account_fetches) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE e jsonb:=f.last_success; m jsonb; c jsonb; refs jsonb:='{}'; ops uuid[]:='{}'; key text; ref text; item jsonb;
  ok boolean:=true; expected double precision; actual double precision;
BEGIN
  IF e IS NULL OR f.last_success_execution_id IS NULL OR f.account IS NULL THEN
    DELETE FROM research_benchmarks WHERE fetch_id=f.id;
    RETURN;
  END IF;
  -- research_account_fetch_finish already validated the shape of a successful cache.
  m:=e->'metrics';c:=e->'classification';
  FOREACH key IN ARRAY ARRAY['followers','medianViews','engagementRate','postsPerWeek','lastPublishedAt','earliestPublishedAt'] LOOP
    refs:=refs||jsonb_build_object(key,m->key->'refs');
    FOR ref IN SELECT jsonb_array_elements_text(m->key->'refs') LOOP
      item:=research_benchmark_item(f.actor_id,f.session_id,ref);
      IF item IS NULL THEN ok:=false;
      ELSE ops:=ops||(split_part(ref,'#',1))::uuid;END IF;
    END LOOP;
  END LOOP;
  -- Every cited operation is a subcall of this very fetch attempt (not another account fetched in the same session).
  ok:=ok AND ops<@ARRAY(SELECT research_benchmark_operation_id(f.id,f.attempt,k)
    FROM unnest(ARRAY['account_profile','account_posts','account_relation','post_detail']) k);
  -- A whole-history claim (the new-account exception to the 20-post minimum) needs this fetch's own profile to report
  -- no more posts than were analyzed (suppliedWholeHistory in research/benchmark/metrics.ts).
  IF ok AND (m->'wholeHistory')::boolean THEN
    item:=research_benchmark_item(f.actor_id,f.session_id,research_benchmark_operation_id(f.id,f.attempt,'account_profile')::text||'#1');
    ok:=jsonb_typeof(item->'postsCount')='number' AND (m->>'postsAnalyzed')::numeric>=(item->>'postsCount')::numeric;
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
  -- Otherwise the analyzed count is at least the distinct posts any number cites (the profile ref is not a post).
  IF ok THEN
    ok:=(m->>'postsAnalyzed')::integer>=(SELECT count(DISTINCT r) FROM jsonb_each(m) k
      CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN k.key IN ('medianViews','engagementRate','postsPerWeek',
        'lastPublishedAt','earliestPublishedAt') AND jsonb_typeof(k.value->'refs')='array' THEN k.value->'refs' ELSE '[]' END) r
      WHERE r IS DISTINCT FROM m->'followers'->'refs'->>0);
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
  INSERT INTO research_benchmarks AS b(fetch_id,actor_id,session_id,execution_id,platform,account,followers,median_views,
    engagement_rate,posts_per_week,last_published_at,earliest_published_at,posts_analyzed,whole_history,category,qualified,
    excluded,refs,operation_ids,missing,fetched_at)
  VALUES(f.id,f.actor_id,f.session_id,f.last_success_execution_id,f.platform,f.account,
    CASE WHEN ok THEN (m->'followers'->>'value')::numeric END,CASE WHEN ok THEN (m->'medianViews'->>'value')::numeric END,
    CASE WHEN ok THEN (m->'engagementRate'->>'value')::numeric END,CASE WHEN ok THEN (m->'postsPerWeek'->>'value')::numeric END,
    CASE WHEN ok THEN (m->'lastPublishedAt'->>'value')::timestamptz END,
    CASE WHEN ok THEN (m->'earliestPublishedAt'->>'value')::timestamptz END,
    CASE WHEN ok THEN (m->>'postsAnalyzed')::integer ELSE 0 END,
    ok AND (m->'wholeHistory')::boolean,
    CASE WHEN ok THEN c->>'category' END,ok AND (c->'qualified')::boolean,
    CASE WHEN ok THEN c->>'excluded' ELSE 'EVIDENCE_UNVERIFIED' END,
    refs,ARRAY(SELECT DISTINCT x FROM unnest(ops) x ORDER BY x),
    ARRAY(SELECT jsonb_array_elements_text(m->'missing')),(e->>'fetchedAt')::timestamptz)
  ON CONFLICT (fetch_id) DO UPDATE SET execution_id=excluded.execution_id,account=excluded.account,
    followers=excluded.followers,median_views=excluded.median_views,engagement_rate=excluded.engagement_rate,
    posts_per_week=excluded.posts_per_week,last_published_at=excluded.last_published_at,
    earliest_published_at=excluded.earliest_published_at,posts_analyzed=excluded.posts_analyzed,whole_history=excluded.whole_history,
    category=excluded.category,
    qualified=excluded.qualified,excluded=excluded.excluded,refs=excluded.refs,operation_ids=excluded.operation_ids,
    missing=excluded.missing,fetched_at=excluded.fetched_at,updated_at=clock_timestamp();
END $$;

CREATE OR REPLACE FUNCTION public.research_benchmark_sync() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM research_benchmark_project(NEW);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS research_benchmarks_from_fetch ON public.research_account_fetches;
CREATE TRIGGER research_benchmarks_from_fetch
  AFTER INSERT OR UPDATE OF last_success,last_success_execution_id,account ON public.research_account_fetches
  FOR EACH ROW EXECUTE FUNCTION public.research_benchmark_sync();

-- The fetch cache (0263) accepts the new exclusion of a fetched account with too few posts (Owner 2026-10-16, A).
DO $$ DECLARE definition text; t text; BEGIN
  definition:=pg_get_functiondef('public.research_account_fetch_finish(uuid,uuid,uuid,text,jsonb)'::regprocedure);
  IF position('-- 0268 too few posts' IN definition)=0 THEN
    t:=$x$IN ('FOLLOWERS_MISSING','FOLLOWERS_BELOW_MIN','NO_PUBLISH_TIME','INACTIVE_30_DAYS','NO_POSTS')),false)$x$;
    IF array_length(string_to_array(definition,t),1)<>2 THEN
      RAISE EXCEPTION 'RESEARCH_BENCHMARK_SOURCE_MISMATCH: research_account_fetch_finish';END IF;
    EXECUTE replace(definition,t,$x$IN ('FOLLOWERS_MISSING','FOLLOWERS_BELOW_MIN','NO_PUBLISH_TIME','INACTIVE_30_DAYS','NO_POSTS',
       -- 0268 too few posts
       'TOO_FEW_POSTS')),false)$x$);
  END IF;
END $$;

-- Qualified accounts produced in this session by its own live answers (one per platform + account).
CREATE OR REPLACE FUNCTION public.research_benchmark_qualified(a uuid, s uuid) RETURNS integer
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT count(*)::integer FROM research_benchmarks b
  JOIN runtime_executions x ON x.id=b.execution_id AND x.actor_id=a AND x.session_id=s
  WHERE b.actor_id=a AND b.session_id=s AND b.qualified AND x.content_deleted_at IS NULL AND x.erased_at IS NULL
$$;

-- How many qualified benchmark accounts a report needs (0: no gate). Positioning reports always need the product
-- minimum of 3; another Skill only when it declares reportGeneration.minQualifiedBenchmarks, never below 3.
CREATE OR REPLACE FUNCTION public.research_benchmark_required(scope jsonb, spec jsonb) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT CASE
    WHEN jsonb_typeof(spec->'minQualifiedBenchmarks')='number' THEN greatest(3,least(12,(spec->>'minQualifiedBenchmarks')::numeric))::integer
    WHEN spec ? 'minQualifiedBenchmarks' OR scope->>'kind'='positioning_draft' THEN 3
    ELSE 0 END
$$;

-- The host-computed table for report facts: this session's live rows, no supplier cost or raw evidence, and the hash
-- report admission re-checks (the rows a report is admitted with are exactly the rows still present).
-- research_benchmark_table takes no locks (report admission already holds the session); research_benchmark_rows is the
-- service entry with the usual ownership check.
CREATE OR REPLACE FUNCTION public.research_benchmark_table(a uuid, s uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE output jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object('platform',b.platform,'account',b.account,'followers',b.followers,
    'medianViews',b.median_views,'engagementRate',b.engagement_rate,'postsPerWeek',b.posts_per_week,
    'lastPublishedAt',b.last_published_at,'postsAnalyzed',b.posts_analyzed,'category',b.category,'qualified',b.qualified,
    'excluded',b.excluded,'missing',to_jsonb(b.missing),'fetchedAt',b.fetched_at)
    ORDER BY b.qualified DESC,b.followers DESC NULLS LAST,b.platform,b.account),'[]'::jsonb) INTO output
  FROM (SELECT b.* FROM research_benchmarks b
    JOIN runtime_executions x ON x.id=b.execution_id AND x.actor_id=a AND x.session_id=s
    WHERE b.actor_id=a AND b.session_id=s AND x.content_deleted_at IS NULL AND x.erased_at IS NULL
    ORDER BY b.qualified DESC,b.followers DESC NULLS LAST,b.platform,b.account LIMIT 30) b;
  RETURN jsonb_build_object('rows',output,'hash',encode(sha256(convert_to(output::text,'utf8')),'hex'));
END $$;
CREATE OR REPLACE FUNCTION public.research_benchmark_rows(a uuid, s uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM research_session_owned(a,s,NULL);
  RETURN research_benchmark_table(a,s);
END $$;

-- The benchmark rows frozen into a report's instructions must still be the current ones (deleted or refreshed since:
-- conflict). Run at report admission and at every report model-call claim (a report may wait for credits or resume).
-- Callers hold the session (runtime_admit) or the run (bill2_payg_claim); share-locking this session's fetch and
-- benchmark rows first makes a finish, refresh or deletion either commit before the hash is read or wait for the caller.
-- Order as deletion: session, then fetch and benchmark rows. A report frozen without a hash (code before 0268) carries
-- no benchmark rows, so there is nothing to compare; the qualified-count gate applies to it all the same.
CREATE OR REPLACE FUNCTION public.research_benchmark_report_current(a uuid, s uuid, frozen jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF frozen IS NULL OR NOT frozen ? 'benchmarkHash' THEN RETURN;END IF;
  PERFORM 1 FROM research_account_fetches WHERE session_id=s FOR SHARE;
  PERFORM 1 FROM research_benchmarks WHERE session_id=s FOR SHARE;
  IF (research_benchmark_table(a,s)->>'hash') IS DISTINCT FROM frozen->>'benchmarkHash' THEN
    RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT';END IF;
END $$;

-- Report gate, after every existing report refusal so those keep their codes.
DO $$ DECLARE definition text; t text; BEGIN
  definition:=pg_get_functiondef('public.report_admission_check(uuid,uuid,jsonb,jsonb)'::regprocedure);
  IF position('-- 0268 benchmark gate' IN definition)=0 THEN
    t:=$x$  RAISE EXCEPTION 'OPC_CAPTURE_PENDING';END IF;$x$;
    IF array_length(string_to_array(definition,t),1)<>2 THEN
      RAISE EXCEPTION 'RESEARCH_BENCHMARK_SOURCE_MISMATCH: report_admission_check';END IF;
    EXECUTE replace(definition,t,t||$x$
 -- 0268 benchmark gate: qualified benchmark accounts of this session (RESEARCH_TOOLS_PLAN §1.5).
 IF research_benchmark_qualified(a,sid)<research_benchmark_required((SELECT scope FROM runtime_sessions WHERE id=sid),spec) THEN
  RAISE EXCEPTION 'REPORT_BENCHMARKS_REQUIRED';END IF;
 PERFORM research_benchmark_report_current(a,sid,context->'reportGeneration');$x$);
  END IF;
END $$;

-- Report model-call claims re-check the frozen rows, next to the existing snapshotHash re-check.
DO $$ DECLARE definition text; t text; BEGIN
  definition:=pg_get_functiondef('public.bill2_payg_claim(uuid,uuid,integer,jsonb)'::regprocedure);
  IF position('-- 0268 benchmark claim' IN definition)=0 THEN
    t:=$x$IS DISTINCT FROM r.payload#>>'{input,reportGeneration,snapshotHash}' THEN RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT';END IF;$x$;
    IF array_length(string_to_array(definition,t),1)<>2 THEN
      RAISE EXCEPTION 'RESEARCH_BENCHMARK_SOURCE_MISMATCH: bill2_payg_claim';END IF;
    EXECUTE replace(definition,t,t||$x$
  -- 0268 benchmark claim
  PERFORM research_benchmark_report_current(a,r.session_ref,r.payload#>'{input,reportGeneration}');$x$);
  END IF;
END $$;

-- Content erasure: rows of a deleted conversation or answer, or built on erased research evidence.
DO $$ DECLARE definition text; d text; BEGIN
  definition:=pg_get_functiondef('public.content_erasure_confirm(uuid,text,uuid,text)'::regprocedure);
  IF position('-- 0268 benchmarks' IN definition)=0 THEN
    d:=$x$ -- Same terminal-result cost projection as account erasure; original amounts and charge IDs stay intact.$x$;
    IF array_length(string_to_array(definition,d),1)<>2 THEN
      RAISE EXCEPTION 'RESEARCH_BENCHMARK_SOURCE_MISMATCH: content_erasure_confirm';END IF;
    EXECUTE replace(definition,d,$x$ -- 0268 benchmarks: derived numbers go with their answer, conversation or evidence.
 DELETE FROM research_benchmarks WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids)
   OR operation_ids && research_ids);
$x$||d);
  END IF;
END $$;

DO $$ DECLARE definition text; r text; BEGIN
  definition:=pg_get_functiondef('public.account_erasure_scrub_content(uuid)'::regprocedure);
  IF position('-- 0268 benchmarks' IN definition)=0 THEN
    -- Before 0263's fetch deletion (which would cascade), so the count is the rows actually removed.
    r:=$x$  -- 0263 runtime research$x$;
    IF array_length(string_to_array(definition,r),1)<>2 THEN
      RAISE EXCEPTION 'RESEARCH_BENCHMARK_SOURCE_MISMATCH: account_erasure_scrub_content';END IF;
    EXECUTE replace(definition,r,$x$  -- 0268 benchmarks
  DELETE FROM research_benchmarks WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('research_benchmarks_deleted',n);
$x$||r);
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.research_benchmark_item(uuid,uuid,text),public.research_benchmark_project(research_account_fetches),
  public.research_benchmark_sync(),public.research_benchmark_qualified(uuid,uuid),public.research_benchmark_required(jsonb,jsonb),
  public.research_benchmark_table(uuid,uuid),public.research_benchmark_report_current(uuid,uuid,jsonb),
  public.research_benchmark_operation_id(uuid,uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.research_benchmark_rows(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.research_benchmark_rows(uuid,uuid) TO service_role;

COMMIT;
