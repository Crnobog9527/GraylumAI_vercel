-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- ADMIN-SECRETS OR-1 (0283, allocated by the controller 2026-10-18): move the OpenRouter key from ai_models.api_key into the platform `openrouter` Vault slot
-- (docs/launch/tasks/ADMIN-SECRETS.md 5.3). The application reads it from there from now on; the column stays until
-- OR-2 but is no longer read or written by the application.
--   * Only when the slot was never configured. Already filled (by an earlier run or by an admin), or cleared by an admin
--     (revision > 0): nothing happens, so a re-run can never restore a deliberately revoked key.
--   * The non-empty, trimmed api_key values must be exactly one value. None: nothing happens (production may have
--     none; the Owner fills the slot in the admin). Two or more: stop, the Owner decides which key to keep.
--   * The value never leaves the database: it goes straight into vault.create_secret, like platform_secret_set
--     (which needs an admin actor and is therefore not used here). Errors carry codes only.
--   * Same key, same fingerprint: test windows quote 'openrouter-key:' || sha256(key), so existing windows and
--     recovery keep working.
--   * Audit: one platform_secret_migrate row in user_activity_logs (admin_id NULL; slot, last 4, revision).
-- Rollback (not run by this migration): packages/db/tests/admin-secrets-or1-rollback.sql writes the CURRENT Vault
-- value back into every OpenRouter model row, so reverting the code works even after the key was replaced.
BEGIN;
SET LOCAL lock_timeout='5s';

DO $$
DECLARE distinct_keys integer; v text; sid uuid; r platform_secrets;
BEGIN
 PERFORM pg_advisory_xact_lock(259,hashtext('openrouter'));
 SELECT * INTO r FROM platform_secrets WHERE slot='openrouter' FOR UPDATE;
 -- Only a slot that was never configured (no row, or revision 0). A filled slot stays; a slot an admin cleared (revision > 0,
 -- no secret) stays cleared: re-running this migration must never put a deliberately revoked legacy key back.
 IF r.vault_secret_id IS NOT NULL OR coalesce(r.revision,0)>0 THEN RETURN; END IF;
 SELECT count(DISTINCT btrim(api_key)) INTO distinct_keys FROM ai_models WHERE btrim(coalesce(api_key,''))<>'';
 IF distinct_keys=0 THEN RETURN; END IF;
 IF distinct_keys>1 THEN RAISE EXCEPTION 'OPENROUTER_KEY_MIGRATION_AMBIGUOUS' USING ERRCODE='23514'; END IF;
 SELECT DISTINCT btrim(api_key) INTO STRICT v FROM ai_models WHERE btrim(coalesce(api_key,''))<>'';
 -- The same value rules platform_secret_set enforces.
 IF char_length(v)<16 OR char_length(v)>1024 OR v !~ '^[!-~]+$' THEN
  RAISE EXCEPTION 'OPENROUTER_KEY_MIGRATION_INVALID' USING ERRCODE='23514'; END IF;
 IF to_regclass('vault.secrets') IS NULL OR to_regclass('vault.decrypted_secrets') IS NULL THEN
  RAISE EXCEPTION 'PLATFORM_SECRET_VAULT_MISSING' USING ERRCODE='55000'; END IF;
 DELETE FROM vault.secrets WHERE name='graylum.platform.openrouter';
 sid:=vault.create_secret(v,'graylum.platform.openrouter','Graylum platform secret (openrouter)');
 INSERT INTO platform_secrets(slot,vault_secret_id,last4,revision,updated_by,updated_at)
 VALUES('openrouter',sid,right(v,4),coalesce(r.revision,0)+1,NULL,now())
 ON CONFLICT(slot) DO UPDATE SET vault_secret_id=excluded.vault_secret_id,last4=excluded.last4,
  revision=excluded.revision,updated_by=NULL,updated_at=excluded.updated_at;
 INSERT INTO user_activity_logs(admin_id,action,action_type,details)
 VALUES(NULL,'platform_secret_migrate','settings',jsonb_build_object('slot','openrouter','last4',right(v,4),
  'previousLast4',NULL,'revision',coalesce(r.revision,0)+1,'previousRevision',coalesce(r.revision,0),'source','ai_models.api_key'));
END $$;

COMMIT;
