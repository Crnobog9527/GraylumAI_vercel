-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- BOT-GUARD (Owner 2026-11-13, Master Plan 2.1): the visible hCaptcha goes; the defences move to what abuse is after, the
-- opening grant (500 credits) and SMS. Number 0526 assigned by the controller.
--   * Opening grant, three refusals (opening_grant_remember, the private helper of opening_grant_claim):
--     - paused: system_settings.signup_gift_paused = true, nobody new gets the grant;
--     - same_ip: the visitor's IP already received a grant in the last 24 hours (signup_gift_ips, IP only, kept 2 days);
--     - daily_cap: system_settings.signup_gift_daily_cap grants per Beijing calendar day (0-100000, default 30, 0 = none),
--       counted in signup_gift_days.
--     A refusal is the existing zero-value decision row on 'opening_grant:<profile>' (reason_code opening_grant_ineligible,
--     metadata.refusal = paused | same_ip | daily_cap), so it is permanent: later sign-ins, a raised cap or an unpaused
--     switch never top the account up. Only a claim that is about to grant takes the site-wide transaction lock
--     'opening_grant:gift_gate', after the profile row lock and the per-digest locks (same order on every path), so
--     concurrent sign-ups cannot pass the cap together. Replayed claims (decision row present) and the Waffo path
--     (p_allow_grant = false) never reach the gate.
--   * Sign-up registration (signup_requests, Before User Created hook): the site's /api/auth/signup/request records the
--     sha256 of the normalised email (trim + lower) and the visitor's IP before the browser calls supabase.auth.signUp;
--     5 per IP per hour, 20 per IP per day. hook_before_user_created(event) refuses an email sign-up (403) without such a
--     record from the last 10 minutes, so calling /auth/v1/signup directly with the publishable key creates nothing.
--     Phone sign-ups are already gated by the Send SMS hook (no code without our own sms_sends request, migration 0511);
--     Google and other providers pass (the provider checked the person). Users created with auth.admin are not sent
--     through the hook. RLS on, no policy; only the functions touch the tables.
-- Compatibility: additive for data. opening_grant_claim and opening_grant_remember gain a trailing p_ip inet DEFAULT NULL
--   (dropped and recreated in this transaction, same privileges), so old code calling claim with two arguments and the
--   Waffo function calling remember with three keep working; without an IP only the same-IP rule is skipped. The hook
--   does nothing until it is enabled in Supabase (Authentication > Auth Hooks), which must wait for code that calls the
--   registration endpoint.
-- Repeatable: IF NOT EXISTS / DROP ... IF EXISTS / CREATE OR REPLACE throughout; running it twice changes nothing.
-- Recovery: disable the hook in Supabase first (instant). To withdraw the grant gate, set signup_gift_daily_cap high and
--   signup_gift_paused false, or re-apply the 0230 definitions of opening_grant_remember(uuid,jsonb,boolean) and
--   opening_grant_claim(uuid,jsonb) after dropping the p_ip versions. The tables hold disposable rate-limit rows.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE IF NOT EXISTS public.signup_requests(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 email_key text NOT NULL CHECK (email_key ~ '^[0-9a-f]{64}$'),
 ip inet,
 requested_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signup_requests_email_key_requested_at_idx ON public.signup_requests(email_key,requested_at DESC);
CREATE INDEX IF NOT EXISTS signup_requests_ip_requested_at_idx ON public.signup_requests(ip,requested_at DESC) WHERE ip IS NOT NULL;
CREATE INDEX IF NOT EXISTS signup_requests_requested_at_idx ON public.signup_requests(requested_at);
ALTER TABLE public.signup_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.signup_requests FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE IF NOT EXISTS public.signup_gift_days(
 day date PRIMARY KEY,
 granted integer NOT NULL DEFAULT 0 CHECK (granted >= 0)
);
ALTER TABLE public.signup_gift_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.signup_gift_days FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE IF NOT EXISTS public.signup_gift_ips(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 ip inet NOT NULL,
 granted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signup_gift_ips_ip_granted_at_idx ON public.signup_gift_ips(ip,granted_at DESC);
CREATE INDEX IF NOT EXISTS signup_gift_ips_granted_at_idx ON public.signup_gift_ips(granted_at);
ALTER TABLE public.signup_gift_ips ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.signup_gift_ips FROM PUBLIC,anon,authenticated,service_role;

-- The two admin settings, read leniently: a value stored as JSON number/boolean or as text both work; anything else
-- falls back to the default (cap 30, not paused).
CREATE OR REPLACE FUNCTION public.signup_gift_settings() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object(
  'cap', coalesce((SELECT least((s.value #>> '{}')::bigint,100000)::int FROM system_settings s
   WHERE s.key='signup_gift_daily_cap' AND (s.value #>> '{}') ~ '^[0-9]{1,9}$'),30),
  'paused', coalesce((SELECT lower(s.value #>> '{}')='true' FROM system_settings s WHERE s.key='signup_gift_paused'),false))
$$;
REVOKE ALL ON FUNCTION public.signup_gift_settings() FROM PUBLIC,anon,authenticated,service_role;

-- The Beijing calendar day the cap counts in.
CREATE OR REPLACE FUNCTION public.signup_gift_day() RETURNS date
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$ SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date $$;
REVOKE ALL ON FUNCTION public.signup_gift_day() FROM PUBLIC,anon,authenticated,service_role;

-- For the admin settings page: today's count and the settings in force.
CREATE OR REPLACE FUNCTION public.signup_gift_today() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT signup_gift_settings() || jsonb_build_object('day',signup_gift_day(),
  'granted',coalesce((SELECT d.granted FROM signup_gift_days d WHERE d.day=signup_gift_day()),0))
$$;
REVOKE ALL ON FUNCTION public.signup_gift_today() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.signup_gift_today() TO service_role;

-- The registration endpoint, before the browser calls supabase.auth.signUp. Answers a status word instead of raising.
-- A transaction-level advisory lock per IP makes concurrent calls from one IP queue, so two cannot both pass a count.
CREATE OR REPLACE FUNCTION public.signup_request(p_email_key text,p_ip inet) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_email_key IS NULL OR p_email_key !~ '^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION 'SIGNUP_EMAIL_KEY_INVALID' USING ERRCODE='22023';
 END IF;
 IF p_ip IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('signup:ip:'||host(p_ip),0));
  IF (SELECT count(*) FROM signup_requests r WHERE r.ip=p_ip AND r.requested_at>now()-interval '1 hour')>=5 THEN
   RETURN 'ip_hourly';
  END IF;
  IF (SELECT count(*) FROM signup_requests r WHERE r.ip=p_ip AND r.requested_at>now()-interval '24 hours')>=20 THEN
   RETURN 'ip_daily';
  END IF;
 END IF;
 INSERT INTO signup_requests(email_key,ip) VALUES(p_email_key,p_ip);
 DELETE FROM signup_requests r WHERE r.id IN (SELECT o.id FROM signup_requests o WHERE o.requested_at<now()-interval '2 days'
  ORDER BY o.requested_at LIMIT 200);
 RETURN 'ok';
END $$;
REVOKE ALL ON FUNCTION public.signup_request(text,inet) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.signup_request(text,inet) TO service_role;

-- Supabase Auth "Before User Created" hook (Postgres). Returns {} to allow, {error:{http_code,message}} to refuse.
CREATE OR REPLACE FUNCTION public.hook_before_user_created(event jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 v_user jsonb:=coalesce(event->'user','{}'::jsonb);
 v_provider text:=coalesce(v_user->'app_metadata'->>'provider','');
 v_email text:=lower(btrim(coalesce(v_user->>'email','')));
 v_phone text:=coalesce(v_user->>'phone','');
BEGIN
 -- Email/password sign-up (also a provider-less user with an email and no phone): only after our own registration.
 IF v_provider='email' OR (v_provider='' AND v_email<>'' AND v_phone='') THEN
  IF v_email='' OR NOT EXISTS(SELECT 1 FROM signup_requests r
   WHERE r.email_key=encode(sha256(convert_to(v_email,'UTF8')),'hex') AND r.requested_at>now()-interval '10 minutes') THEN
   RETURN jsonb_build_object('error',jsonb_build_object('http_code',403,'message','Please sign up on the website.'));
  END IF;
 END IF;
 -- Phone: the Send SMS hook already requires our own sms_sends request. Google and others: the provider checked.
 RETURN '{}'::jsonb;
END $$;
REVOKE ALL ON FUNCTION public.hook_before_user_created(jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.hook_before_user_created(jsonb) TO supabase_auth_admin;

-- opening_grant_remember: whole 0230 definition plus the trailing p_ip and the gift gate in the grant branch.
DROP FUNCTION IF EXISTS public.opening_grant_remember(uuid,jsonb,boolean);
CREATE OR REPLACE FUNCTION public.opening_grant_remember(p_profile_id uuid, p_digests jsonb, p_allow_grant boolean,
  p_ip inet DEFAULT NULL)
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
    PERFORM pg_advisory_xact_lock(hashtextextended('opening_grant:gift_gate', 0));
    gift := public.signup_gift_settings();
    IF (gift->>'paused')::boolean THEN
      refusal := 'paused';
    ELSIF p_ip IS NOT NULL AND EXISTS (SELECT 1 FROM public.signup_gift_ips g
      WHERE g.ip = p_ip AND g.granted_at > now() - interval '24 hours') THEN
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
      VALUES (p_profile_id, 0, 'addition', 'Opening grant refused: ' || refusal,
        'opening_grant:' || p_profile_id::text, balance, balance, 'adjustment', 'opening_grant_ineligible', 'system',
        jsonb_build_object('refusal', refusal));
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

-- opening_grant_claim: whole current definition plus the trailing p_ip, passed through.
DROP FUNCTION IF EXISTS public.opening_grant_claim(uuid,jsonb);
CREATE OR REPLACE FUNCTION public.opening_grant_claim(p_profile_id uuid, p_digests jsonb, p_ip inet DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE p public.profiles;
BEGIN
  SELECT * INTO p FROM public.profiles WHERE id = p_profile_id FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'OPENING_GRANT_PROFILE_MISSING' USING ERRCODE = 'P0002'; END IF;
  IF p.status IS DISTINCT FROM 'active' OR p.is_deleted::text IS DISTINCT FROM 'false'
    OR EXISTS (SELECT 1 FROM public.account_erasure_requests WHERE profile_id = p_profile_id) THEN
    RAISE EXCEPTION 'ACCOUNT_CLOSED' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('granted', public.opening_grant_remember(p_profile_id, p_digests, true, p_ip));
END $function$;
REVOKE ALL ON FUNCTION public.opening_grant_claim(uuid, jsonb, inet) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.opening_grant_claim(uuid, jsonb, inet) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
