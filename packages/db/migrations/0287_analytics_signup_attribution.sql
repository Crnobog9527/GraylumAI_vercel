-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- ANALYTICS: first source written into the account at sign-up (docs/launch/tasks/ANALYTICS.md §3.2, O8, O9).
-- Number 0287 assigned by the controller.
--   * profiles.signup_attribution (nullable jsonb): registered utm_* values, the referrer host name, the landing
--     route template and the first-visit time. No full URL, no IP. One per account, written once. Kept on the
--     existing profile row (one value per account, no new table; plan §3.2, AGENTS §5).
--   * Written only through analytics_record_signup_attribution (service_role), which re-checks the shape, writes
--     only while empty, only for an account created in the last 30 days and never for a closing account.
--   * Account erasure: the local cleanup clears it together with the other personal profile fields, and the
--     identity guard refuses to refill it afterwards (0191 pattern, patched in place).
--   * analytics_signup_source_report: aggregate counts for the admin statistics page (no per-account rows).
-- Compatible with old code (nullable column, nothing reads it yet); repeatable. Recovery: forward only; to stop
-- recording, revoke EXECUTE on analytics_record_signup_attribution from service_role.
BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS signup_attribution jsonb;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_signup_attribution_shape;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_signup_attribution_shape CHECK (signup_attribution IS NULL OR (
 jsonb_typeof(signup_attribution)='object' AND octet_length(signup_attribution::text)<=1000
 AND (signup_attribution-ARRAY['utm_source','utm_medium','utm_campaign','utm_content','utm_term','referrer_host',
  'landing_path','first_seen_at'])='{}'::jsonb));
-- Clients never write it; only the function below does.
REVOKE UPDATE (signup_attribution), INSERT (signup_attribution) ON public.profiles FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.analytics_record_signup_attribution(p_user uuid,p_attribution jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE k text; v text;
BEGIN
 IF p_user IS NULL OR p_attribution IS NULL OR jsonb_typeof(p_attribution)<>'object'
  OR octet_length(p_attribution::text)>1000 OR NOT (p_attribution ? 'first_seen_at') THEN RETURN false; END IF;
 FOR k,v IN SELECT key,value FROM jsonb_each_text(p_attribution) LOOP
  IF k IN ('utm_source','utm_medium','utm_campaign','utm_content','utm_term') THEN
   IF v !~ '^[a-z0-9_.-]{1,64}$' THEN RETURN false; END IF;
  ELSIF k='referrer_host' THEN
   IF v !~ '^[a-z0-9.-]{1,253}$' THEN RETURN false; END IF;
  ELSIF k='landing_path' THEN
   IF v !~ '^/[A-Za-z0-9/\[\]-]{0,119}$' THEN RETURN false; END IF;
  ELSIF k='first_seen_at' THEN
   IF v !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$' THEN RETURN false; END IF;
  ELSE RETURN false;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=p_user) THEN RETURN false; END IF;
 UPDATE profiles SET signup_attribution=p_attribution
  WHERE id=p_user AND signup_attribution IS NULL AND created_at>clock_timestamp()-interval '30 days';
 RETURN FOUND;
END $$;

-- Admin statistics: sign-ups and paying accounts per first source over the last p_days (aggregates only).
CREATE OR REPLACE FUNCTION public.analytics_signup_source_report(p_days integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_days IS NULL OR p_days<1 OR p_days>400 THEN RAISE EXCEPTION 'ANALYTICS_REPORT_RANGE_INVALID'; END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('source',source,'signups',signups,'paid',paid)
   ORDER BY signups DESC,source)
  FROM (SELECT coalesce(p.signup_attribution->>'utm_source',p.signup_attribution->>'referrer_host',
     CASE WHEN p.signup_attribution IS NULL THEN 'unknown' ELSE 'direct' END) source,
    count(*)::int signups,
    count(*) FILTER (WHERE EXISTS(SELECT 1 FROM payment_orders o WHERE o.user_id=p.id AND o.fulfilled_at IS NOT NULL))::int paid
   FROM profiles p
   WHERE p.created_at>clock_timestamp()-make_interval(days=>p_days)
    AND NOT EXISTS(SELECT 1 FROM account_erasure_requests e WHERE e.profile_id=p.id)
   GROUP BY 1) grouped),'[]'::jsonb);
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('analytics_record_signup_attribution','analytics_signup_source_report') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
 END LOOP;
END $$;

-- Account erasure: clear it with the other personal profile fields and never let it be refilled (0191 pattern).
DO $$
DECLARE source text; needle text; replacement text; sig text;
BEGIN
 FOR sig,needle,replacement IN SELECT * FROM (VALUES
  ('account_erasure_local_cleanup(uuid,boolean)',
   'UPDATE profiles SET email=NULL,nickname=NULL,avatar_url=NULL,last_ip=NULL,last_login_at=NULL',
   'UPDATE profiles SET email=NULL,nickname=NULL,avatar_url=NULL,last_ip=NULL,last_login_at=NULL,signup_attribution=NULL'),
  ('account_erasure_identity_guard()',
   'OR NEW.last_ip IS NOT NULL OR NEW.last_login_at IS NOT NULL)',
   'OR NEW.last_ip IS NOT NULL OR NEW.last_login_at IS NOT NULL OR NEW.signup_attribution IS NOT NULL)')
 ) changes(signature,anchor,patch) LOOP
  source:=pg_get_functiondef(('public.'||sig)::regprocedure);
  IF position('-- ANALYTICS signup attribution' IN source)=0 THEN
   IF length(source)-length(replace(source,needle,''))<>length(needle) THEN
    RAISE EXCEPTION 'ANALYTICS_ATTRIBUTION_SOURCE_MISMATCH: %',sig; END IF;
   EXECUTE replace(replace(source,needle,replacement),' AS $function$',E' AS $function$\n -- ANALYTICS signup attribution');
  END IF;
 END LOOP;
END $$;
-- CREATE OR REPLACE through EXECUTE keeps both functions' existing grants.
COMMIT;
