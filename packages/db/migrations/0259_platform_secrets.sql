-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- ADMIN-SECRETS: business third-party keys (OpenRouter, Post for Me API key and webhook secret, TikHub,
-- Parallel, Firecrawl)
-- entered in the admin, encrypted in Supabase Vault, write-only for the browser.
-- Allocation: controller 2026-10-14 (0259). Plan: docs/launch/tasks/ADMIN-SECRETS.md.
--   * platform_secrets keeps only metadata (last 4 characters, revision, who, when); the value
--     lives in vault.secrets, encrypted with a key Supabase keeps outside the database.
--   * Every function is SECURITY DEFINER, owned by postgres and callable by service_role only.
--     Only platform_secret_read returns the value; the admin API never calls it.
--   * Writers require an active, non-deleted admin actor and the current revision (PT409 otherwise),
--     and audit to user_activity_logs with the slot and last 4 characters, never the value or a hash.
--   * Errors carry codes only; no argument is ever formatted into a message.
--   * This migration does not create the extension (the platform ships supabase_vault). Without it
--     the functions raise PLATFORM_SECRET_VAULT_MISSING instead of storing anything in clear.
-- Not user data: these keys are platform configuration and are outside account erasure; updated_by
-- has no foreign key so it never blocks erasing an admin account.
-- Recovery: forward only. To withdraw the feature, postgres revokes EXECUTE from service_role; the
-- table holds no secret values, and vault entries named graylum.platform.* can be deleted by postgres.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE IF NOT EXISTS public.platform_secrets(
 slot text PRIMARY KEY CHECK (slot IN ('openrouter','postforme','postforme_webhook','tikhub','parallel','firecrawl')),
 vault_secret_id uuid,
 last4 text CHECK (last4 IS NULL OR char_length(last4)=4),
 revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0),
 updated_by uuid,
 updated_at timestamptz,
 CHECK ((vault_secret_id IS NULL)=(last4 IS NULL))
);
ALTER TABLE public.platform_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_secrets FROM PUBLIC,anon,authenticated,service_role;

-- Shared input and environment checks. Codes only: 23514 bad input, 42501 actor, 55000 no vault.
CREATE OR REPLACE FUNCTION public.platform_secret_check(p_slot text,p_actor uuid,p_revision bigint)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_slot IS NULL OR p_slot NOT IN ('openrouter','postforme','postforme_webhook','tikhub','parallel','firecrawl')
  OR p_actor IS NULL OR p_revision IS NULL OR p_revision<0 OR p_revision>=9999999999
 THEN RAISE EXCEPTION 'PLATFORM_SECRET_INPUT_INVALID' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor AND role='admin'
  AND status='active' AND is_deleted::text='false')
 THEN RAISE EXCEPTION 'PLATFORM_SECRET_ACTOR_DENIED' USING ERRCODE='42501';END IF;
 IF to_regclass('vault.secrets') IS NULL OR to_regclass('vault.decrypted_secrets') IS NULL
 THEN RAISE EXCEPTION 'PLATFORM_SECRET_VAULT_MISSING' USING ERRCODE='55000';END IF;
END $$;

