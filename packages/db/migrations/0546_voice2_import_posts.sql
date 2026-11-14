-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- VOICE-2 PR-5 (文风 2.0 phase 2, Owner 2026-11-14: import the user's own past posts; billed by actual use): the user picks posts
-- of an own connected account and each becomes a library document marked 「我本人写的」, so "学习我的文风" can read it. The posts
-- come from the account's latest paid TikHub read (数据复盘's refresh already reads the newest page of posts, bills it by use,
-- and keeps the answer in social_billed_reads for seven days, wiped when the connection goes): no new supplier call, no new
-- charge. Number 0546 from the controller.
--   * library_document_imports: which post a document came from, so the same post is imported once. Cascades with the document;
--     counted by library_erasure_remaining (account erasure deletes the documents, and these with them).
--   * voice_import_sources(a, routes): the account's own connected connections, each with the time and post count of its latest
--     usable read (routes: platform -> the TikHub account_posts route, from the app, so the read is the posts list).
--   * voice_import_candidates(a, cid, routes): that read's posts (id, text, link, time) and whether each is already imported.
--   * library_import_posts(a, cid, routes, ids): makes the picked posts documents. The text is taken from the same stored read,
--     never from the page; space is checked first (library_capacity), a document has no stored original (original_hold and
--     original_bytes 0, so library_usage counts only its text and the cleanup job finds no object to remove); a post already
--     imported (its document still live) is skipped; at most 30 per call.
-- All are service_role only (the app calls them for the signed-in account) and lock the account row (library_actor) where they
-- write. Compatibility: one new table and new functions only; library_erasure_remaining keeps its signature.
-- Repeatable: IF NOT EXISTS / CREATE OR REPLACE. Recovery: drop the three functions and the table (the documents stay as ordinary
-- documents); re-apply library_erasure_remaining from 0203.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE IF NOT EXISTS public.library_document_imports (
 document_id uuid PRIMARY KEY,
 actor_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 platform text NOT NULL CHECK(platform ~ '^[a-z0-9_-]{1,32}$'),
 platform_post_id text NOT NULL CHECK(char_length(platform_post_id) BETWEEN 1 AND 256),
 post_url text CHECK(post_url IS NULL OR char_length(post_url) BETWEEN 1 AND 2048),
 posted_at text CHECK(posted_at IS NULL OR char_length(posted_at)<=64),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(document_id,actor_id) REFERENCES public.library_documents(id,actor_id) ON DELETE CASCADE,
 UNIQUE(actor_id,connection_id,platform_post_id)
);
ALTER TABLE public.library_document_imports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.library_document_imports FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.library_erasure_remaining(a uuid)
 RETURNS bigint
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT (SELECT count(*) FROM library_documents WHERE actor_id=a)
  +(SELECT count(*) FROM library_document_segments WHERE actor_id=a)
  +(SELECT count(*) FROM library_recognition_units WHERE actor_id=a)
  +(SELECT count(*) FROM library_upload_reservations WHERE actor_id=a)
  +(SELECT count(*) FROM library_document_imports WHERE actor_id=a)
$function$;

-- The latest usable posts read of an own connected connection of the account, or NULL.
CREATE OR REPLACE FUNCTION public.voice_import_read(a uuid, cid uuid, routes jsonb)
 RETURNS social_billed_reads
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT r.* FROM social_connections c
 JOIN social_billed_reads r ON r.connection_id=c.id AND r.actor_id=a AND r.state='answered'
  AND r.result->>'route' IS NOT NULL AND r.result->>'route'=routes->>c.platform AND jsonb_typeof(r.result->'items')='array'
 WHERE c.id=cid AND c.actor_id=a AND c.role='own' AND c.status='connected'
 ORDER BY r.updated_at DESC LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.voice_import_post_items(r social_billed_reads)
 RETURNS TABLE(post_id text, body text, url text, posted_at text)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT i->'fields'->>'id', btrim(i->'fields'->>'title'), nullif(i->>'url',''), nullif(i->'fields'->>'publishedAt','')
 FROM jsonb_array_elements(coalesce(r.result->'items','[]')) i
 WHERE coalesce(i->'fields'->>'id','')<>'' AND char_length(i->'fields'->>'id')<=256
  AND coalesce(btrim(i->'fields'->>'title'),'')<>'';
$function$;

CREATE OR REPLACE FUNCTION public.voice_import_sources(a uuid, routes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 PERFORM library_actor(a);
 IF jsonb_typeof(routes) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'VOICE_INVALID'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('connectionId',c.id,'platform',c.platform,'displayHint',c.display_hint,
   'supported',routes ? c.platform,
   'fetchedAt',(voice_import_read(a,c.id,routes)).updated_at,
   'posts',(SELECT count(*) FROM voice_import_post_items(voice_import_read(a,c.id,routes))))
  ORDER BY c.platform,c.created_at),'[]')
  FROM social_connections c WHERE c.actor_id=a AND c.role='own' AND c.status='connected');
END $function$;

