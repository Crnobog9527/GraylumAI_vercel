-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-6 (placeholder number 0498; the controller assigns the real one before it is applied): library_turn_read, the read_source tool of a turn on the core
-- path. Owner 2026-10-28 (ENGINEERING section 5 supplement, #1518): a free read tool may read the user's own material once
-- per call in the middle of a turn, read-only, by the owner's key, without locks or writes, counted against the turn's limit.
-- Every query carries the caller's actor key. So this function is STABLE: no row locks (no library_actor, no library_document_read, both of which lock), no inserts.
-- doc-N references are the turn's own: Node keeps the doc-N -> (document, version) map of this turn and passes the known
-- references in p_refs; a listing or a search returns documents without refs and Node numbers them.
--   ''/'library'           the first 10 ready documents (by file name)
--   'search:<1-5 words>'   the top 8 segments (at most 3 per document) matching the words, with short excerpts
--   'doc-N'                the segment titles of a known reference, 25 per page ('doc-N/page-P')
--   'doc-N/segment-S'      one segment's text (bounded)
-- A deleted or changed document is reported as unavailable, never read. A deleted conversation or an account being erased
-- reads nothing.
-- Compatibility: a new function only; nothing calls it until the core path's free chat offers read_source.
-- Repeatable: CREATE OR REPLACE. Recovery: DROP FUNCTION public.library_turn_read(uuid,uuid,text,jsonb); nothing depends on it.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.library_turn_read(p_actor_id uuid, p_session_id uuid, p_query text, p_refs jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE q text := btrim(coalesce(p_query, '')); m text[]; ref jsonb; d library_documents; seg library_document_segments;
  terms text[]; pats text[]; body_pats text[]; result jsonb; page integer; total integer; cap integer;
BEGIN
 IF p_actor_id IS NULL OR p_session_id IS NULL OR octet_length(q) > 400 OR jsonb_typeof(coalesce(p_refs, '[]'::jsonb)) <> 'array'
   OR jsonb_array_length(coalesce(p_refs, '[]'::jsonb)) > 30 THEN
  RAISE EXCEPTION 'LIBRARY_TURN_READ_INVALID' USING ERRCODE='22023';
 END IF;
 -- Only the caller's own live conversation, and never while the account is being erased (the same checks as turn_tombstones).
 IF NOT EXISTS (SELECT 1 FROM runtime_sessions s WHERE s.id = p_session_id AND s.actor_id = p_actor_id
     AND s.content_deleted_at IS NULL AND s.erased_at IS NULL)
   OR EXISTS (SELECT 1 FROM account_erasure_requests r WHERE r.profile_id = p_actor_id) THEN
  RETURN jsonb_build_object('kind', 'unavailable', 'reason', 'source_deleted');
 END IF;

 IF q = '' OR q = 'library' THEN
  RETURN jsonb_build_object('kind', 'library_index', 'documents', coalesce((SELECT jsonb_agg(jsonb_build_object('documentId', x.id,
      'version', x.content_version, 'title', left(coalesce(x.filename, ''), 160)) ORDER BY x.filename, x.id)
    FROM (SELECT id, content_version, filename FROM library_documents WHERE actor_id = p_actor_id AND kind = 'document'
      AND status = 'ready' AND deleted_at IS NULL ORDER BY filename, id LIMIT 10) x), '[]'::jsonb),
   'hint', 'Up to 10 documents are listed. Use search:<words> to find any other document.');
 END IF;

 IF q LIKE 'search:%' THEN
  SELECT coalesce(array_agg(DISTINCT w), '{}') INTO terms FROM (
   SELECT btrim(x) w FROM unnest(regexp_split_to_array(substr(q, 8), '[\s,，、;；]+')) x) t WHERE w <> '';
  IF cardinality(terms) NOT BETWEEN 1 AND 5 OR EXISTS (SELECT 1 FROM unnest(terms) w WHERE char_length(w) NOT BETWEEN 1 AND 40) THEN
   RETURN jsonb_build_object('kind', 'unavailable', 'reason', 'unknown_query');
  END IF;
  -- Literal LIKE patterns the trigram indexes can serve; bodies are matched by words of 2 or more characters only.
  SELECT array_agg('%' || replace(replace(replace(w, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%'),
    coalesce(array_agg('%' || replace(replace(replace(w, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%')
      FILTER (WHERE char_length(w) >= 2), '{}')
    INTO pats, body_pats FROM unnest(terms) w;
  SELECT jsonb_build_object('kind', 'library_search', 'terms', to_jsonb(terms), 'hits', coalesce(jsonb_agg(jsonb_build_object(
      'documentId', r.document_id, 'version', r.content_version, 'title', left(coalesce(r.filename, ''), 160),
      'segment', r.ordinal + 1, 'segmentTitle', left(r.title, 160), 'pageNumber', r.page_number,
      'excerpt', substr(r.body, greatest(1, coalesce(r.pos, 1) - 80), 240))
     ORDER BY r.score DESC, r.similarity DESC, r.document_id, r.ordinal), '[]'::jsonb))
   INTO result
  FROM (
   SELECT * FROM (
    SELECT sg.document_id, sg.ordinal, sg.title, sg.page_number, sg.body, ld.filename, ld.content_version, mt.score, mt.similarity, mt.pos,
      row_number() OVER (PARTITION BY sg.document_id ORDER BY mt.score DESC, mt.similarity DESC, sg.ordinal) per_doc
    FROM (SELECT cs.document_id, cs.ordinal FROM library_document_segments cs
           WHERE cs.actor_id = p_actor_id AND (cs.body ILIKE ANY(body_pats) OR cs.title ILIKE ANY(pats))
          UNION
          SELECT cs.document_id, cs.ordinal FROM library_documents cd
           JOIN library_document_segments cs ON cs.document_id = cd.id AND cs.actor_id = cd.actor_id
           WHERE cd.actor_id = p_actor_id AND cd.kind = 'document' AND cd.status = 'ready' AND cd.deleted_at IS NULL
             AND cd.filename ILIKE ANY(pats)) c
    JOIN library_document_segments sg ON sg.document_id = c.document_id AND sg.ordinal = c.ordinal
    JOIN library_documents ld ON ld.id = sg.document_id AND ld.actor_id = sg.actor_id
    CROSS JOIN LATERAL (SELECT count(*)::int score, min(nullif(position(lower(w) IN lower(sg.body)), 0)) pos,
        max(greatest(extensions.similarity(w, sg.body), extensions.similarity(w, sg.title),
          extensions.similarity(w, coalesce(ld.filename, '')))) similarity
      FROM unnest(terms) w
      WHERE (char_length(w) >= 2 AND sg.body ILIKE '%' || replace(replace(replace(w, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%')
        OR sg.title ILIKE '%' || replace(replace(replace(w, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%'
        OR coalesce(ld.filename, '') ILIKE '%' || replace(replace(replace(w, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%') mt
    WHERE sg.actor_id = p_actor_id AND ld.kind = 'document' AND ld.status = 'ready' AND ld.deleted_at IS NULL AND mt.score > 0
   ) ranked WHERE per_doc <= 3 ORDER BY score DESC, similarity DESC, document_id, ordinal LIMIT 8) r;
  -- Keep the result small: drop the weakest hits until it fits 6,000 bytes.
  WHILE octet_length(result::text) > 6000 AND jsonb_array_length(result->'hits') > 1 LOOP
   result := jsonb_set(result, '{hits}', (result->'hits') - (jsonb_array_length(result->'hits') - 1));
  END LOOP;
  RETURN result;
 END IF;

 m := regexp_match(q, '^(doc-(?:[1-9]|[12][0-9]|30))(?:/(page|segment)-([1-9][0-9]{0,4}))?$');
 IF m IS NULL THEN RETURN jsonb_build_object('kind', 'unavailable', 'reason', 'unknown_query'); END IF;
 SELECT value INTO ref FROM jsonb_array_elements(coalesce(p_refs, '[]'::jsonb)) WHERE value->>'ref' = m[1] LIMIT 1;
 IF ref IS NULL OR (ref->>'documentId') !~ '^[0-9a-f-]{36}$' OR (ref->>'version') !~ '^[1-9][0-9]{0,9}$' THEN
  RETURN jsonb_build_object('kind', 'unavailable', 'reason', 'unknown_query');
 END IF;
 SELECT * INTO d FROM library_documents WHERE id = (ref->>'documentId')::uuid AND actor_id = p_actor_id;
 IF d.id IS NULL OR d.deleted_at IS NOT NULL OR d.status <> 'ready' THEN
  RETURN jsonb_build_object('kind', 'unavailable', 'reason', 'source_deleted', 'ref', m[1]);
 END IF;
 IF d.content_version <> (ref->>'version')::integer THEN
  RETURN jsonb_build_object('kind', 'unavailable', 'reason', 'source_changed', 'ref', m[1]);
 END IF;
 IF m[2] IS NULL OR m[2] = 'page' THEN
  page := coalesce(m[3]::integer, 1);
  SELECT count(*) INTO total FROM library_document_segments WHERE document_id = d.id AND actor_id = p_actor_id;
  SELECT jsonb_build_object('kind', 'library_directory', 'ref', m[1], 'version', d.content_version, 'page', page,
    'pages', greatest(1, (total + 24) / 25), 'total', total,
    'entries', coalesce(jsonb_agg(jsonb_build_object('segment', s.ordinal + 1, 'title', left(s.title, 160), 'pageNumber', s.page_number)
      ORDER BY s.ordinal), '[]'::jsonb))
   INTO result FROM (SELECT * FROM library_document_segments WHERE document_id = d.id AND actor_id = p_actor_id
    ORDER BY ordinal OFFSET (page - 1) * 25 LIMIT 25) s;
  RETURN result;
 END IF;
 SELECT * INTO seg FROM library_document_segments WHERE document_id = d.id AND actor_id = p_actor_id AND ordinal = m[3]::integer - 1;
 IF seg.document_id IS NULL THEN RETURN jsonb_build_object('kind', 'unavailable', 'reason', 'unknown_query'); END IF;
 -- Segments are at most 8,192 bytes; heavily escaped text is shortened so the result stays bounded.
 FOREACH cap IN ARRAY ARRAY[8192, 4000, 2000] LOOP
  result := jsonb_build_object('kind', 'library_segment', 'ref', m[1], 'version', d.content_version, 'segment', seg.ordinal + 1,
    'title', left(seg.title, 160), 'pageNumber', seg.page_number, 'body', left(seg.body, cap), 'truncated', char_length(seg.body) > cap);
  EXIT WHEN octet_length(to_jsonb(result::text)::text) <= 16384;
 END LOOP;
 RETURN result;
END $function$;

REVOKE ALL ON FUNCTION public.library_turn_read(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.library_turn_read(uuid, uuid, text, jsonb) TO service_role;

COMMIT;
