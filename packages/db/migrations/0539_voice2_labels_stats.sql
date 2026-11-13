-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- VOICE-2 PR-1 (文风 2.0; Owner 2026-11-14 chose to build phases 1 and 2 before launch): when "学习我的文风" runs, the same single
-- model call also labels each document it read with a type (short post / long article / video script / other) and a few topic
-- words, and code computes writing stats (sentence length, openings, punctuation, paragraphs). Both are saved on the profile
-- version, so PR-2 can pick 2-3 past pieces of the same type and a different topic as examples. Number 0539 from the controller (first 0536).
--   * voice_profile_versions gains stats (object, at most 4 KB) and documents (array of {documentId,type,topics,edited},
--     at most 32 KB); both NULL for versions made before. They live on the version row: deleting a document already deletes
--     every version that read it (voice_library_trigger), deleting a version or the account deletes the row, so nothing new
--     needs erasure wiring.
--   * voice_documents_valid: the shape check of documents (types, at most 5 topics of at most 20 characters, at most 200 entries).
--   * turn_voice_apply: whole current definition; also accepts stats and documents (a caller built before 0539 sends neither)
--     and keeps a label only for a document the version read.
--   * voice_version_view: whole current definition plus stats and documents (the page ignores keys it does not know).
--   * voice_profile_confirm: whole current definition; editing the confirmed profile copies stats and documents to the new
--     version (as it copies sources and corpus).
--   * voice_document_label_set(a, vid, did, type, topics): the user corrects one document's type or topics on a version of
--     their own (service_role, as the other voice functions); marks it edited. Unknown version or document: VOICE_VERSION_GONE.
-- Compatibility: columns added nullable (no rewrite); old code reads and writes as before. Repeatable: IF NOT EXISTS and
-- CREATE OR REPLACE only. Recovery: re-apply the 0459 definitions of turn_voice_apply and the 0341 definitions of
-- voice_version_view and voice_profile_confirm; the two columns may stay (unused) or be dropped with their data.
BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE public.voice_profile_versions ADD COLUMN IF NOT EXISTS stats jsonb
 CHECK(stats IS NULL OR (jsonb_typeof(stats)='object' AND octet_length(stats::text)<=4096));
ALTER TABLE public.voice_profile_versions ADD COLUMN IF NOT EXISTS documents jsonb
 CHECK(documents IS NULL OR (jsonb_typeof(documents)='array' AND octet_length(documents::text)<=32768));

