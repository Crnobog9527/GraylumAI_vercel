-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE PR-A: a confirmed erasure request closes the account immediately and irreversibly.
-- Only closes use (login, new charges, client reads); content erasure follows in later migrations.
-- Existing BILL2/OPC/artifact admission already requires status='active' AND is_deleted='false';
-- settlement functions do not, so in-flight runs still settle. Apply remotely only with Owner approval.
BEGIN;

-- One row per closed account: progress only, never content, email or file names (DATA-ERASURE §2).
CREATE TABLE IF NOT EXISTS public.account_erasure_requests(
  profile_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL UNIQUE,
  stage text NOT NULL DEFAULT 'closed'
    CHECK (stage IN ('closed', 'erasing', 'billing_pending', 'completed')),
  confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  stage_updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error_code text CHECK (last_error_code ~ '^[A-Z0-9_]{1,64}$'),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0)
);
ALTER TABLE public.account_erasure_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.account_erasure_requests
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.account_erasure_requests TO service_role;

-- Caller-scoped so no client can probe whether another account id was closed.
CREATE OR REPLACE FUNCTION public.current_account_is_closed() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.account_erasure_requests WHERE profile_id = auth.uid());
$$;

-- A closed profile keeps status/is_deleted/deleted_at forever; credits and identity columns stay
-- writable for settlement and the later scrub. Deleting the row is blocked by the FK above.
CREATE OR REPLACE FUNCTION public.account_erasure_profile_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.account_erasure_requests WHERE profile_id = OLD.id)
    AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.status IS DISTINCT FROM 'deleted'
      OR NEW.is_deleted::text IS DISTINCT FROM 'true' OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
  THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_IRREVERSIBLE' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS account_erasure_profile_guard ON public.profiles;
CREATE TRIGGER account_erasure_profile_guard BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.account_erasure_profile_guard();

-- Renewal = a Stripe-managed subscription in an active state that is not set to end at period end.
CREATE OR REPLACE FUNCTION public.account_erasure_renewing(p_profile_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_subscriptions s
    WHERE s.user_id = p_profile_id AND s.stripe_subscription_id IS NOT NULL
      AND lower(s.status) IN ('active', 'trialing', 'past_due', 'incomplete', 'unpaid')
      AND s.cancel_at_period_end::text IS DISTINCT FROM 'true'
  );
$$;

-- Facts shown before confirmation: balance to be forfeited, renewal, paid access ending, and
-- money still in flight. BILL2 tables are not readable by service_role, so counts come from here.
CREATE OR REPLACE FUNCTION public.account_erasure_preview(p_profile_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'credits', coalesce((SELECT p.credits FROM public.profiles p WHERE p.id = p_profile_id), 0),
    'subscriptionRenewing', public.account_erasure_renewing(p_profile_id),
    'subscriptionActiveUntil', (
      SELECT max(s.current_period_end) FROM public.user_subscriptions s
      WHERE s.user_id = p_profile_id AND s.stripe_subscription_id IS NOT NULL
        AND lower(s.status) IN ('active', 'trialing', 'past_due', 'incomplete', 'unpaid')),
    'pendingPayments', (SELECT count(*) FROM public.payment_orders o
      WHERE o.user_id = p_profile_id AND o.status = 'pending'),
    'runsInFlight', (SELECT count(*) FROM public.bill2_runs r
      WHERE r.actor_id = p_profile_id AND r.state IN ('prepared', 'dispatched', 'unknown', 'cost_pending')),
    'closed', EXISTS (SELECT 1 FROM public.account_erasure_requests e WHERE e.profile_id = p_profile_id)
  );
$$;

-- Idempotent confirm. The server verifies recent re-authentication before calling it; the renewal
-- check is repeated here under the profile lock (Owner 2026-09-30, E4: cancel renewal first).
CREATE OR REPLACE FUNCTION public.account_erasure_confirm(p_profile_id uuid, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  p public.profiles;
  r public.account_erasure_requests;
BEGIN
  IF p_profile_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO p FROM public.profiles WHERE id = p_profile_id FOR UPDATE;
  IF p.id IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_PROFILE_MISSING' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO r FROM public.account_erasure_requests WHERE profile_id = p_profile_id;
  IF r.profile_id IS NOT NULL THEN
    RETURN jsonb_build_object('requestId', r.request_id, 'stage', r.stage,
      'confirmedAt', r.confirmed_at, 'created', false);
  END IF;
  IF p.status IS DISTINCT FROM 'active' OR p.is_deleted::text IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_STATUS_DENIED' USING ERRCODE = '42501';
  END IF;
  -- An admin must be demoted first so the platform is never left without its operator by accident.
  IF p.role = 'admin' THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_ADMIN_DENIED' USING ERRCODE = '42501';
  END IF;
  IF public.account_erasure_renewing(p_profile_id) THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_SUBSCRIPTION_RENEWING' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.profiles SET status = 'deleted', is_deleted = 'true', deleted_at = clock_timestamp()
  WHERE id = p_profile_id;
  INSERT INTO public.account_erasure_requests(profile_id, request_id)
  VALUES (p_profile_id, p_request_id) RETURNING * INTO r;
  RETURN jsonb_build_object('requestId', r.request_id, 'stage', r.stage,
    'confirmedAt', r.confirmed_at, 'created', true);
END $$;

-- Records a non-content failure code (e.g. Auth revocation) so a later job can retry it.
CREATE OR REPLACE FUNCTION public.account_erasure_note_error(p_profile_id uuid, p_code text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.account_erasure_requests
  SET last_error_code = p_code, retry_count = retry_count + 1, stage_updated_at = clock_timestamp()
  WHERE profile_id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_REQUEST_MISSING' USING ERRCODE = 'P0002';
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.current_account_is_closed() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_account_is_closed() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.account_erasure_profile_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_erasure_renewing(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_erasure_preview(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_erasure_preview(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.account_erasure_confirm(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_erasure_confirm(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.account_erasure_note_error(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_erasure_note_error(uuid, text) TO service_role;

-- A closed account's unexpired JWT must not read or write through PostgREST. RESTRICTIVE policies
-- AND with every existing policy, so no current policy text has to be restated. profiles stays
-- readable to its owner so the API can report the closed state instead of recreating the profile.
DO $$
DECLARE
  rel record;
BEGIN
  FOR rel IN
    SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity
      AND c.relname NOT IN ('profiles', 'account_erasure_requests')
      AND (has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
        OR has_any_column_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE'))
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS account_open_required ON public.%I', rel.relname);
    EXECUTE format('CREATE POLICY account_open_required ON public.%I AS RESTRICTIVE FOR ALL'
      ' TO authenticated USING (NOT (SELECT public.current_account_is_closed()))'
      ' WITH CHECK (NOT (SELECT public.current_account_is_closed()))', rel.relname);
  END LOOP;
END $$;

COMMIT;
