-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- LIB-DOCS: a published document counts its actual bytes instead of the 10 MB per-path upload holds.
-- No table, settings, bucket or permission changes; repeatable. Number 0213 pending control confirmation.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- Holds stay unchanged: they still drive cleanup and cover the live token window after deletion.
-- A ready, undeleted document is not writable through its old tokens: every path was signed with
-- upsert=false, the service inspected each existing object's size before the locked publish, and no
-- Storage policy lets users remove objects. Deletion sets cleanup=true in the same transaction, so a
-- deleted document immediately falls back to its full holds (a removed path can be recreated by a
-- live token until the guard ends). Only the Word/PDF publishers set text_bytes for a text path, and
-- both verify it against the inspected text object.
CREATE OR REPLACE FUNCTION public.library_usage(a uuid) RETURNS bigint
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce(sum(CASE WHEN d.status='ready' AND NOT r.cleanup
   THEN d.original_bytes+CASE WHEN r.text_path IS NULL THEN 0 ELSE d.text_bytes END
   ELSE r.original_hold+r.text_hold END+r.segment_hold),0)::bigint
 FROM library_upload_reservations r JOIN library_documents d ON d.id=r.document_id WHERE r.actor_id=a
$$;
COMMIT;
