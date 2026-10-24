-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE: deleting a positioning conversation timed out (validation of #1275, 2026-10-23). Number 0344 assigned by the
-- controller (2026-10-23). One-click deletion of a conversation bound to a draft runs the full cleanup inside the request
-- (0231 content_erasure_mark_session -> content_erasure_confirm); content_erasure_scope ran three times there, and its
-- frozen-material check scanned every runtime_scope_material row once per execution of the account, extracting the
-- execution's scopeMaterial key from its large payload on every row. On staging that check alone took about 3 s for
-- a 38-execution conversation, so the whole call passed PostgREST's 8 s statement timeout (503), and the retries that
-- held the locks longer deadlocked with the page's own reads (CONTENT_ERASURE_BUSY, 409).
-- 1. content_erasure_scope: the same frozen-material match, now read by its primary key (session_id, revision) with
--    the payload key read once per execution. Same rows: the old text comparisons are kept, and the key is cast only
--    when it is the canonical lower-case text a uuid compares equal to.
-- 2. content_erasure_mark_session: a conversation bound to a draft or a topic workspace never ends with the marker
--    alone, so it goes straight to the full cleanup, which computes its own scope; only for such a conversation is
--    the scope no longer computed here. The decision and every check are unchanged.
-- Functions are patched at unique anchors (0276 style); a rerun finds its marker and changes nothing (repeatable).
-- Compatibility: signatures, return shapes and results are unchanged, so code deployed before or after this applies
-- works the same; the local suite compares every scope before and after the patch row by row (scope-speed.mjs).
-- Rollback: forward-fix with a migration that puts the replaced text back (pg_get_functiondef + replace of the two
-- marked blocks); no data is written by this migration, so nothing else needs restoring.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION pg_temp.erase_speed_patch(sig text,marker text,olds text[],news text[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE definition text:=pg_get_functiondef(('public.'||sig)::regprocedure);
BEGIN
 IF position(marker IN definition)>0 THEN RETURN;END IF;
 FOR i IN 1..cardinality(olds) LOOP
  IF (length(definition)-length(replace(definition,olds[i],'')))/length(olds[i])<>1 THEN
   RAISE EXCEPTION 'CONTENT_ERASURE_SPEED_MISMATCH: % anchor %',sig,i;END IF;
  definition:=replace(definition,olds[i],news[i]);
 END LOOP;
 IF position(marker IN definition)=0 THEN RAISE EXCEPTION 'CONTENT_ERASURE_SPEED_MISMATCH: % marker',sig;END IF;
 EXECUTE definition;
END $$;

-- 1. The frozen material an execution was given, by its key.
SELECT pg_temp.erase_speed_patch('content_erasure_scope(uuid,text,uuid)','-- ERASE-SPEED material key',ARRAY[
 $a$   OR EXISTS(SELECT 1 FROM runtime_scope_material mat WHERE
    (mat.request_id=ANY(refs)$a$,
 $a$    AND mat.session_id::text=ex.payload#>>'{scopeMaterial,sessionId}' AND mat.revision::text=ex.payload#>>'{scopeMaterial,revision}')));$a$],ARRAY[
 $b$   -- ERASE-SPEED material key: read once per execution (OFFSET 0 keeps it from being re-read per material row).
   OR EXISTS(SELECT 1 FROM (SELECT ex.payload#>>'{scopeMaterial,sessionId}' sid,ex.payload#>>'{scopeMaterial,revision}' rev
     OFFSET 0) k
    JOIN runtime_scope_material mat ON mat.session_id=CASE WHEN k.sid ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     THEN k.sid::uuid END AND mat.session_id::text=k.sid AND mat.revision::text=k.rev WHERE
    (mat.request_id=ANY(refs)$b$,
 $b$    )));$b$]);

-- 2. No scope for a conversation that always takes the full cleanup.
SELECT pg_temp.erase_speed_patch('content_erasure_mark_session(uuid,uuid)','-- ERASE-SPEED bound first',ARRAY[
 $a$local boolean; stamp timestamptz;$a$,
 $a$ scope:=content_erasure_scope(a,'session',target);
 SELECT coalesce(array_agg(v::uuid),'{}') INTO ids FROM jsonb_array_elements_text(scope->'executions') v;
 refs:=ids||target;
 local:=s.scope->>'kind'='positioning_draft'$a$],ARRAY[
 $b$local boolean; stamp timestamptz; unbound boolean;$b$,
 $b$ -- ERASE-SPEED bound first: a conversation bound to a draft or a topic workspace (the same two conditions as
 -- below) is never cleaned by the marker alone; only for it is the scope not computed here.
 unbound:=NOT EXISTS(SELECT 1 FROM opc_drafts d WHERE d.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM opc_topic_workspaces t WHERE t.session_id=target);
 IF unbound THEN
  scope:=content_erasure_scope(a,'session',target);
  SELECT coalesce(array_agg(v::uuid),'{}') INTO ids FROM jsonb_array_elements_text(scope->'executions') v;
  refs:=ids||target;
 END IF;
 local:=unbound AND s.scope->>'kind'='positioning_draft'$b$]);

COMMIT;
