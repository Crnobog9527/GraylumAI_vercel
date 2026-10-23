-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE: filter session-owned Runtime rows before reading JSON (0333 did runtime_executions).
-- erasure_business_owner resolves runtime_session_batches/history through runtime_sessions.actor_id
-- by session_id (NOT NULL uuid with FK), so "session_id IN own sessions" selects exactly the same rows
-- without serializing every row. Financial and deletion guards stay authoritative.
-- Re-runnable (marker check), old code compatible (same signature and result), no data written.
-- Rollback: forward fix restoring the 0333 text; no facts depend on this patch.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $patch$
DECLARE src text;
 old_query text:=$old$   CASE WHEN t='runtime_executions' THEN 'x.actor_id=$1'
    ELSE format('public.erasure_business_owner(%L,to_jsonb(x))=$1',t) END)$old$;
 new_query text:=$new$   CASE WHEN t='runtime_executions' THEN 'x.actor_id=$1'
    WHEN t IN ('runtime_session_batches','runtime_session_history')
     THEN 'x.session_id IN (SELECT s.id FROM public.runtime_sessions s WHERE s.actor_id=$1)'
    ELSE format('public.erasure_business_owner(%L,to_jsonb(x))=$1',t) END)$new$;
BEGIN
 src:=pg_get_functiondef('public.account_erasure_prune_business(uuid,integer)'::regprocedure);
 IF position(new_query IN src)>0 THEN RETURN;END IF;
 IF array_length(string_to_array(src,old_query),1)<>2 THEN
  RAISE EXCEPTION 'ERASURE_PRUNE_SESSION_SOURCE_MISMATCH';
 END IF;
 EXECUTE replace(src,old_query,new_query);
END $patch$;
COMMIT;
