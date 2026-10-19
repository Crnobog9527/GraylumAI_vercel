-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- RESEARCH-TOOLS: benchmark evidence may span several pages of an account's posts.
-- benchmark_fetch (research/runtime/benchmarkFetch.ts) follows the supplier cursor when one page falls short of the
-- 20-post rule (#1140 Xiaohongshu, #1159 TikTok and Douyin); each later page is a billed subcall with its own stable id,
-- stableResearchId(fetchId, attempt, 'account_posts', String(page)). 0268 research_benchmark_project only knew the
-- page-1 id, so every paged account was quarantined as EVIDENCE_UNVERIFIED with no numbers, and no positioning could
-- reach the 3-qualified report gate. This patch accepts pages 1–3 of the same fetch attempt (1 + the largest
-- BENCHMARK_EXTRA_POST_PAGES, pinned by benchmarkIds.test.ts) and reads them in supplier order (page, then item) as
-- benchmark_fetch concatenates them. Every other check is unchanged: refs must still name items of this actor's live
-- session, numbers must still equal or be recomputed from those items, and thresholds still apply.
-- Already quarantined rows whose fetch still has its success attempt are projected again from their stored evidence
-- (no supplier call, no charge): they become qualified only if that evidence now verifies.
-- Compatibility: old code writes the same caches; it never reads the new function. Repeatable: CREATE OR REPLACE and a
-- text-marker patch skipped once its marker is present; re-projection is idempotent. Recovery: restore
-- research_benchmark_project from 0268 and drop research_benchmark_post_operations; rows re-derive from
-- research_account_fetches.
BEGIN;
SET LOCAL lock_timeout='5s';

-- The posts-list subcalls of one fetch attempt, page 1 first: page 1 is 0268's id for 'account_posts'; page n>1 is
-- stableResearchId(fetchId, attempt, 'account_posts', String(n)) (JSON.stringify spelling, no spaces).
CREATE OR REPLACE FUNCTION public.research_benchmark_post_operations(p_fetch uuid, p_attempt uuid) RETURNS uuid[]
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT array_agg(id ORDER BY n) FROM (
    SELECT 1 n,research_benchmark_operation_id(p_fetch,p_attempt,'account_posts') id
    UNION ALL
    SELECT n,(substr(h,1,8)||'-'||substr(h,9,4)||'-4'||substr(h,14,3)||'-a'||substr(h,18,3)||'-'||substr(h,21,12))::uuid
    FROM generate_series(2,3) n CROSS JOIN LATERAL (SELECT encode(sha256(convert_to(
      '["'||p_fetch::text||'","'||p_attempt::text||'","account_posts","'||n::text||'"]','utf8')),'hex') h) z) pages
$$;
REVOKE ALL ON FUNCTION public.research_benchmark_post_operations(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

DO $migration$ DECLARE definition text; t text; BEGIN
  definition:=pg_get_functiondef('public.research_benchmark_project(research_account_fetches)'::regprocedure);
  IF position('-- 0315 paged posts' IN definition)=0 THEN
    t:=$p$SELECT t.i,t.x->'fields' fl,coalesce(nullif(t.x->'fields'->>'id',''),'#'||t.i) post_key,$p$;
    IF array_length(string_to_array(definition,t),1)<>2 THEN
      RAISE EXCEPTION 'RESEARCH_BENCHMARK_SOURCE_MISMATCH: research_benchmark_project';END IF;
    definition:=replace(definition,t,$p$SELECT pg.page,pg.op,t.i,t.x->'fields' fl,coalesce(nullif(t.x->'fields'->>'id',''),'#'||pg.page||':'||t.i) post_key,$p$);
    t:=$p$  ok:=ok AND ops<@ARRAY(SELECT research_benchmark_operation_id(f.id,f.last_success_attempt,k)
    FROM unnest(ARRAY['account_profile','account_posts','account_relation','post_detail']) k);$p$;
    IF array_length(string_to_array(definition,t),1)<>2 THEN
      RAISE EXCEPTION 'RESEARCH_BENCHMARK_SOURCE_MISMATCH: research_benchmark_project';END IF;
    definition:=replace(definition,t,$p$  -- 0315 paged posts: a later page of the posts list is a subcall of this fetch attempt too.
  ok:=ok AND ops<@(ARRAY(SELECT research_benchmark_operation_id(f.id,f.last_success_attempt,k)
    FROM unnest(ARRAY['account_profile','account_posts','account_relation','post_detail']) k)||research_benchmark_post_operations(f.id,f.last_success_attempt));$p$);
    t:=$p$        WHERE o.id=research_benchmark_operation_id(f.id,f.last_success_attempt,'account_posts') AND p.actor_id=f.actor_id
          AND p.session_id=f.session_id AND o.state='succeeded' AND o.erased_at IS NULL),false);$p$;
    IF array_length(string_to_array(definition,t),1)<>2 THEN
      RAISE EXCEPTION 'RESEARCH_BENCHMARK_SOURCE_MISMATCH: research_benchmark_project';END IF;
    definition:=replace(definition,t,$p$        WHERE o.id=ANY(research_benchmark_post_operations(f.id,f.last_success_attempt)) AND p.actor_id=f.actor_id
          AND p.session_id=f.session_id AND o.state='succeeded' AND o.erased_at IS NULL),false);$p$);
    t:=$p$      WHERE o.id=research_benchmark_operation_id(f.id,f.last_success_attempt,'account_posts') AND p.actor_id=f.actor_id
        AND p.session_id=f.session_id AND o.state='succeeded' AND o.erased_at IS NULL
    ), items AS (SELECT DISTINCT ON (post_key) * FROM entries ORDER BY post_key,i),
    analyzed AS (SELECT * FROM items ORDER BY published DESC NULLS LAST,i LIMIT 30)$p$;
    IF array_length(string_to_array(definition,t),1)<>2 THEN
      RAISE EXCEPTION 'RESEARCH_BENCHMARK_SOURCE_MISMATCH: research_benchmark_project';END IF;
    definition:=replace(definition,t,$p$      JOIN unnest(research_benchmark_post_operations(f.id,f.last_success_attempt)) WITH ORDINALITY pg(op,page) ON pg.op=o.id
      WHERE p.actor_id=f.actor_id
        AND p.session_id=f.session_id AND o.state='succeeded' AND o.erased_at IS NULL
    ), items AS (SELECT DISTINCT ON (post_key) * FROM entries ORDER BY post_key,page,i),
    analyzed AS (SELECT * FROM items ORDER BY published DESC NULLS LAST,page,i LIMIT 30)$p$);
    t:=$p$FROM (SELECT research_benchmark_operation_id(f.id,f.last_success_attempt,'account_posts')::text||'#'||i r,$p$;
    IF array_length(string_to_array(definition,t),1)<>2 THEN
      RAISE EXCEPTION 'RESEARCH_BENCHMARK_SOURCE_MISMATCH: research_benchmark_project';END IF;
    definition:=replace(definition,t,$p$FROM (SELECT op::text||'#'||i r,$p$);
    t:=$p$FROM unnest(ARRAY['account_profile','account_posts','account_relation','post_detail']) k))) x ORDER BY x),$p$;
    IF array_length(string_to_array(definition,t),1)<>2 THEN
      RAISE EXCEPTION 'RESEARCH_BENCHMARK_SOURCE_MISMATCH: research_benchmark_project';END IF;
    definition:=replace(definition,t,$p$FROM unnest(ARRAY['account_profile','account_posts','account_relation','post_detail']) k)
        OR o.id=ANY(research_benchmark_post_operations(f.id,f.last_success_attempt)))) x ORDER BY x),$p$);
    EXECUTE definition;
  END IF;
END $migration$;

-- Re-check quarantined rows from their stored evidence under the patched rules.
DO $$ DECLARE f research_account_fetches; BEGIN
  FOR f IN SELECT a.* FROM research_account_fetches a JOIN research_benchmarks b ON b.fetch_id=a.id
    WHERE b.excluded='EVIDENCE_UNVERIFIED' AND a.last_success IS NOT NULL AND a.last_success_attempt IS NOT NULL
    ORDER BY a.id LOOP
    PERFORM research_benchmark_project(f);
  END LOOP;
END $$;
COMMIT;