CREATE OR REPLACE FUNCTION public.voice_documents_valid(d jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT jsonb_typeof(d)='array' AND jsonb_array_length(d)<=200 AND NOT EXISTS (
  SELECT 1 FROM jsonb_array_elements(d) e WHERE jsonb_typeof(e)<>'object'
   OR EXISTS (SELECT 1 FROM jsonb_object_keys(e) k WHERE k NOT IN ('documentId','type','topics','edited'))
   OR coalesce(e->>'documentId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR coalesce(e->>'type','') NOT IN ('post','article','script','other')
   OR jsonb_typeof(e->'topics') IS DISTINCT FROM 'array' OR jsonb_array_length(e->'topics')>5
   OR EXISTS (SELECT 1 FROM jsonb_array_elements(e->'topics') x WHERE jsonb_typeof(x)<>'string'
    OR char_length(x#>>'{}') NOT BETWEEN 1 AND 20)
   OR (e ? 'edited' AND jsonb_typeof(e->'edited')<>'boolean'));
$function$;

CREATE OR REPLACE FUNCTION public.turn_voice_apply(t turns, p_kind text, p_result jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- {versionId, profile[, stats, documents]}: the profile the caller parsed and checked against the corpus (voice.ts); VOICE-2
  -- (0539) adds the code-computed writing stats and each read document's type and topics. Nothing else is accepted; a caller
  -- built before 0539 sends only the first two keys.
  IF jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR jsonb_typeof(p_result->'profile') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_result->'versionId') IS DISTINCT FROM 'string'
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN ('versionId','profile','stats','documents'))
    OR (p_result ? 'stats' AND jsonb_typeof(p_result->'stats') IS DISTINCT FROM 'object')
    OR (p_result ? 'documents' AND NOT public.voice_documents_valid(p_result->'documents'))
    OR p_result->>'versionId' IS DISTINCT FROM t.policy->'voice'->>'versionId' THEN
    RAISE EXCEPTION 'TURN_KIND_RESULT_INVALID' USING ERRCODE='22023';
  END IF;
  -- Only a completed close saves the profile; an erased one (the version was deleted, the account is leaving) saves nothing.
  IF p_kind <> 'completed' THEN RETURN; END IF;
  -- Labels are kept only for documents the version read (its sources); any other entry is dropped, not saved.
  UPDATE voice_profile_versions SET profile = p_result->'profile', failure = NULL, billing_settled = true,
      stats = p_result->'stats',
      documents = (SELECT jsonb_agg(e ORDER BY o) FROM jsonb_array_elements(p_result->'documents') WITH ORDINALITY x(e,o)
        WHERE sources @> jsonb_build_array(jsonb_build_object('documentId', e->>'documentId'))),
      status = CASE WHEN corpus = voice_current_corpus(t.actor_id) THEN 'draft' ELSE 'stale' END, updated_at = clock_timestamp()
    WHERE id = (p_result->>'versionId')::uuid AND actor_id = t.actor_id AND status = 'generating';
END $function$;

CREATE OR REPLACE FUNCTION public.voice_version_view(v voice_profile_versions)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT CASE WHEN v.id IS NULL THEN NULL ELSE jsonb_build_object('id',v.id,'version',v.version,'status',v.status,
  'profile',v.profile,'stats',v.stats,'documents',coalesce(v.documents,'[]'),'failure',v.failure,'createdAt',v.created_at,'confirmedAt',v.confirmed_at,
  'sources',(SELECT coalesce(jsonb_agg(jsonb_build_object('documentId',d.id,'filename',d.filename) ORDER BY s.ord),'[]')
   FROM jsonb_array_elements(v.sources) WITH ORDINALITY s(item,ord)
   JOIN library_documents d ON d.id=(s.item->>'documentId')::uuid AND d.actor_id=v.actor_id AND d.deleted_at IS NULL))
 END;
$function$;

CREATE OR REPLACE FUNCTION public.voice_profile_confirm(a uuid, vid uuid, expected_revision integer, result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE p voice_profiles; v voice_profile_versions; old uuid;
BEGIN
 PERFORM library_actor(a);
 IF result IS NULL OR jsonb_typeof(result)<>'object' THEN RAISE EXCEPTION 'VOICE_INVALID'; END IF;
 INSERT INTO voice_profiles(actor_id) VALUES(a) ON CONFLICT(actor_id) DO NOTHING;
 SELECT * INTO p FROM voice_profiles WHERE actor_id=a FOR UPDATE;
 IF p.revision IS DISTINCT FROM expected_revision THEN RAISE EXCEPTION 'VOICE_REVISION_CONFLICT'; END IF;
 SELECT * INTO v FROM voice_profile_versions WHERE id=vid AND actor_id=a FOR UPDATE;
 IF v.id IS NULL THEN RAISE EXCEPTION 'VOICE_VERSION_GONE'; END IF;
 -- Checked again when it takes effect (LIBRARY-VOICE "保存和生效前比对"): a draft whose corpus changed is stale.
 IF v.status='stale' OR (v.status='draft' AND v.corpus IS DISTINCT FROM voice_current_corpus(a)) THEN
  RAISE EXCEPTION 'VOICE_STALE'; END IF;
 old:=p.confirmed_version_id;
 IF v.status='draft' THEN
  UPDATE voice_profile_versions SET profile=result,status='confirmed',confirmed_at=clock_timestamp(),
   updated_at=clock_timestamp() WHERE id=vid RETURNING * INTO v;
 ELSIF v.status='confirmed' AND v.id=old THEN
  -- VOICE pending result
  IF v.profile IS DISTINCT FROM result AND EXISTS(SELECT 1 FROM voice_profile_versions
   WHERE actor_id=a AND status IN ('generating','draft') AND version>v.version) THEN
   RAISE EXCEPTION 'VOICE_PENDING_RESULT'; END IF;
  IF v.profile=result THEN RETURN voice_state(a); END IF;
  -- An edit of the confirmed profile is a new version of the same reading: its stats and document labels go with it (0539).
  INSERT INTO voice_profile_versions(actor_id,request_id,version,status,profile,sources,corpus,billing_settled,confirmed_at,
   stats,documents)
  VALUES(a,gen_random_uuid(),(SELECT max(version) FROM voice_profile_versions WHERE actor_id=a)+1,'confirmed',result,
   v.sources,v.corpus,true,clock_timestamp(),v.stats,v.documents) RETURNING * INTO v;
 ELSE RAISE EXCEPTION 'VOICE_NOT_CONFIRMABLE'; END IF;
 UPDATE voice_profile_versions SET status='superseded',updated_at=clock_timestamp()
  WHERE id=old AND id<>v.id AND status='confirmed';
 UPDATE voice_profiles SET confirmed_version_id=v.id,revision=revision+1,updated_at=clock_timestamp() WHERE actor_id=a;
 RETURN voice_state(a);
END $function$;

CREATE OR REPLACE FUNCTION public.voice_document_label_set(a uuid, vid uuid, did uuid, label_type text, topics jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v voice_profile_versions; entry jsonb;
BEGIN
 PERFORM library_actor(a);
 IF vid IS NULL OR did IS NULL THEN RAISE EXCEPTION 'VOICE_INVALID'; END IF;
 entry:=jsonb_build_object('documentId',did,'type',label_type,'topics',coalesce(topics,'[]'),'edited',true);
 IF NOT voice_documents_valid(jsonb_build_array(entry)) THEN RAISE EXCEPTION 'VOICE_INVALID'; END IF;
 SELECT * INTO v FROM voice_profile_versions WHERE id=vid AND actor_id=a
  AND status IN ('draft','confirmed','superseded','stale') FOR UPDATE;
 IF v.id IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v.documents,'[]')) e WHERE e->>'documentId'=did::text)
 THEN RAISE EXCEPTION 'VOICE_VERSION_GONE'; END IF;
 UPDATE voice_profile_versions SET documents=(SELECT jsonb_agg(CASE WHEN e->>'documentId'=did::text THEN entry ELSE e END ORDER BY o)
   FROM jsonb_array_elements(v.documents) WITH ORDINALITY x(e,o)), updated_at=clock_timestamp()
  WHERE id=vid;
 RETURN voice_state(a);
END $function$;

REVOKE ALL ON FUNCTION public.voice_documents_valid(jsonb),public.voice_document_label_set(uuid,uuid,uuid,text,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.voice_document_label_set(uuid,uuid,uuid,text,jsonb) TO service_role;
COMMIT;
