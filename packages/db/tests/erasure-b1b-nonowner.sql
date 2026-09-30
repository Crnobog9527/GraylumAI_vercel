-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- C8: NEW connection and transaction after cases; never initialise guards as postgres first.
-- Temporary UPDATE grants probe trigger permissions, and roll back at the end.
BEGIN;
DO $$ BEGIN
  PERFORM set_config('b1b.closed',(SELECT id::text FROM profiles WHERE nickname='b1b-closed'),true);
  PERFORM set_config('b1b.open',(SELECT id::text FROM profiles WHERE nickname='b1b-open'),true);
  PERFORM set_config('b1b.conv',(SELECT id::text FROM conversations WHERE title='b1b-o_conv'),true);
END $$;
GRANT SELECT,UPDATE ON runtime_sessions,runtime_executions,runtime_history_dependencies,runtime_scope_material,messages TO service_role;
SET LOCAL ROLE service_role;
DO $$ BEGIN
  IF current_user <> 'service_role' OR (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
    RAISE EXCEPTION 'B1b C8 requires a non-owner, non-superuser service_role'; END IF;
  -- Both empty and non-empty allow-lists execute as the non-owner for the first time here.
  IF erasure_update_allowed('{"erased_at":null}', '{"erased_at":"fixture"}', NULL) THEN
    RAISE EXCEPTION 'B1b C8 NULL allow-list accepted'; END IF;
  BEGIN
    UPDATE runtime_history_dependencies SET dependency_id=execution_id,erased_at=now();
    RAISE EXCEPTION 'B1b C8 empty allow-list changed an identity key';
  EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'erasure outside allow-list' THEN RAISE; END IF; END;
  UPDATE runtime_history_dependencies SET erased_at=now();
  UPDATE runtime_scope_material m SET request=NULL,content=NULL,content_hash=NULL,erased_at=now()
    FROM runtime_sessions s WHERE s.id=m.session_id AND s.actor_id=current_setting('b1b.closed')::uuid;
  UPDATE messages m SET content=NULL,erased_at=now() FROM conversations c
    WHERE c.id=m.conversation_id AND c.user_id=current_setting('b1b.closed')::uuid AND c.skill_mode;
  IF NOT FOUND THEN RAISE EXCEPTION 'B1b C8 skill fixture missing'; END IF;
  BEGIN
    UPDATE runtime_history_dependencies SET erased_at=NULL WHERE erased_at IS NOT NULL;
    RAISE EXCEPTION 'B1b C8 marker backfill accepted';
  EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'erased row is immutable' THEN RAISE; END IF; END;
  BEGIN
    UPDATE runtime_sessions SET scope=NULL,start_payload=NULL,erased_at=now(),revision=revision+1;
    RAISE EXCEPTION 'B1b C8 non-whitelist update accepted';
  EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'erasure outside allow-list' THEN RAISE; END IF; END;
  BEGIN
    DELETE FROM runtime_executions;
    RAISE EXCEPTION 'B1b C8 protected table DELETE accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM<>'permission denied for table runtime_executions' THEN RAISE; END IF;
  END;
END $$;
RESET ROLE;
SELECT 'PASS B1b C8 fresh service-role session: marker/skill erase, guard errors, protected DELETE';
ROLLBACK;
