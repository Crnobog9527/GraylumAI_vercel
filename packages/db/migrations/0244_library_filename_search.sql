-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- UI-B / LIB-DOCS: filename search for the @ picker. Read-only, no table or setting changes.
-- Number 0244 assigned by control on 2026-10-14. Repeatable: CREATE OR REPLACE and idempotent grants.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Only the caller's own documents; documents being deleted never appear. The term is matched literally:
-- \, % and _ are escaped, so it cannot act as a LIKE pattern. 1–100 characters, 50 per page, same cursor as the list.
CREATE OR REPLACE FUNCTION public.library_search(a uuid,q text,after_created_at timestamptz DEFAULT NULL,after_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE term text:=btrim(coalesce(q,'')); pattern text; rows jsonb; last_row jsonb; more boolean;
BEGIN
 PERFORM library_actor(a);
 IF char_length(term) NOT BETWEEN 1 AND 100 OR (after_created_at IS NULL)<>(after_id IS NULL)
  OR (after_created_at IS NOT NULL AND NOT isfinite(after_created_at)) THEN RAISE EXCEPTION 'LIBRARY_INVALID'; END IF;
 pattern:='%'||replace(replace(replace(term,'\','\\'),'%','\%'),'_','\_')||'%';
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC,x.id DESC),'[]') INTO rows
 FROM (SELECT id,kind,format,purpose,filename,status,original_bytes,text_bytes,content_version,created_at
  FROM library_documents WHERE actor_id=a AND status<>'deleting' AND filename ILIKE pattern ESCAPE '\'
  AND (after_id IS NULL OR (created_at,id)<(after_created_at,after_id))
  ORDER BY created_at DESC,id DESC LIMIT 51) x;
 more:=jsonb_array_length(rows)>50;
 IF more THEN rows:=rows-50; END IF;
 last_row:=rows->(jsonb_array_length(rows)-1);
 RETURN jsonb_build_object('documents',rows,'nextCursor',CASE WHEN more THEN
  jsonb_build_object('createdAt',last_row->'created_at','id',last_row->'id') ELSE NULL END);
END $$;

REVOKE ALL ON FUNCTION public.library_search(uuid,text,timestamptz,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.library_search(uuid,text,timestamptz,uuid) TO service_role;
COMMIT;