CREATE OR REPLACE FUNCTION public.platform_secret_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_agg(jsonb_build_object('slot',s.slot,'configured',p.last4 IS NOT NULL,'last4',p.last4,
  'revision',coalesce(p.revision,0),'updatedBy',p.updated_by,
  'updatedAt',to_char(p.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY s.n)
 FROM unnest(ARRAY['openrouter','postforme','postforme_webhook','tikhub','parallel','firecrawl']) WITH ORDINALITY s(slot,n)
 LEFT JOIN platform_secrets p ON p.slot=s.slot
$$;

CREATE OR REPLACE FUNCTION public.platform_secret_set(
 p_slot text,p_value text,p_expected_revision bigint,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r platform_secrets;sid uuid;l4 text;
BEGIN
 -- Printable ASCII without spaces, 16-1024 characters: every supported provider key fits.
 IF p_value IS NULL OR char_length(p_value)<16 OR char_length(p_value)>1024 OR p_value !~ '^[!-~]+$'
 THEN RAISE EXCEPTION 'PLATFORM_SECRET_INPUT_INVALID' USING ERRCODE='23514';END IF;
 PERFORM platform_secret_check(p_slot,p_actor,p_expected_revision);
 PERFORM pg_advisory_xact_lock(259,hashtext(p_slot));
 INSERT INTO platform_secrets(slot) VALUES(p_slot) ON CONFLICT(slot) DO NOTHING;
 SELECT * INTO STRICT r FROM platform_secrets WHERE slot=p_slot FOR UPDATE;
 IF r.revision<>p_expected_revision THEN
  RAISE EXCEPTION 'PLATFORM_SECRET_VERSION_CONFLICT' USING ERRCODE='PT409';END IF;
 l4:=right(p_value,4);
 IF r.vault_secret_id IS NOT NULL AND EXISTS(SELECT 1 FROM vault.secrets WHERE id=r.vault_secret_id) THEN
  PERFORM vault.update_secret(r.vault_secret_id,p_value);
  sid:=r.vault_secret_id;
 ELSE
  -- A leftover entry under our name (e.g. removed metadata) is replaced, never reused blindly.
  DELETE FROM vault.secrets WHERE name='graylum.platform.'||p_slot;
  sid:=vault.create_secret(p_value,'graylum.platform.'||p_slot,'Graylum platform secret ('||p_slot||')');
 END IF;
 UPDATE platform_secrets SET vault_secret_id=sid,last4=l4,revision=r.revision+1,
  updated_by=p_actor,updated_at=now() WHERE slot=p_slot;
 INSERT INTO user_activity_logs(admin_id,action,action_type,details)
 VALUES(p_actor,CASE WHEN r.last4 IS NULL THEN 'platform_secret_set' ELSE 'platform_secret_replace' END,
  'settings',jsonb_build_object('slot',p_slot,'last4',l4,'previousLast4',r.last4,
  'revision',r.revision+1,'previousRevision',r.revision));
 RETURN platform_secret_status();
END $$;

CREATE OR REPLACE FUNCTION public.platform_secret_clear(
 p_slot text,p_expected_revision bigint,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r platform_secrets;
BEGIN
 PERFORM platform_secret_check(p_slot,p_actor,p_expected_revision);
 PERFORM pg_advisory_xact_lock(259,hashtext(p_slot));
 SELECT * INTO r FROM platform_secrets WHERE slot=p_slot FOR UPDATE;
 -- Clearing a slot that holds nothing is an idempotent no-op without an audit row.
 IF NOT FOUND OR r.last4 IS NULL THEN RETURN platform_secret_status();END IF;
 IF r.revision<>p_expected_revision THEN
  RAISE EXCEPTION 'PLATFORM_SECRET_VERSION_CONFLICT' USING ERRCODE='PT409';END IF;
 DELETE FROM vault.secrets WHERE id=r.vault_secret_id;
 UPDATE platform_secrets SET vault_secret_id=NULL,last4=NULL,revision=r.revision+1,
  updated_by=p_actor,updated_at=now() WHERE slot=p_slot;
 INSERT INTO user_activity_logs(admin_id,action,action_type,details)
 VALUES(p_actor,'platform_secret_clear','settings',jsonb_build_object('slot',p_slot,'last4',NULL,
  'previousLast4',r.last4,'revision',r.revision+1,'previousRevision',r.revision));
 RETURN platform_secret_status();
END $$;

-- The only path that returns a value. NULL means "not configured"; a dangling reference fails.
CREATE OR REPLACE FUNCTION public.platform_secret_read(p_slot text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE sid uuid;v text;
BEGIN
 IF p_slot IS NULL OR p_slot NOT IN ('openrouter','postforme','postforme_webhook','tikhub','parallel','firecrawl')
 THEN RAISE EXCEPTION 'PLATFORM_SECRET_INPUT_INVALID' USING ERRCODE='23514';END IF;
 SELECT vault_secret_id INTO sid FROM platform_secrets WHERE slot=p_slot;
 IF sid IS NULL THEN RETURN NULL;END IF;
 IF to_regclass('vault.decrypted_secrets') IS NULL
 THEN RAISE EXCEPTION 'PLATFORM_SECRET_VAULT_MISSING' USING ERRCODE='55000';END IF;
 SELECT decrypted_secret INTO v FROM vault.decrypted_secrets WHERE id=sid;
 IF v IS NULL THEN RAISE EXCEPTION 'PLATFORM_SECRET_VAULT_ENTRY_MISSING' USING ERRCODE='55000';END IF;
 RETURN v;
END $$;

ALTER FUNCTION public.platform_secret_check(text,uuid,bigint) OWNER TO postgres;
ALTER FUNCTION public.platform_secret_status() OWNER TO postgres;
ALTER FUNCTION public.platform_secret_set(text,text,bigint,uuid) OWNER TO postgres;
ALTER FUNCTION public.platform_secret_clear(text,bigint,uuid) OWNER TO postgres;
ALTER FUNCTION public.platform_secret_read(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_secret_check(text,uuid,bigint),public.platform_secret_status(),
 public.platform_secret_set(text,text,bigint,uuid),public.platform_secret_clear(text,bigint,uuid),
 public.platform_secret_read(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.platform_secret_status(),public.platform_secret_set(text,text,bigint,uuid),
 public.platform_secret_clear(text,bigint,uuid),public.platform_secret_read(text) TO service_role;
COMMIT;
