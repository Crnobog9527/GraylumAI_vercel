-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- ANALYTICS: server-side GA4 `purchase` report (docs/launch/tasks/ANALYTICS.md §3.1, §7 PR-3, O3, O10 = B).
-- Number 0286 assigned by the controller.
--   * analytics_checkout_ids keeps, per unpaid order, the GA client_id/session_id the browser sent at checkout
--     (only after Termly statistics consent). They never enter checkout_request, Stripe metadata or any
--     finance-retained column. The fulfilment branch takes them out with DELETE … RETURNING, so one order is
--     reported at most once whatever the replay or concurrency.
--   * Why tables instead of two payment_orders columns (AGENTS §5): payment_orders carries the finance and
--     erasure guard triggers (an update on a closed account re-projects its metadata), and column grants are
--     per column there. A separate service_role-only table makes take-and-clear, the short expiry, consent
--     withdrawal and account erasure plain deletes, with no change to any finance column or guard.
--   * analytics_consent_withdrawals records when an account last withdrew statistics consent; ids written
--     before that moment are never reported, and a checkout request that STARTED before that moment cannot store
--     ids afterwards (the server stamps the request start before the provider is called).
--   * Ids live only as long as the Stripe checkout can be paid (45 minutes, the session lasts 31): older ones are
--     never reported, so a lost withdrawal notice can only matter inside that short window.
--   * Only GA formats are stored: client_id "digits.digits" (each ≤ 20), session_id ≤ 20 digits.
--   * Account erasure deletes both tables' rows (business leaves, in-place patch pattern of 0269/0270).
-- Tables and functions are service_role-only through functions; anon/authenticated have nothing.
-- Recovery: forward only. Rows are disposable statistics hand-offs; to stop reporting, revoke EXECUTE on
-- analytics_store_checkout_ids from service_role (take keeps clearing what is left; prune deletes the rest).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE IF NOT EXISTS public.analytics_checkout_ids(
 order_id uuid PRIMARY KEY REFERENCES public.payment_orders(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 client_id text NOT NULL CHECK (client_id ~ '^[0-9]{1,20}\.[0-9]{1,20}$'),
 session_id text NOT NULL CHECK (session_id ~ '^[0-9]{1,20}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS analytics_checkout_ids_user_idx ON public.analytics_checkout_ids(user_id);
CREATE INDEX IF NOT EXISTS analytics_checkout_ids_created_idx ON public.analytics_checkout_ids(created_at);

CREATE TABLE IF NOT EXISTS public.analytics_consent_withdrawals(
 user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
 withdrawn_at timestamptz NOT NULL
);

ALTER TABLE public.analytics_checkout_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_consent_withdrawals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analytics_checkout_ids, public.analytics_consent_withdrawals
 FROM PUBLIC,anon,authenticated,service_role;

-- Checkout: keep the ids for this user's own unpaid order. Malformed ids, someone else's order, a fulfilled
-- order or a closing account store nothing (false). A repeated checkout of the same order replaces them.
CREATE OR REPLACE FUNCTION public.analytics_store_checkout_ids(p_user uuid,p_order uuid,p_client text,p_session text,
 p_requested_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_user IS NULL OR p_order IS NULL OR p_client IS NULL OR p_session IS NULL OR p_requested_at IS NULL
  OR p_requested_at>clock_timestamp()+interval '1 minute'
  OR p_client !~ '^[0-9]{1,20}\.[0-9]{1,20}$' OR p_session !~ '^[0-9]{1,20}$' THEN RETURN false; END IF;
 -- One writer per account at a time (store and withdraw), so the withdrawal check and the insert are atomic.
 PERFORM pg_advisory_xact_lock(hashtextextended('analytics_consent:'||p_user::text,0));
 IF EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=p_user) THEN RETURN false; END IF;
 -- A request that began before the latest withdrawal must not bring the ids back.
 IF EXISTS(SELECT 1 FROM analytics_consent_withdrawals w WHERE w.user_id=p_user AND w.withdrawn_at>=p_requested_at)
  THEN RETURN false; END IF;
 INSERT INTO analytics_checkout_ids(order_id,user_id,client_id,session_id)
  SELECT o.id,o.user_id,p_client,p_session FROM payment_orders o
  WHERE o.id=p_order AND o.user_id=p_user AND o.fulfilled_at IS NULL
 ON CONFLICT (order_id) DO UPDATE SET client_id=EXCLUDED.client_id,session_id=EXCLUDED.session_id,
  created_at=clock_timestamp()
  WHERE analytics_checkout_ids.user_id=EXCLUDED.user_id;
 RETURN FOUND;
END $$;

-- Fulfilment: take the ids out (always cleared) and return them only when they were written after the
-- account's last withdrawal, within the checkout's payable window (45 minutes) and the account is not closing.
-- At most one caller ever gets them.
CREATE OR REPLACE FUNCTION public.analytics_take_checkout_ids(p_order uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE taken analytics_checkout_ids;
BEGIN
 DELETE FROM analytics_checkout_ids WHERE order_id=p_order RETURNING * INTO taken;
 IF taken.order_id IS NULL THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM analytics_consent_withdrawals w WHERE w.user_id=taken.user_id
   AND w.withdrawn_at>=taken.created_at)
  OR taken.created_at<clock_timestamp()-interval '45 minutes'
  OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=taken.user_id) THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('clientId',taken.client_id,'sessionId',taken.session_id);
END $$;

-- Consent withdrawn in the browser: remember when, and drop every id not yet taken (paid or not).
CREATE OR REPLACE FUNCTION public.analytics_withdraw_consent(p_user uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_user IS NULL THEN RAISE EXCEPTION 'ANALYTICS_USER_REQUIRED'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('analytics_consent:'||p_user::text,0));
 IF NOT EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=p_user)
  AND EXISTS(SELECT 1 FROM profiles WHERE id=p_user) THEN
  INSERT INTO analytics_consent_withdrawals(user_id,withdrawn_at) VALUES(p_user,clock_timestamp())
  ON CONFLICT (user_id) DO UPDATE SET withdrawn_at=EXCLUDED.withdrawn_at;
 END IF;
 DELETE FROM analytics_checkout_ids WHERE user_id=p_user;
END $$;

-- Daily clean-up: ids not taken (unpaid or abandoned orders) are long past their 45-minute window; delete them.
CREATE OR REPLACE FUNCTION public.analytics_prune_checkout_ids()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
 DELETE FROM analytics_checkout_ids WHERE created_at<clock_timestamp()-interval '1 hour';
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN n;
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('analytics_store_checkout_ids','analytics_take_checkout_ids',
   'analytics_withdraw_consent','analytics_prune_checkout_ids') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
 END LOOP;
END $$;

-- Account erasure: both tables go with the account (ANALYTICS §3.1 "注销清理也置空").
DO $$
DECLARE source text; needle text; replacement text; sig text;
BEGIN
 FOR sig,needle,replacement IN SELECT * FROM (VALUES
  ('erasure_business_owner(text,jsonb)', E' CASE\n',
   E' CASE\n WHEN t IN (''analytics_checkout_ids'',''analytics_consent_withdrawals'') THEN RETURN (j->>''user_id'')::uuid;\n'),
  ('account_erasure_prune_business(uuid,integer)', E' FOREACH t IN ARRAY ARRAY[\n',
   E' FOREACH t IN ARRAY ARRAY[\n  ''analytics_checkout_ids'',''analytics_consent_withdrawals'',\n'),
  ('account_erasure_business_remaining(uuid)', ' SELECT ',
   E' SELECT (SELECT count(*) FROM public.analytics_checkout_ids WHERE user_id=p_profile_id)\n'
   ||E' +(SELECT count(*) FROM public.analytics_consent_withdrawals WHERE user_id=p_profile_id)+')
 ) changes(signature,anchor,patch) LOOP
  source:=pg_get_functiondef(('public.'||sig)::regprocedure);
  IF position('-- ANALYTICS erasure' IN source)=0 THEN
   IF length(source)-length(replace(source,needle,''))<>length(needle) THEN
    RAISE EXCEPTION 'ANALYTICS_ERASURE_SOURCE_MISMATCH: %',sig; END IF;
   EXECUTE replace(source,needle,E' -- ANALYTICS erasure\n'||replacement);
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.erasure_business_owner(text,jsonb),public.account_erasure_prune_business(uuid,integer),
 public.account_erasure_business_remaining(uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
