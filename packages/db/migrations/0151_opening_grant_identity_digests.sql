-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE PR-E / §8 E3: equality-only HMAC facts, independent of erased accounts.
-- Keys and original identities never enter this database. No account FK, profiling or new ledger.
BEGIN;

CREATE TABLE IF NOT EXISTS public.opening_grant_identity_digests (
  purpose text NOT NULL DEFAULT 'opening_grant' CHECK (purpose = 'opening_grant'),
  kind text NOT NULL CHECK (kind IN ('email', 'oauth')),
  key_version text NOT NULL CHECK (key_version ~ '^[A-Za-z0-9_-]{1,32}$'),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  -- UTC month only: never retain the ledger timestamp as an identity linkage.
  first_granted_at timestamptz NOT NULL
    CHECK (first_granted_at = date_trunc('month', first_granted_at, 'UTC')),
  expires_when text NOT NULL DEFAULT 'opening_grant_rule_removed'
    CHECK (expires_when = 'opening_grant_rule_removed'),
  PRIMARY KEY (purpose, kind, key_version, digest)
);
ALTER TABLE public.opening_grant_identity_digests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.opening_grant_identity_digests FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.opening_grant_identity_digests TO service_role;
DROP POLICY IF EXISTS account_open_required ON public.opening_grant_identity_digests;
CREATE POLICY account_open_required ON public.opening_grant_identity_digests
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT (SELECT public.current_account_is_closed()))
  WITH CHECK (NOT (SELECT public.current_account_is_closed()));
COMMENT ON TABLE public.opening_grant_identity_digests IS
  'DATA-ERASURE E3: equality-only HMAC opening-grant facts; clear when this grant rule is removed; no original identity or account link';

-- Private helper, called only by the service-only entry points below. The profile lock precedes
-- ordered per-digest transaction locks in both entry points. Old/new key versions share locks.
CREATE OR REPLACE FUNCTION public.opening_grant_remember(
  p_profile_id uuid, p_digests jsonb, p_allow_grant boolean
) RETURNS boolean LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  item jsonb;
  lock_key text;
  first_grant timestamptz;
  prior_grant timestamptz;
  issued boolean := false;
  decided boolean;
  balance integer;
