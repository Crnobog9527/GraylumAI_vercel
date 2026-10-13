-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAYWALL (MASTER_PLAN 2.1 item 51, record S): the opening grant for a new profile becomes 500 credits.
-- Only the fixed amount in 0151's private helper changes; the body below is otherwise 0151 verbatim:
-- profile lock, ordered per-digest locks, exact-ledger idempotency key, zero-value denial and digest
-- facts are untouched. Accounts that already have a decision (granted or denied) are not topped up and
-- no existing row is touched. Signature and privileges are unchanged, so old and new app code both work.
BEGIN;

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
  -- Seek one row per distinct version, never walk all identities for the all-versions-present case.
  IF EXISTS (WITH RECURSIVE retained_versions(key_version) AS (
    (SELECT key_version FROM public.opening_grant_identity_digests
      WHERE purpose = 'opening_grant' ORDER BY key_version LIMIT 1)
    UNION ALL
    SELECT next_version.key_version FROM retained_versions v CROSS JOIN LATERAL (
      SELECT key_version FROM public.opening_grant_identity_digests
      WHERE purpose = 'opening_grant' AND key_version > v.key_version ORDER BY key_version LIMIT 1
    ) next_version
  ) SELECT 1 FROM retained_versions v
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_digests) i
      WHERE i->>'key_version' = v.key_version)) THEN
    RAISE EXCEPTION 'OPENING_GRANT_KEY_VERSION_MISSING' USING ERRCODE = '22023';
  END IF;
  FOR lock_key IN SELECT DISTINCT 'opening_grant:' || (value->>'kind') || ':'
    || (value->>'key_version') || ':' || (value->>'digest')
    FROM jsonb_array_elements(p_digests) ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(lock_key, 0));
  END LOOP;

  -- The exact account ledger decision is authoritative, including a zero-value denial.
  -- Prefer its earliest positive grant; only accounts without one fall back to the decision time.
  SELECT coalesce(min(created_at) FILTER (WHERE amount > 0), min(created_at)), count(*) > 0
    INTO first_grant, decided FROM public.credit_transactions
    WHERE user_id = p_profile_id AND idempotency_key = 'opening_grant:' || p_profile_id::text;
  SELECT min(d.first_granted_at) INTO prior_grant
    FROM public.opening_grant_identity_digests d JOIN jsonb_array_elements(p_digests) i
      ON d.purpose = 'opening_grant' AND d.kind = i->>'kind'
      AND d.key_version = i->>'key_version' AND d.digest = i->>'digest';
  first_grant := least(first_grant, prior_grant);
  IF first_grant IS NULL AND p_allow_grant AND NOT decided THEN
    -- Existing monetary writer, same transaction; no change to purchases/refunds/settlement.
    PERFORM * FROM public.atomic_apply_credit_ledger_entry(p_profile_id, 500, 'addition',
      'Opening grant for new user profile bootstrap', 'opening_grant:' || p_profile_id::text);
    SELECT created_at INTO first_grant FROM public.credit_transactions
      WHERE user_id = p_profile_id AND idempotency_key = 'opening_grant:' || p_profile_id::text;
    IF first_grant IS NULL THEN RAISE EXCEPTION 'OPENING_GRANT_LEDGER_MISSING'; END IF;
    issued := true;
    decided := true;
  END IF;
  IF p_allow_grant AND NOT issued AND NOT decided THEN
    -- A zero-value decision in the existing ledger prevents bootstrap recovery after an email
    -- change from turning a denied opening grant into a new grant. No balance is changed.
    SELECT credits INTO balance FROM public.profiles WHERE id = p_profile_id;
    INSERT INTO public.credit_transactions(user_id, amount, type, description, idempotency_key,
      balance_before, balance_after, ledger_type, reason_code, source_type)
    VALUES (p_profile_id, 0, 'addition', 'Opening grant already claimed by this identity',
      'opening_grant:' || p_profile_id::text, balance, balance, 'adjustment', 'opening_grant_ineligible', 'system');
    decided := true;
  END IF;
  IF decided AND first_grant IS NOT NULL THEN
    INSERT INTO public.opening_grant_identity_digests(kind, key_version, digest, first_granted_at)
    SELECT DISTINCT i->>'kind', i->>'key_version', i->>'digest', date_trunc('month', first_grant, 'UTC')
    FROM jsonb_array_elements(p_digests) i ON CONFLICT DO NOTHING;
  END IF;
  RETURN issued;
END $$;
REVOKE ALL ON FUNCTION public.opening_grant_remember(uuid, jsonb, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
