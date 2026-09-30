-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- C8 (review P2, the #526 P1 pattern). Runs after erasure-b1a-cases.sql in a NEW session and
-- transaction: PL/pgSQL checks a called function's EXECUTE privilege only when an expression is
-- first initialised in a transaction, so no guard may have run as postgres before this role does.
-- A non-owner, non-superuser role must pass ordinary UPDATEs through the non-DEFINER guards (they
-- call erasure_update_allowed as that role), and every refusal must keep its own message.
-- UPDATE is granted to service_role only inside this rolled-back transaction.
BEGIN;
SELECT set_config('c8.project', (SELECT id::text FROM artifact_projects WHERE work_title = 'secret title n'), true),
  set_config('c8.round', (SELECT r.id::text FROM artifact_rounds r JOIN artifact_projects p ON p.id = r.project_id
    WHERE p.work_title = 'secret title n'), true),
  set_config('c8.live_round', (SELECT r.id::text FROM artifact_rounds r JOIN artifact_projects p ON p.id = r.project_id
    WHERE p.work_title = 'secret title o'), true);
GRANT SELECT, UPDATE ON artifact_projects, artifact_rounds, artifact_candidates TO service_role;
SET LOCAL ROLE service_role;
DO $$
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) OR current_user <> 'service_role'
    OR current_setting('c8.project', true) IS NULL OR current_setting('c8.round', true) IS NULL THEN
    RAISE EXCEPTION 'C8 needs the committed cases fixture and the non-superuser service_role';
  END IF;
  UPDATE artifact_projects SET work_title = 'renamed by service_role' WHERE id = current_setting('c8.project')::uuid;
  UPDATE artifact_rounds SET steps = '[{"body":"draft by service_role"}]' WHERE id = current_setting('c8.round')::uuid;
  BEGIN
    UPDATE artifact_candidates SET body = 'other' WHERE round_id = current_setting('c8.live_round')::uuid;
    RAISE EXCEPTION 'C8 immutable table accepted an update';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'artifact history immutable' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE artifact_projects SET work_title = NULL, erased_at = now(), module_id = gen_random_uuid()
    WHERE id = current_setting('c8.project')::uuid;
    RAISE EXCEPTION 'C8 erase outside the allow-list accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'erasure outside allow-list' THEN RAISE; END IF;
  END;
END $$;
RESET ROLE;
SELECT 'PASS C8 non-superuser role: ordinary updates pass; guard refusals keep their own errors';
ROLLBACK;
