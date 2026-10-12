-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- AGENT-CORE R10 (D5): data-use consent state, grant/revoke, and the single server-side filter for
-- team-improvement reads. Number 0212 is provisional until the controller assigns it. No remote application.
-- Scope (Owner decision 2 in AGENT_CORE_CLOSEOUT.md): no de-identification and no case view here; those
-- belong to LEARN-1. A user's own reads of conversations and results never consult this table.
BEGIN;

-- New table: no existing table records D5 consent (0114 is topic adoption, not data use).
-- One row per grant; revocation stamps the same row. No body text and no copy of user records,
-- so the audit can outlive account erasure for one year (DATA-ERASURE §7, E6).
CREATE TABLE IF NOT EXISTS public.data_use_consents(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 -- profiles rows are never physically deleted (0147 keeps the closed-account placeholder).
 profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
 purpose text NOT NULL CHECK(purpose='team_improvement'),
 version text NOT NULL CHECK(version ~ '^[a-z0-9-]{1,64}$'),
 granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_at timestamptz,
 revoke_reason text CHECK(revoke_reason IN ('user','account_erasure','superseded')),
 CHECK((revoked_at IS NULL)=(revoke_reason IS NULL)),
 CHECK(revoked_at IS NULL OR revoked_at>=granted_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS data_use_consents_active
 ON public.data_use_consents(profile_id,purpose) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS data_use_consents_revoked
 ON public.data_use_consents(revoked_at) WHERE revoked_at IS NOT NULL;
ALTER TABLE public.data_use_consents ENABLE ROW LEVEL SECURITY;
-- No client or service_role table access: every read and write goes through the functions below.
REVOKE ALL ON public.data_use_consents FROM PUBLIC,anon,authenticated,service_role;

-- Changing the purpose or wording means a new version; older grants then stop counting (D5).
CREATE OR REPLACE FUNCTION public.data_use_consent_current_version() RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$ SELECT 'd5-v1'::text $$;

-- Audit rows: only revocation may change, once; deletion only after the one-year retention.
CREATE OR REPLACE FUNCTION public.data_use_consent_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.revoked_at IS NULL OR OLD.revoked_at>clock_timestamp()-interval '1 year' THEN
   RAISE EXCEPTION 'DATA_USE_CONSENT_RETAINED' USING ERRCODE='42501';
  END IF;
  RETURN OLD;
 END IF;
 IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
  OR (NEW.id,NEW.profile_id,NEW.purpose,NEW.version,NEW.granted_at)
   IS DISTINCT FROM (OLD.id,OLD.profile_id,OLD.purpose,OLD.version,OLD.granted_at)
 THEN RAISE EXCEPTION 'DATA_USE_CONSENT_IMMUTABLE' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS data_use_consent_guard ON public.data_use_consents;
CREATE TRIGGER data_use_consent_guard BEFORE UPDATE OR DELETE ON public.data_use_consents
 FOR EACH ROW EXECUTE FUNCTION public.data_use_consent_guard();

-- The single team-improvement gate: current-version grant, not revoked, account not closed.
-- Every future team read (LEARN-1 case view, exports, admin analysis of records) must pass through it.
CREATE OR REPLACE FUNCTION public.data_use_team_allowed(a uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM data_use_consents c JOIN profiles p ON p.id=c.profile_id
  WHERE c.profile_id=a AND c.purpose='team_improvement' AND c.revoked_at IS NULL
   AND c.version=data_use_consent_current_version()
   AND p.status='active' AND p.is_deleted::text='false'
   AND NOT EXISTS(SELECT 1 FROM account_erasure_requests e WHERE e.profile_id=a))
$$;
CREATE OR REPLACE FUNCTION public.data_use_team_readable(p_profile_ids uuid[]) RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_profile_ids IS NULL OR cardinality(p_profile_ids)>1000 THEN
  RAISE EXCEPTION 'DATA_USE_FILTER_INVALID' USING ERRCODE='22023';
 END IF;
 RETURN QUERY SELECT DISTINCT x FROM unnest(p_profile_ids) x WHERE x IS NOT NULL AND data_use_team_allowed(x);
END $$;

CREATE OR REPLACE FUNCTION public.data_use_consent_state(a uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('purpose','team_improvement','currentVersion',data_use_consent_current_version(),
  'granted',data_use_team_allowed(a),
  'version',latest.version,'grantedAt',latest.granted_at,'revokedAt',latest.revoked_at)
 FROM (SELECT 1) one LEFT JOIN LATERAL (SELECT version,granted_at,revoked_at FROM data_use_consents
  WHERE profile_id=a AND purpose='team_improvement' ORDER BY granted_at DESC,id DESC LIMIT 1) latest ON true
$$;

-- Grant needs the version the user was shown; revoke always succeeds and is idempotent.
-- The profile row lock serializes with account_erasure_confirm, which locks the same row first.
CREATE OR REPLACE FUNCTION public.data_use_consent_set(a uuid,p_granted boolean,p_version text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p profiles;cur data_use_consents;
BEGIN
 IF a IS NULL OR p_granted IS NULL THEN RAISE EXCEPTION 'DATA_USE_CONSENT_INVALID' USING ERRCODE='22023';END IF;
 SELECT * INTO p FROM profiles WHERE id=a FOR UPDATE;
 IF p.id IS NULL THEN RAISE EXCEPTION 'DATA_USE_PROFILE_MISSING' USING ERRCODE='P0002';END IF;
 SELECT * INTO cur FROM data_use_consents WHERE profile_id=a AND purpose='team_improvement' AND revoked_at IS NULL;
 IF NOT p_granted THEN
  UPDATE data_use_consents SET revoked_at=clock_timestamp(),revoke_reason='user' WHERE id=cur.id;
  RETURN data_use_consent_state(a);
 END IF;
 IF EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=a)
  OR p.status IS DISTINCT FROM 'active' OR p.is_deleted::text IS DISTINCT FROM 'false'
 THEN RAISE EXCEPTION 'DATA_USE_ACCOUNT_CLOSED' USING ERRCODE='42501';END IF;
 IF p_version IS DISTINCT FROM data_use_consent_current_version() THEN
  RAISE EXCEPTION 'DATA_USE_VERSION_STALE' USING ERRCODE='PT409';
 END IF;
 IF cur.id IS NOT NULL AND cur.version=p_version THEN RETURN data_use_consent_state(a);END IF;
 UPDATE data_use_consents SET revoked_at=clock_timestamp(),revoke_reason='superseded' WHERE id=cur.id;
 INSERT INTO data_use_consents(profile_id,purpose,version) VALUES(a,'team_improvement',p_version);
 RETURN data_use_consent_state(a);
END $$;

-- Account erasure is a revocation, in the same transaction that closes the account.
CREATE OR REPLACE FUNCTION public.data_use_consent_erasure_revoke() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE data_use_consents SET revoked_at=clock_timestamp(),revoke_reason='account_erasure'
 WHERE profile_id=NEW.profile_id AND revoked_at IS NULL;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS data_use_consent_erasure_revoke ON public.account_erasure_requests;
CREATE TRIGGER data_use_consent_erasure_revoke AFTER INSERT ON public.account_erasure_requests
 FOR EACH ROW EXECUTE FUNCTION public.data_use_consent_erasure_revoke();

-- Called by the daily account-erasure job: audit rows leave one year after revocation.
CREATE OR REPLACE FUNCTION public.data_use_consent_expire() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
 DELETE FROM data_use_consents WHERE revoked_at<=clock_timestamp()-interval '1 year';
 GET DIAGNOSTICS n=ROW_COUNT;RETURN n;
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('data_use_consent_current_version','data_use_consent_guard',
   'data_use_team_allowed','data_use_team_readable','data_use_consent_state','data_use_consent_set',
   'data_use_consent_erasure_revoke','data_use_consent_expire') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  IF split_part(f::text,'(',1) IN ('data_use_team_allowed','data_use_team_readable','data_use_consent_state',
   'data_use_consent_set','data_use_consent_expire') THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);END IF;
 END LOOP;
END $$;
COMMIT;
