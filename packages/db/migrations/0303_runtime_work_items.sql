-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- CHAT-AUTO-CONTEXT A2b (docs/launch/tasks/CHAT-AUTO-CONTEXT.md section 4): what the coach read before each answer of a
-- conversation, for the work rows shown above the reply. A read-only projection of the saved read_source journal; it does
-- not touch runtime_view, adds no table and no column. Repeatable (CREATE OR REPLACE).
--
-- Only plain facts leave the database: the kind of step, its state, a fixed label, and the user's own file names, search
-- words and segment titles (never a document body, an excerpt or a benchmark number). Rows whose source is gone are not
-- returned at once (library results are checked with runtime_library_visible, as a replay is), and erased or deleted
-- answers and conversations return nothing; answers runtime_view hides (unavailable_reason, failed availability check) too. At most 12 rows per answer, in a fixed kind order.
-- Rollback: DROP FUNCTION public.runtime_work_items(uuid,uuid); nothing else depends on it.
BEGIN;
CREATE OR REPLACE FUNCTION public.runtime_work_items(p_actor_id uuid,p_session_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions; result jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
 IF s.id IS NULL OR s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL
  OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED'; END IF;
 -- The same fence as runtime_view: an answer it hides (an unavailable_reason, or one that fails runtime_history_availability)
 -- shows no work rows either.
 WITH availability AS MATERIALIZED (
  SELECT a.execution_id id,a.available FROM runtime_history_availability(ARRAY(
   SELECT e.id FROM runtime_executions e JOIN bill2_runs b ON b.id=e.billing_run_id WHERE e.session_id=s.id)) a
 )
 SELECT coalesce(jsonb_object_agg(g.execution_id::text,g.items),'{}'::jsonb) INTO result FROM (
  SELECT r.execution_id,jsonb_agg(r.item||jsonb_build_object('id',r.call_id) ORDER BY r.rank,r.call_id) items FROM (
   SELECT t.execution_id,t.call_id,w.rank,w.item,row_number() OVER (PARTITION BY t.execution_id ORDER BY w.rank,t.call_id) n
   FROM runtime_executions e
   JOIN runtime_tool_calls t ON t.execution_id=e.id AND t.name='read_source' AND t.erased_at IS NULL
   CROSS JOIN LATERAL (
    SELECT * FROM (VALUES (
     CASE
      WHEN t.result->>'kind'='workspace_source' AND t.result#>>'{identity,kind}'='positioning' THEN 1
      WHEN t.result->>'kind'='workspace_source' AND t.result#>>'{identity,kind}'='benchmarks' THEN 2
      WHEN t.result->>'kind'='library_search' THEN 3
      WHEN t.result->>'kind'='library_segment' THEN 4
      WHEN t.result IS NULL AND e.state IN ('prepared','running') AND t.arguments->>'query' LIKE 'search:%' THEN 3
      WHEN t.result IS NULL AND e.state IN ('prepared','running') AND t.arguments->>'query' LIKE 'doc-%' THEN 4
     END,
     CASE
      WHEN t.result->>'kind'='workspace_source' AND t.result#>>'{identity,kind}'='positioning' THEN
       jsonb_build_object('kind','positioning','state','done','label','读了你确认的定位','detail',left(t.result#>>'{identity,name}',80))
      WHEN t.result->>'kind'='workspace_source' AND t.result#>>'{identity,kind}'='benchmarks' THEN
       jsonb_build_object('kind','my_benchmarks','state','done','label','看了你的对标账号数据')
      WHEN t.result->>'kind'='library_search' THEN (
       SELECT CASE WHEN count(*)>0 THEN jsonb_build_object('kind','library_search','state','done',
         'label','在资料库里找到 '||count(*)||' 篇相关内容','detail',left(string_agg(title,'、' ORDER BY title),120))
        ELSE jsonb_build_object('kind','library_search','state','missing','label','资料库里没找到相关内容',
         'detail',left('搜索词：'||coalesce((SELECT string_agg(w2,' ') FROM jsonb_array_elements_text(coalesce(t.result->'terms','[]')) w2),''),120)) END
       FROM (SELECT DISTINCT h->>'documentId' doc,left(coalesce(nullif(h->>'title',''),'（未命名）'),60) title
        FROM jsonb_array_elements(coalesce(t.result->'hits','[]')) h) d)
      WHEN t.result->>'kind'='library_segment' THEN
       jsonb_build_object('kind','library_read','state','done','label','读了一段资料','detail',left(t.result->>'title',80))
      WHEN t.result IS NULL AND t.arguments->>'query' LIKE 'search:%' THEN
       jsonb_build_object('kind','library_search','state','running','label','')
      WHEN t.result IS NULL THEN jsonb_build_object('kind','library_read','state','running','label','')
     END)) v(rank,item) WHERE v.rank IS NOT NULL) w
   JOIN availability av ON av.id=e.id AND av.available
   WHERE e.session_id=s.id AND e.actor_id=p_actor_id AND e.erased_at IS NULL AND e.content_deleted_at IS NULL
    AND e.unavailable_reason IS NULL
    AND (t.result IS NULL OR t.result->>'kind' NOT IN ('library_search','library_segment')
     OR runtime_library_visible(p_actor_id,e.id,t.result))
  ) r WHERE r.n<=12 GROUP BY r.execution_id
 ) g;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.runtime_work_items(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.runtime_work_items(uuid,uuid) TO service_role;
COMMIT;
