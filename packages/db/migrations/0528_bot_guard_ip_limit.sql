-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- BOT-GUARD part 3 (Owner 2026-11-13: "24 小时内最多送 5 个号吧"): the opening grant's same-IP rule allows up to
-- system_settings.signup_gift_ip_limit grants per IP in 24 hours (1-50, default 5) instead of one, so family, office and
-- campus networks are not refused after the first account. Number 0528 assigned by the controller.
--   * signup_gift_settings: whole 0526 definition plus 'ip_limit' (lenient read like the cap: not digits or 0 -> 5, above 50 -> 50).
--   * opening_grant_remember: whole current definition; only the same-IP condition changes from "any grant from this IP
--     in 24 h" to "at least ip_limit grants". Locks (profile row, per-digest, the gift gate), the idempotency key, the
--     identity digests and the permanent zero-value refusal are unchanged. Signature and privileges unchanged.
--   * signup_gift_days gains refused_paused / refused_same_ip / refused_daily_cap, counted per Beijing day by
--     opening_grant_remember when it refuses (inside the gift gate's lock), so the admin card can show what was refused
--     without scanning the credit ledger. signup_gift_recent(p_days) reads them (service_role, admin card).
--   * opening_grant_claim: whole current definition; when it grants, the answer also carries today's count and cap
--     ("gift"), so the app can tell the Owner when the day's grants pass half and 90% of the cap. Old code reads only
--     "granted" and ignores the new key.
-- Compatibility: three columns added with defaults (no rewrite); old and new code both work. Repeatable: CREATE OR REPLACE only.
-- Recovery: re-apply the 0526 definitions of the three functions (packages/db/migrations/0526_bot_guard_signup.sql).
BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE public.signup_gift_days
  ADD COLUMN IF NOT EXISTS refused_paused integer NOT NULL DEFAULT 0 CHECK (refused_paused >= 0),
  ADD COLUMN IF NOT EXISTS refused_same_ip integer NOT NULL DEFAULT 0 CHECK (refused_same_ip >= 0),
  ADD COLUMN IF NOT EXISTS refused_daily_cap integer NOT NULL DEFAULT 0 CHECK (refused_daily_cap >= 0);

CREATE OR REPLACE FUNCTION public.signup_gift_settings()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT jsonb_build_object(
  'cap', coalesce((SELECT least((s.value #>> '{}')::bigint,100000)::int FROM system_settings s
   WHERE s.key='signup_gift_daily_cap' AND (s.value #>> '{}') ~ '^[0-9]{1,9}$'),30),
  'paused', coalesce((SELECT lower(s.value #>> '{}')='true' FROM system_settings s WHERE s.key='signup_gift_paused'),false),
  'ip_limit', coalesce((SELECT CASE WHEN (s.value #>> '{}') ~ '^[0-9]{1,4}$'
   THEN nullif(least(greatest((s.value #>> '{}')::int,0),50),0) END FROM system_settings s WHERE s.key='signup_gift_ip_limit'),5))
$function$;
REVOKE ALL ON FUNCTION public.signup_gift_settings() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.opening_grant_remember(p_profile_id uuid, p_digests jsonb, p_allow_grant boolean, p_ip inet DEFAULT NULL::inet)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  item jsonb;
  lock_key text;
  first_grant timestamptz;
  prior_grant timestamptz;
  issued boolean := false;
  decided boolean;
  balance integer;
  gift jsonb;
  refusal text;
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
    -- BOT-GUARD gift gate: one site-wide lock, taken last and only by a claim that is about to grant.
    -- Same IP: at most signup_gift_ip_limit grants per IP in 24 hours (0528, Owner 2026-11-13: 5).
    PERFORM pg_advisory_xact_lock(hashtextextended('opening_grant:gift_gate', 0));
    gift := public.signup_gift_settings();
    IF (gift->>'paused')::boolean THEN
      refusal := 'paused';
    ELSIF p_ip IS NOT NULL AND (SELECT count(*) FROM public.signup_gift_ips g
      WHERE g.ip = p_ip AND g.granted_at > now() - interval '24 hours') >= (gift->>'ip_limit')::int THEN
      refusal := 'same_ip';
    ELSIF coalesce((SELECT d.granted FROM public.signup_gift_days d WHERE d.day = public.signup_gift_day()), 0)
      >= (gift->>'cap')::int THEN
      refusal := 'daily_cap';
    END IF;
    IF refusal IS NOT NULL THEN
      -- Permanent: the zero-value decision below means this account is never granted later.
      SELECT credits INTO balance FROM public.profiles WHERE id = p_profile_id;
      INSERT INTO public.credit_transactions(user_id, amount, type, description, idempotency_key,
        balance_before, balance_after, ledger_type, reason_code, source_type, metadata)
      VALUES (p_profile_id, 0, 'addition', CASE refusal WHEN 'paused' THEN 'Opening grant refused: paused'
        WHEN 'same_ip' THEN 'Opening grant refused: same IP' ELSE 'Opening grant refused: daily cap' END,
        'opening_grant:' || p_profile_id::text, balance, balance, 'adjustment', 'opening_grant_ineligible', 'system',
        jsonb_build_object('refusal', refusal));
      INSERT INTO public.signup_gift_days(day, refused_paused, refused_same_ip, refused_daily_cap)
      VALUES (public.signup_gift_day(), (refusal = 'paused')::int, (refusal = 'same_ip')::int, (refusal = 'daily_cap')::int)
      ON CONFLICT (day) DO UPDATE SET refused_paused = public.signup_gift_days.refused_paused + excluded.refused_paused,
        refused_same_ip = public.signup_gift_days.refused_same_ip + excluded.refused_same_ip,
        refused_daily_cap = public.signup_gift_days.refused_daily_cap + excluded.refused_daily_cap;
      RETURN false;
    END IF;
    -- Existing monetary writer, same transaction; no change to purchases/refunds/settlement.
    PERFORM * FROM public.atomic_apply_credit_ledger_entry(p_profile_id, 500, 'addition',
      'Opening grant for new user profile bootstrap', 'opening_grant:' || p_profile_id::text);
    SELECT created_at INTO first_grant FROM public.credit_transactions
      WHERE user_id = p_profile_id AND idempotency_key = 'opening_grant:' || p_profile_id::text;
    IF first_grant IS NULL THEN RAISE EXCEPTION 'OPENING_GRANT_LEDGER_MISSING'; END IF;
    INSERT INTO public.signup_gift_days(day, granted) VALUES (public.signup_gift_day(), 1)
      ON CONFLICT (day) DO UPDATE SET granted = public.signup_gift_days.granted + 1;
    IF p_ip IS NOT NULL THEN
      INSERT INTO public.signup_gift_ips(ip) VALUES (p_ip);
      DELETE FROM public.signup_gift_ips g WHERE g.id IN (SELECT o.id FROM public.signup_gift_ips o
        WHERE o.granted_at < now() - interval '2 days' ORDER BY o.granted_at LIMIT 200);
    END IF;
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
END $function$;
REVOKE ALL ON FUNCTION public.opening_grant_remember(uuid, jsonb, boolean, inet)
  FROM PUBLIC, anon, authenticated, service_role;

-- The admin card: the last p_days Beijing days (1-31), newest first, with grants and refusals by reason.
CREATE OR REPLACE FUNCTION public.signup_gift_recent(p_days integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $function$
 SELECT coalesce(jsonb_agg(jsonb_build_object('day',d.day,'granted',coalesce(g.granted,0),
   'refused_paused',coalesce(g.refused_paused,0),'refused_same_ip',coalesce(g.refused_same_ip,0),
   'refused_daily_cap',coalesce(g.refused_daily_cap,0)) ORDER BY d.day DESC),'[]'::jsonb)
 FROM (SELECT (signup_gift_day() - i)::date AS day FROM generate_series(0, least(greatest(coalesce(p_days,7),1),31) - 1) i) d
 LEFT JOIN signup_gift_days g ON g.day = d.day
$function$;
REVOKE ALL ON FUNCTION public.signup_gift_recent(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.signup_gift_recent(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.opening_grant_claim(p_profile_id uuid, p_digests jsonb, p_ip inet DEFAULT NULL::inet)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE p public.profiles; v_granted boolean;
BEGIN
  SELECT * INTO p FROM public.profiles WHERE id = p_profile_id FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'OPENING_GRANT_PROFILE_MISSING' USING ERRCODE = 'P0002'; END IF;
  IF p.status IS DISTINCT FROM 'active' OR p.is_deleted::text IS DISTINCT FROM 'false'
    OR EXISTS (SELECT 1 FROM public.account_erasure_requests WHERE profile_id = p_profile_id) THEN
    RAISE EXCEPTION 'ACCOUNT_CLOSED' USING ERRCODE = '42501';
  END IF;
  v_granted := public.opening_grant_remember(p_profile_id, p_digests, true, p_ip);
  IF NOT v_granted THEN RETURN jsonb_build_object('granted', false); END IF;
  -- BOT-GUARD: today's count after this grant, for the Owner's half / 90% alert (read inside the gift gate's lock).
  RETURN jsonb_build_object('granted', true, 'gift', public.signup_gift_today() - 'paused' - 'ip_limit');
END $function$;
REVOKE ALL ON FUNCTION public.opening_grant_claim(uuid, jsonb, inet) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.opening_grant_claim(uuid, jsonb, inet) TO service_role;

COMMIT;
