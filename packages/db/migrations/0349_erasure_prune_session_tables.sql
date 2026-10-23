-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE: filter session-owned Runtime rows before reading JSON (0333 did runtime_executions).
-- erasure_business_owner resolves runtime_session_batches/history through runtime_sessions.actor_id by
-- session_id (NOT NULL uuid with FK), so "session_id IN own sessions" selects exactly the same rows without
-- serializing every row of the table. The two tables get their own pass ahead of the shared loop, which they
-- then skip; that pass keeps the shared loop's only guard that applies to them (live rows with erased_at NULL
-- stay) and its delete/exception handling. 0333's patched text stays intact, so 0333 still repeats cleanly.
-- Re-runnable (marker check), old code compatible (same signature and result), no data written.
-- Rollback: forward fix removing the inserted block; no facts depend on this patch.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $patch$
DECLARE src text;
 anchor text:=$a$  IF legacy_evidence AND (t LIKE 'artifact_%' OR t IN ('agent_slice_links','opc_result_links')) THEN CONTINUE; END IF;
$a$;
 block text:=$b$  -- 0349: session-owned Runtime rows are found through the owner's sessions, not by serializing each row.
  IF t IN ('runtime_session_batches','runtime_session_history') THEN
   FOR item IN EXECUTE format('SELECT ctid AS row_tid,to_jsonb(x) AS body FROM public.%I x
    WHERE x.session_id IN (SELECT s.id FROM public.runtime_sessions s WHERE s.actor_id=$1)
    LIMIT $2 FOR UPDATE SKIP LOCKED',t)
    USING p_profile_id,p_limit-removed LOOP
    IF item.body ? 'erased_at' AND item.body->>'erased_at' IS NULL THEN CONTINUE; END IF;
    BEGIN
     EXECUTE format('DELETE FROM public.%I WHERE ctid=$1',t) USING item.row_tid;
     GET DIAGNOSTICS n=ROW_COUNT;removed:=removed+n;
    EXCEPTION WHEN foreign_key_violation OR check_violation OR lock_not_available THEN
     NULL;
    END;
   END LOOP;
   CONTINUE;
  END IF;
$b$;
BEGIN
 src:=pg_get_functiondef('public.account_erasure_prune_business(uuid,integer)'::regprocedure);
 IF position(block IN src)>0 THEN RETURN;END IF;
 IF array_length(string_to_array(src,anchor),1)<>2 THEN
  RAISE EXCEPTION 'ERASURE_PRUNE_SESSION_SOURCE_MISMATCH';
 END IF;
 EXECUTE replace(src,anchor,anchor||block);
END $patch$;
COMMIT;
