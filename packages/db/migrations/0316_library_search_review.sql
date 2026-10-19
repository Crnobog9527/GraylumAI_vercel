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
-- Patch the current definition (0303 + 0306 my_posts rows) instead of replacing it, so later projections are kept.
DO $work$ DECLARE d text;anchor text;replacement text;
BEGIN
 d:=pg_get_functiondef('public.runtime_work_items(uuid,uuid)'::regprocedure);
 IF position('-- revision-stable library work rows' IN d)=0 THEN
  anchor:=$a$     OR runtime_library_visible(p_actor_id,e.id,t.result))$a$;
  replacement:=$p$     -- revision-stable library work rows
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
       AND rf.content_version::text=t.result->>'version' AND d.deleted_at IS NULL AND d.status='ready')))$p$;
  IF array_length(string_to_array(d,anchor),1)<>2 THEN RAISE EXCEPTION 'LIB_WORK_VISIBILITY_MISMATCH'; END IF;
  EXECUTE replace(d,anchor,replacement);
 END IF;
END $work$;
COMMIT;
