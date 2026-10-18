/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- RATE-LIMIT: retain whether the current BILL2 call already consumed its rate slot across explicit resumes.
-- No schema change. An older host reserved the full round before its wait; missing markers are grandfathered as passed.
-- Reapplying this migration is a no-op after the returned checkpoint field is installed.
-- Recovery: leave the additive field in place; older hosts ignore it, and do not remove it while this host is active.
BEGIN;
DO $migration$
DECLARE definition text;anchor text;replacement text;
BEGIN
 definition:=pg_get_functiondef('public.runtime_execution(uuid,uuid,text,jsonb)'::regprocedure);
 IF position('gatePassed' IN definition)=0 THEN
 anchor:=$anchor$OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN ('epoch','state','sequence','requestHash','phase'))$anchor$;
 replacement:=$patch$OR (p_result ? 'gatePassed' AND coalesce(jsonb_typeof(p_result->'gatePassed')<>'boolean',true))
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN ('epoch','state','sequence','requestHash','phase','gatePassed'))$patch$;
 IF array_length(string_to_array(definition,anchor),1)<>2 THEN RAISE EXCEPTION 'RATE_LIMIT_WAIT_CHECKPOINT_MISMATCH';END IF;
 definition:=replace(definition,anchor,replacement);
 anchor:=$anchor$'phase',pending_call.payload->>'phase','sessionRevision',s.revision,
      'materialRevision',coalesce((SELECT max(revision) FROM runtime_scope_material WHERE session_id=s.id),0)))$anchor$;
 replacement:=$patch$'phase',pending_call.payload->>'phase','sessionRevision',s.revision,
      'materialRevision',coalesce((SELECT max(revision) FROM runtime_scope_material WHERE session_id=s.id),0),
      'gatePassed',pending_call.id IS NOT NULL))$patch$;
 IF array_length(string_to_array(definition,anchor),1)<>2 THEN RAISE EXCEPTION 'RATE_LIMIT_WAIT_DEADLINE_MISMATCH';END IF;
 definition:=replace(definition,anchor,replacement);
 anchor:=$anchor$'phase',p_result->>'phase','sessionRevision',s.revision,
      'materialRevision',coalesce((SELECT max(revision) FROM runtime_scope_material WHERE session_id=s.id),0))$anchor$;
 replacement:=$patch$'phase',p_result->>'phase','sessionRevision',s.revision,
      'materialRevision',coalesce((SELECT max(revision) FROM runtime_scope_material WHERE session_id=s.id),0),
      'gatePassed',coalesce((p_result->>'gatePassed')::boolean,p_result->>'state' IN ('waiting_credits','waiting_resume')))$patch$;
 IF array_length(string_to_array(definition,anchor),1)<>2 THEN RAISE EXCEPTION 'RATE_LIMIT_WAIT_CURSOR_MISMATCH';END IF;
 definition:=replace(definition,anchor,replacement);
 anchor:=$anchor$'remainingCalls',b.max_calls-(SELECT count(*) FROM bill2_calls WHERE run_id=b.id),$anchor$;
 replacement:=$patch$'remainingCalls',b.max_calls-(SELECT count(*) FROM bill2_calls WHERE run_id=b.id),
  'gatePassed',coalesce((b.runtime_checkpoint->>'gatePassed')::boolean,e.state IN ('waiting_credits','waiting_resume')),$patch$;
 IF array_length(string_to_array(definition,anchor),1)<>2 THEN RAISE EXCEPTION 'RATE_LIMIT_WAIT_READ_MISMATCH';END IF;
 EXECUTE replace(definition,anchor,replacement);
 END IF;
END $migration$;
COMMIT;