BEGIN
  IF p_digests IS NULL OR jsonb_typeof(p_digests) <> 'array' THEN
    RAISE EXCEPTION 'OPENING_GRANT_DIGEST_INVALID' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_digests) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'OPENING_GRANT_DIGEST_INVALID' USING ERRCODE = '22023';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_digests) LOOP
    IF jsonb_typeof(item) <> 'object'
      OR (item - ARRAY['kind', 'key_version', 'digest']) <> '{}'::jsonb
      OR coalesce(item->>'kind', '') NOT IN ('email', 'oauth')
      OR coalesce(item->>'key_version', '') !~ '^[A-Za-z0-9_-]{1,32}$'
      OR coalesce(item->>'digest', '') !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(item->'kind') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'key_version') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'digest') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'OPENING_GRANT_DIGEST_INVALID' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  -- Forgetting a retained version must fail closed instead of silently making old facts invisible.
  IF EXISTS (SELECT 1 FROM public.opening_grant_identity_digests d WHERE d.purpose = 'opening_grant'
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_digests) i WHERE i->>'key_version' = d.key_version)) THEN
    RAISE EXCEPTION 'OPENING_GRANT_KEY_VERSION_MISSING' USING ERRCODE = '22023';
  END IF;
  FOR lock_key IN SELECT DISTINCT 'opening_grant:' || (value->>'kind') || ':'
    || (value->>'key_version') || ':' || (value->>'digest')
    FROM jsonb_array_elements(p_digests) ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(lock_key, 0));
  END LOOP;

  -- The existing ledger is the authority for whether THIS account received an opening grant.
  SELECT min(created_at) INTO first_grant FROM public.credit_transactions
    WHERE user_id = p_profile_id AND idempotency_key = 'opening_grant:' || p_profile_id::text AND amount > 0;
  SELECT EXISTS (SELECT 1 FROM public.credit_transactions WHERE user_id = p_profile_id
    AND idempotency_key = 'opening_grant:' || p_profile_id::text) INTO decided;
  SELECT min(d.first_granted_at) INTO prior_grant
    FROM public.opening_grant_identity_digests d JOIN jsonb_array_elements(p_digests) i
      ON d.purpose = 'opening_grant' AND d.kind = i->>'kind'
      AND d.key_version = i->>'key_version' AND d.digest = i->>'digest';
  first_grant := least(first_grant, prior_grant);
  IF first_grant IS NULL AND p_allow_grant AND NOT decided THEN
    -- Existing monetary writer, same transaction; no change to purchases/refunds/settlement.
    PERFORM * FROM public.atomic_apply_credit_ledger_entry(p_profile_id, 100, 'addition',
      'Opening grant for new user profile bootstrap', 'opening_grant:' || p_profile_id::text);
    SELECT created_at INTO first_grant FROM public.credit_transactions
      WHERE user_id = p_profile_id AND idempotency_key = 'opening_grant:' || p_profile_id::text;
    IF first_grant IS NULL THEN RAISE EXCEPTION 'OPENING_GRANT_LEDGER_MISSING'; END IF;
    issued := true;
  END IF;
  IF p_allow_grant AND NOT issued AND NOT decided THEN
    -- A zero-value decision in the existing ledger prevents bootstrap recovery after an email
    -- change from turning a denied opening grant into a new grant. No balance is changed.
    SELECT credits INTO balance FROM public.profiles WHERE id = p_profile_id;
    INSERT INTO public.credit_transactions(user_id, amount, type, description, idempotency_key,
      balance_before, balance_after, ledger_type, reason_code, source_type)
    VALUES (p_profile_id, 0, 'addition', 'Opening grant already claimed by this identity',
      'opening_grant:' || p_profile_id::text, balance, balance, 'adjustment', 'opening_grant_ineligible', 'system');
  END IF;
  IF first_grant IS NOT NULL THEN
    INSERT INTO public.opening_grant_identity_digests(kind, key_version, digest, first_granted_at)
    SELECT DISTINCT i->>'kind', i->>'key_version', i->>'digest', date_trunc('month', first_grant, 'UTC')
    FROM jsonb_array_elements(p_digests) i ON CONFLICT DO NOTHING;
  END IF;
  RETURN issued;
END $$;
REVOKE ALL ON FUNCTION public.opening_grant_remember(uuid, jsonb, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.opening_grant_claim(p_profile_id uuid, p_digests jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p public.profiles;
BEGIN
  SELECT * INTO p FROM public.profiles WHERE id = p_profile_id FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'OPENING_GRANT_PROFILE_MISSING' USING ERRCODE = 'P0002'; END IF;
  IF p.status IS DISTINCT FROM 'active' OR p.is_deleted::text IS DISTINCT FROM 'false'
    OR EXISTS (SELECT 1 FROM public.account_erasure_requests WHERE profile_id = p_profile_id) THEN
    RAISE EXCEPTION 'ACCOUNT_CLOSED' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('granted', public.opening_grant_remember(p_profile_id, p_digests, true));
END $$;
REVOKE ALL ON FUNCTION public.opening_grant_claim(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.opening_grant_claim(uuid, jsonb) TO service_role;

-- Preserve the PR-A body and transaction. Digest failure rolls back the whole confirmation;
-- the old entry point is no longer callable by service_role, so a caller cannot omit this step.
CREATE OR REPLACE FUNCTION public.account_erasure_confirm_with_digests(
  p_profile_id uuid, p_request_id uuid, p_digests jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.profiles WHERE id = p_profile_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_ERASURE_PROFILE_MISSING' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.opening_grant_remember(p_profile_id, p_digests, false);
  RETURN public.account_erasure_confirm(p_profile_id, p_request_id);
END $$;
REVOKE ALL ON FUNCTION public.account_erasure_confirm_with_digests(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_erasure_confirm_with_digests(uuid, uuid, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.account_erasure_confirm(uuid, uuid) FROM service_role;

COMMIT;