CREATE OR REPLACE FUNCTION public.voice_import_candidates(a uuid, cid uuid, routes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r social_billed_reads;
BEGIN
 PERFORM library_actor(a);
 IF cid IS NULL OR jsonb_typeof(routes) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'VOICE_INVALID'; END IF;
 r:=voice_import_read(a,cid,routes);
 IF r.id IS NULL THEN RETURN jsonb_build_object('fetchedAt',NULL,'posts','[]'::jsonb); END IF;
 RETURN jsonb_build_object('fetchedAt',r.updated_at,'posts',(SELECT coalesce(jsonb_agg(jsonb_build_object('postId',p.post_id,
   'text',p.body,'url',p.url,'postedAt',p.posted_at,'imported',EXISTS(SELECT 1 FROM library_document_imports m
    JOIN library_documents d ON d.id=m.document_id AND d.deleted_at IS NULL
    WHERE m.actor_id=a AND m.connection_id=cid AND m.platform_post_id=p.post_id))),'[]')
  FROM voice_import_post_items(r) p));
END $function$;

CREATE OR REPLACE FUNCTION public.library_import_posts(a uuid, cid uuid, routes jsonb, ids text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r social_billed_reads; c social_connections; p record; d library_documents; total bigint:=0; n integer:=0; skipped integer:=0;
 bytes bigint; label text;
BEGIN
 PERFORM library_actor(a);
 IF NOT EXISTS(SELECT 1 FROM system_settings WHERE key='library_upload_enabled' AND value::jsonb='true'::jsonb)
  THEN RAISE EXCEPTION 'LIBRARY_DISABLED'; END IF;
 IF cid IS NULL OR ids IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 30 OR jsonb_typeof(routes) IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION 'VOICE_INVALID'; END IF;
 r:=voice_import_read(a,cid,routes);
 IF r.id IS NULL THEN RAISE EXCEPTION 'VOICE_IMPORT_NOTHING'; END IF;
 SELECT * INTO c FROM social_connections WHERE id=cid AND actor_id=a;
 -- An import whose document was deleted since frees its post for a new import.
 DELETE FROM library_document_imports m USING library_documents x
  WHERE m.actor_id=a AND m.connection_id=cid AND x.id=m.document_id AND x.deleted_at IS NOT NULL;
 SELECT coalesce(sum(octet_length(p2.body)),0) INTO total FROM voice_import_post_items(r) p2
  WHERE p2.post_id=ANY(ids) AND NOT EXISTS(SELECT 1 FROM library_document_imports m
   WHERE m.actor_id=a AND m.connection_id=cid AND m.platform_post_id=p2.post_id);
 IF total>0 AND library_usage(a)+total>library_capacity(a) THEN RAISE EXCEPTION 'LIBRARY_SPACE'; END IF;
 IF (SELECT count(*) FROM library_documents WHERE actor_id=a)+cardinality(ids)>10000 THEN RAISE EXCEPTION 'LIBRARY_FILE_LIMIT'; END IF;
 label:=CASE c.platform WHEN 'douyin' THEN '抖音' WHEN 'xiaohongshu' THEN '小红书' WHEN 'bilibili' THEN 'B站' WHEN 'weibo' THEN '微博'
  WHEN 'tiktok' THEN 'TikTok' WHEN 'youtube' THEN 'YouTube' WHEN 'x' THEN 'X' WHEN 'instagram' THEN 'Instagram' ELSE c.platform END;
 FOR p IN SELECT * FROM voice_import_post_items(r) WHERE post_id=ANY(ids) LOOP
  IF EXISTS(SELECT 1 FROM library_document_imports m WHERE m.actor_id=a AND m.connection_id=cid AND m.platform_post_id=p.post_id)
   THEN skipped:=skipped+1; CONTINUE; END IF;
  bytes:=octet_length(p.body);
  IF bytes>8192 THEN skipped:=skipped+1; CONTINUE; END IF;
  INSERT INTO library_documents(actor_id,request_id,kind,format,purpose,filename)
  VALUES(a,gen_random_uuid(),'document','txt','authored',
   left(label||' · '||coalesce(left(p.posted_at,10)||' · ','')||left(regexp_replace(p.body,'\s+',' ','g'),24),200)||'.txt')
  RETURNING * INTO d;
  INSERT INTO library_upload_reservations(document_id,actor_id,original_hold,segment_hold,original_guard_until,original_path)
  VALUES(d.id,a,0,bytes,clock_timestamp(),a::text||'/'||d.id::text||'/original');
  INSERT INTO library_document_segments(document_id,actor_id,ordinal,title,body,source) VALUES(d.id,a,0,'',p.body,'extracted');
  UPDATE library_documents SET status='ready',original_bytes=0,text_bytes=bytes WHERE id=d.id;
  INSERT INTO library_document_imports(document_id,actor_id,connection_id,platform,platform_post_id,post_url,posted_at)
  VALUES(d.id,a,cid,c.platform,p.post_id,p.url,p.posted_at);
  n:=n+1;
 END LOOP;
 RETURN jsonb_build_object('imported',n,'skipped',skipped+(cardinality(ids)-n-skipped));
END $function$;

REVOKE ALL ON FUNCTION public.voice_import_read(uuid,uuid,jsonb),public.voice_import_post_items(social_billed_reads),
 public.voice_import_sources(uuid,jsonb),public.voice_import_candidates(uuid,uuid,jsonb),public.library_import_posts(uuid,uuid,jsonb,text[])
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.voice_import_sources(uuid,jsonb),public.voice_import_candidates(uuid,uuid,jsonb),
 public.library_import_posts(uuid,uuid,jsonb,text[]) TO service_role;
COMMIT;
