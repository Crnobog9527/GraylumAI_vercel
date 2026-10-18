-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved.
-- This code is proprietary and confidential.
-- CHAT-AUTO-CONTEXT post-merge review: independently indexed segment/file candidates, similarity tie-breaks,
-- and revision-stable historical work rows. No tables or persisted data change; strict tool replay is unchanged.
-- Repeatable guarded function patches. Rollback: restore the prior runtime_library_read and runtime_work_items
-- definitions from a pre-apply schema snapshot; no data restoration is needed.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ DECLARE src text; old text; replacement text;
BEGIN
 src:=pg_get_functiondef('public.runtime_library_read(uuid,uuid,text)'::regprocedure);
 IF position('-- indexed library candidates' IN src)=0 THEN
  old:=$old$  FOR hit IN SELECT * FROM ($old$;
  replacement:=$new$  FOR hit IN WITH candidates AS MATERIALIZED (
    SELECT cs.document_id,cs.ordinal FROM library_document_segments cs
     WHERE cs.actor_id=p_actor_id AND (cs.body ILIKE ANY(body_pats) OR cs.title ILIKE ANY(pats))
    UNION
    SELECT cs.document_id,cs.ordinal FROM library_documents cd
     JOIN library_document_segments cs ON cs.document_id=cd.id AND cs.actor_id=cd.actor_id
     WHERE cd.actor_id=p_actor_id AND cd.kind='document' AND cd.status='ready' AND cd.deleted_at IS NULL
      AND cd.filename ILIKE ANY(pats)
   ) SELECT * FROM ($new$;
  IF array_length(string_to_array(src,old),1)<>3 THEN
   RAISE EXCEPTION 'LIB_SOURCE_MISMATCH: indexed library search'; END IF;
  src:=replace(src,old,replacement);
  old:=$old$    FROM library_document_segments sg
    JOIN library_documents ld ON ld.id=sg.document_id AND ld.actor_id=sg.actor_id$old$;
  replacement:=$new$    FROM candidates c
    JOIN library_document_segments sg ON sg.document_id=c.document_id AND sg.ordinal=c.ordinal
    JOIN library_documents ld ON ld.id=sg.document_id AND ld.actor_id=sg.actor_id$new$;
  IF array_length(string_to_array(src,old),1)<>3 THEN
   RAISE EXCEPTION 'LIB_SOURCE_MISMATCH: indexed library search'; END IF;
  src:=replace(src,old,replacement);
  old:=$old$mt.score,mt.pos,sg.body,$old$;
  replacement:=$new$mt.score,mt.similarity,mt.pos,sg.body,$new$;
  IF array_length(string_to_array(src,old),1)<>3 THEN
   RAISE EXCEPTION 'LIB_SOURCE_MISMATCH: indexed library search'; END IF;
  src:=replace(src,old,replacement);
  old:=$old$ORDER BY mt.score DESC,sg.ordinal$old$;
  replacement:=$new$ORDER BY mt.score DESC,mt.similarity DESC,sg.ordinal$new$;
  IF array_length(string_to_array(src,old),1)<>3 THEN
   RAISE EXCEPTION 'LIB_SOURCE_MISMATCH: indexed library search'; END IF;
  src:=replace(src,old,replacement);
  old:=$old$SELECT count(*)::int score,min(nullif(position(lower(w) IN lower(sg.body)),0)) pos FROM unnest(terms) w$old$;
  replacement:=$new$SELECT count(*)::int score,min(nullif(position(lower(w) IN lower(sg.body)),0)) pos,
      max(greatest(extensions.similarity(w,sg.body),extensions.similarity(w,sg.title),
       extensions.similarity(w,coalesce(ld.filename,'')))) similarity FROM unnest(terms) w$new$;
  IF array_length(string_to_array(src,old),1)<>3 THEN
   RAISE EXCEPTION 'LIB_SOURCE_MISMATCH: indexed library search'; END IF;
  src:=replace(src,old,replacement);
  old:=$old$     AND (sg.body ILIKE ANY(body_pats) OR sg.title ILIKE ANY(pats) OR coalesce(ld.filename,'') ILIKE ANY(pats))$old$;
  replacement:='';
  IF array_length(string_to_array(src,old),1)<>3 THEN
   RAISE EXCEPTION 'LIB_SOURCE_MISMATCH: indexed library search'; END IF;
  src:=replace(src,old,replacement);
  old:=$old$ORDER BY score DESC,document_id,ordinal LIMIT 8$old$;
  replacement:=$new$ORDER BY score DESC,similarity DESC,document_id,ordinal LIMIT 8$new$;
  IF array_length(string_to_array(src,old),1)<>3 THEN
   RAISE EXCEPTION 'LIB_SOURCE_MISMATCH: indexed library search'; END IF;
  src:=replace(src,old,replacement);
  src:=replace(src,'  FOR hit IN WITH candidates AS MATERIALIZED (',E'  -- indexed library candidates\n  FOR hit IN WITH candidates AS MATERIALIZED (');
  EXECUTE src;
 END IF;
END $$;
-- Work rows contain frozen names, never source bodies. Ordinary revisions do not revoke those facts.
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
     OR (t.result->>'kind'='library_search' AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(coalesce(t.result->'hits','[]'::jsonb)) h
      WHERE NOT EXISTS (SELECT 1 FROM runtime_library_references rf
       JOIN library_documents d ON d.id=rf.document_id AND d.actor_id=rf.actor_id
       WHERE rf.execution_id=e.id AND rf.actor_id=p_actor_id AND rf.document_id::text=h->>'documentId'
        AND rf.content_version::text=h->>'version' AND d.deleted_at IS NULL AND d.status='ready')))
     OR (t.result->>'kind'='library_segment' AND EXISTS (
      SELECT 1 FROM runtime_library_references rf
      JOIN library_documents d ON d.id=rf.document_id AND d.actor_id=rf.actor_id
      WHERE rf.execution_id=e.id AND rf.actor_id=p_actor_id AND rf.document_id::text=t.result->>'documentId'
       AND rf.content_version::text=t.result->>'version' AND d.deleted_at IS NULL AND d.status='ready')))
  ) r WHERE r.n<=12 GROUP BY r.execution_id
 ) g;
 RETURN result;
END $$;
COMMIT;
