-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- VOICE-2 PR-2 (文风 2.0; Owner 2026-11-14): when the user asks for writing, the reply also gets 2-3 short passages of the
-- user's own past writing of the same type and a different topic (picked by code from the labels 0539 saved), and the
-- confirmed voice carries the code-computed writing stats. Number 0540 from the controller.
--   * voice_profile_read: whole current definition plus stats and documents of the version (callers built before read only
--     the profile).
--   * voice_examples_read(a, vid, ids): the opening text (at most 2,000 characters of its first three segments) of up to 3 documents, only when vid is the
--     account's own confirmed or superseded version and each document is one it read (its sources), still ready and at the
--     same content version. Anything else is left out, never an error. service_role only, as voice_profile_read.
-- Deletion: the passages are only ever documents of the version; deleting one deletes the version (voice_library_trigger),
-- which voids a running reply bound to it (turn_tombstones, unchanged). The passages travel with the current message only:
-- they are never stored in the conversation history.
-- Compatibility: no table change; old code ignores the new keys. Repeatable: CREATE OR REPLACE only.
-- Recovery: re-apply voice_profile_read from 0341_voice_profiles.sql and DROP FUNCTION public.voice_examples_read(uuid,uuid,uuid[]).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.voice_profile_read(a uuid, vid uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT jsonb_build_object('versionId',id,'version',version,'profile',profile,'stats',stats,'documents',coalesce(documents,'[]'))
 FROM voice_profile_versions
 WHERE id=vid AND actor_id=a AND status IN ('confirmed','superseded');
$function$;

CREATE OR REPLACE FUNCTION public.voice_examples_read(a uuid, vid uuid, ids uuid[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT coalesce(jsonb_agg(jsonb_build_object('documentId',d.id,'filename',d.filename,'text',
   left((SELECT string_agg(s.body,E'\n' ORDER BY s.ordinal) FROM (SELECT body,ordinal FROM library_document_segments
     WHERE document_id=d.id ORDER BY ordinal LIMIT 3) s),2000)) ORDER BY x.ord),'[]')
 FROM voice_profile_versions v
 CROSS JOIN LATERAL unnest(ids[1:3]) WITH ORDINALITY x(id,ord)
 JOIN library_documents d ON d.id=x.id AND d.actor_id=a AND d.kind='document' AND d.status='ready' AND d.deleted_at IS NULL
 WHERE v.id=vid AND v.actor_id=a AND v.status IN ('confirmed','superseded')
  AND v.sources @> jsonb_build_array(jsonb_build_object('documentId',d.id,'contentVersion',d.content_version));
$function$;

REVOKE ALL ON FUNCTION public.voice_examples_read(uuid,uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.voice_examples_read(uuid,uuid,uuid[]) TO service_role;
COMMIT;
