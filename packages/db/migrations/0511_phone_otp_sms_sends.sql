-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- PHONE-OTP (Owner 2026-11-07, Master Plan 2.1 "手机号上线前做"): mainland China (+86) phone sign-in through Supabase
-- phone OTP and the "Send SMS" Auth Hook (apps/web/src/app/api/auth/sms-hook). Number 0511 assigned by the controller.
--   * sms_sends: one row per code the site asked Supabase to send. The send route writes it (with the visitor's IP, which
--     the hook payload does not carry) before signInWithOtp; the hook marks it sent before handing the code to the SMS
--     provider. A hook call without a fresh unsent row is refused, so calling the Auth API directly cannot skip the limits.
--     The number is not stored: phone_key is an HMAC (keyed with the hook secret) computed in the app. Rows are needed
--     for 24 hours; sms_request_send deletes those older than two days. RLS on, no policy, service_role functions only.
--     Limits over 24 hours: 1 code per number per 60 seconds, 5 per number, 20 per IP.
--   * profiles.phone: the verified number (E.164 digits, 86 + 11), synced from the Auth user by the server like email, so
--     the account page and the admin user list and search can show and find it. Only service_role writes it.
--     Account erasure clears it with the other profile fields (account_erasure_local_cleanup / _local_remaining,
--     whole definitions copied from packages/db/functions/erasure and changed only by the phone column).
--   * payment_notice_inbox: a phone-only account has no email, so sendPaymentNotice records its reminders as skipped
--     (PAYMENT_NOTICE_NO_RECIPIENT). The account page shows those of the last 14 days instead (read only, own rows).
-- Compatibility: everything is additive. Old code never reads or writes the new column, table or functions; new code
--   writes profiles.phone only for phone accounts, which cannot exist before Supabase phone sign-in is turned on.
--   Apply the migration before the code is deployed (the admin list selects the new column).
-- Repeatable: IF NOT EXISTS / DROP ... IF EXISTS / CREATE OR REPLACE throughout; running it twice changes nothing.
-- Recovery: rows in sms_sends are disposable rate-limit records; to withdraw phone sign-in turn the Supabase hook and phone
--   provider off (no code path sends without them). To undo the erasure change, re-apply the two whole definitions from
--   packages/db/functions/erasure/ at the staging commit before this migration; profiles.phone is then no longer cleared,
--   so keep the column and clear it by hand (UPDATE profiles SET phone=NULL for erased accounts) until re-applied.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE IF NOT EXISTS public.sms_sends(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 phone_key text NOT NULL CHECK (phone_key ~ '^[0-9a-f]{64}$'),
 ip inet,
 requested_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz
);
-- Per number: the 60-second gap and the 5-a-day count; per IP: the 20-a-day count; the sweep.
CREATE INDEX IF NOT EXISTS sms_sends_phone_key_requested_at_idx ON public.sms_sends(phone_key,requested_at DESC);
CREATE INDEX IF NOT EXISTS sms_sends_ip_requested_at_idx ON public.sms_sends(ip,requested_at DESC) WHERE ip IS NOT NULL;
CREATE INDEX IF NOT EXISTS sms_sends_requested_at_idx ON public.sms_sends(requested_at);
ALTER TABLE public.sms_sends ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sms_sends FROM PUBLIC,anon,authenticated,service_role;

-- Step 1, the send route, before it asks Supabase to send. Counts every request, sent or not (Supabase test numbers never
-- reach the hook and still count). Answers a status word instead of raising, so the caller can say which limit was hit.
-- Transaction-level advisory locks per number and per IP make concurrent calls queue, so two cannot both pass a count.
CREATE OR REPLACE FUNCTION public.sms_request_send(p_phone_key text,p_ip inet) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_since timestamptz:=now()-interval '24 hours';
BEGIN
 IF p_phone_key IS NULL OR p_phone_key !~ '^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION 'SMS_PHONE_KEY_INVALID' USING ERRCODE='22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('sms:phone:'||p_phone_key,0));
 IF p_ip IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('sms:ip:'||host(p_ip),0)); END IF;
 IF EXISTS(SELECT 1 FROM sms_sends s WHERE s.phone_key=p_phone_key AND s.requested_at>now()-interval '60 seconds') THEN
  RETURN 'phone_cooldown';
 END IF;
 IF (SELECT count(*) FROM sms_sends s WHERE s.phone_key=p_phone_key AND s.requested_at>v_since)>=5 THEN
  RETURN 'phone_daily';
 END IF;
 IF p_ip IS NOT NULL AND (SELECT count(*) FROM sms_sends s WHERE s.ip=p_ip AND s.requested_at>v_since)>=20 THEN
  RETURN 'ip_daily';
 END IF;
 INSERT INTO sms_sends(phone_key,ip) VALUES(p_phone_key,p_ip);
 -- The rows have done their job after a day; keep two, then let them go (bounded per call).
 DELETE FROM sms_sends s WHERE s.id IN (SELECT o.id FROM sms_sends o WHERE o.requested_at<now()-interval '2 days'
  ORDER BY o.requested_at LIMIT 200);
 RETURN 'ok';
END $$;

-- Step 2, the Send SMS hook, before any provider is called: a request from the last 2 minutes not sent yet, and the sent
-- codes still under the limits for the number and for that request's IP. Marks the request sent.
CREATE OR REPLACE FUNCTION public.sms_authorize_send(p_phone_key text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_since timestamptz:=now()-interval '24 hours'; v_request sms_sends;
BEGIN
 IF p_phone_key IS NULL OR p_phone_key !~ '^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION 'SMS_PHONE_KEY_INVALID' USING ERRCODE='22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('sms:phone:'||p_phone_key,0));
 SELECT * INTO v_request FROM sms_sends s
  WHERE s.phone_key=p_phone_key AND s.sent_at IS NULL AND s.requested_at>now()-interval '2 minutes'
  ORDER BY s.requested_at DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RETURN 'no_request'; END IF;
 IF EXISTS(SELECT 1 FROM sms_sends s WHERE s.phone_key=p_phone_key AND s.sent_at>now()-interval '60 seconds') THEN
  RETURN 'phone_cooldown';
 END IF;
 IF (SELECT count(*) FROM sms_sends s WHERE s.phone_key=p_phone_key AND s.sent_at>v_since)>=5 THEN
  RETURN 'phone_daily';
 END IF;
 IF v_request.ip IS NOT NULL
  AND (SELECT count(*) FROM sms_sends s WHERE s.ip=v_request.ip AND s.sent_at>v_since)>=20 THEN
  RETURN 'ip_daily';
 END IF;
 UPDATE sms_sends SET sent_at=now() WHERE id=v_request.id;
 RETURN 'ok';
END $$;

-- Supabase refused before the hook ran (failed hCaptcha, its own limit): the request sent nothing and no longer counts
-- against the number. Without this anyone could use up a stranger's 5 a day with failed checks.
CREATE OR REPLACE FUNCTION public.sms_release_send(p_phone_key text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DELETE FROM sms_sends s WHERE s.id=(SELECT o.id FROM sms_sends o WHERE o.phone_key=p_phone_key AND o.sent_at IS NULL
  AND o.requested_at>now()-interval '2 minutes' ORDER BY o.requested_at DESC LIMIT 1)
$$;

REVOKE ALL ON FUNCTION public.sms_request_send(text,inet) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.sms_authorize_send(text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.sms_release_send(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sms_request_send(text,inet) TO service_role;
GRANT EXECUTE ON FUNCTION public.sms_authorize_send(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.sms_release_send(text) TO service_role;

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_phone_mainland;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_phone_mainland CHECK (phone IS NULL OR phone ~ '^86[0-9]{11}$');
-- Clients never write it; the server copies it from the verified Auth user.
REVOKE INSERT (phone), UPDATE (phone), REFERENCES (phone) ON TABLE public.profiles FROM PUBLIC,anon,authenticated;
GRANT SELECT (phone), INSERT (phone), UPDATE (phone) ON TABLE public.profiles TO service_role;
-- No index: the admin search matches any part of the number (LIKE '%digits%'), which a b-tree cannot serve, and every
-- extra index on profiles is one more relation each main-path turn locks (check-turn-budget.mjs).

-- Reminders that could not be mailed because the account has no email address, for the account page.
CREATE OR REPLACE FUNCTION public.payment_notice_inbox(p_user_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',n.id,'kind',n.kind,'params',n.template_params,'createdAt',n.created_at)
  ORDER BY n.created_at DESC),'[]'::jsonb)
 FROM (SELECT * FROM payment_notices WHERE user_id=p_user_id AND state='skipped'
  AND last_error_code='PAYMENT_NOTICE_NO_RECIPIENT' AND created_at>now()-interval '14 days'
  ORDER BY created_at DESC LIMIT 5) n
$$;
REVOKE ALL ON FUNCTION public.payment_notice_inbox(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.payment_notice_inbox(uuid) TO service_role;

-- account_erasure_local_cleanup: whole definition, only `phone=NULL` added to the profile scrub.
CREATE OR REPLACE FUNCTION public.account_erasure_local_cleanup(p_profile_id uuid, p_storage_verified boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE remaining bigint; manual bigint; proof jsonb; entry record; errors text[]:='{}';
BEGIN
 PERFORM account_erasure_assert_closed(p_profile_id);
 IF p_storage_verified IS NULL THEN RAISE EXCEPTION 'ERASURE_INVALID_STORAGE_PROOF'; END IF;
 IF NOT account_erasure_barrier() OR EXISTS(SELECT 1 FROM account_erasure_requests
  WHERE profile_id=p_profile_id AND confirmed_at>=transaction_timestamp()) THEN
  RETURN jsonb_build_object('remaining',1,'manualReview',0,'errors',jsonb_build_array('ERASURE_TRANSACTIONS_PENDING'));
 END IF;
 -- Independent content cleanup continues while financial questions remain unresolved.
 -- Each leaf batch has a hard row cap and never waits on another writer's row lock.
 UPDATE user_activity_logs SET action=action_type,ip_address=NULL,details=erasure_audit_details(details),
  content_erased_at=clock_timestamp() WHERE ctid IN (SELECT ctid FROM user_activity_logs
  WHERE user_id=p_profile_id AND content_erased_at IS NULL LIMIT 100 FOR UPDATE SKIP LOCKED);
 FOR entry IN SELECT unnest(ARRAY['application_logs','user_checkins']) tbl LOOP
  EXECUTE format('DELETE FROM public.%I WHERE ctid IN
   (SELECT ctid FROM public.%I WHERE user_id=$1 LIMIT 100 FOR UPDATE SKIP LOCKED)',entry.tbl,entry.tbl) USING p_profile_id;
 END LOOP;
 -- executor body scrub
 UPDATE tickets SET title='',description='' WHERE ctid IN (SELECT ctid FROM tickets
  WHERE user_id=p_profile_id AND (title<>'' OR description<>'') LIMIT 100 FOR UPDATE SKIP LOCKED);
 UPDATE ticket_replies SET content='' WHERE ctid IN (SELECT r.ctid FROM ticket_replies r
  WHERE content<>'' AND (r.user_id=p_profile_id OR EXISTS(SELECT 1 FROM tickets t WHERE t.id=r.ticket_id AND t.user_id=p_profile_id))
  LIMIT 100 FOR UPDATE OF r SKIP LOCKED);
 -- LIB-2a public erasure
 IF p_storage_verified AND EXISTS(SELECT 1 FROM account_erasure_requests
  WHERE profile_id=p_profile_id AND library_storage_verified_at IS NOT NULL)
  AND library_erasure_remaining(p_profile_id)=0 AND NOT EXISTS(SELECT 1 FROM ticket_upload_intents WHERE profile_id=p_profile_id) THEN
  -- executor storage proof
  UPDATE account_erasure_requests SET storage_verified_at=clock_timestamp() WHERE profile_id=p_profile_id;
  DELETE FROM ticket_replies WHERE ctid IN (SELECT t.ctid FROM ticket_replies t
   WHERE t.user_id=p_profile_id OR EXISTS(SELECT 1 FROM tickets p WHERE p.id=t.ticket_id AND p.user_id=p_profile_id)
   LIMIT 100 FOR UPDATE OF t SKIP LOCKED);
  DELETE FROM tickets WHERE ctid IN (SELECT t.ctid FROM tickets t WHERE t.user_id=p_profile_id
   AND NOT EXISTS(SELECT 1 FROM ticket_replies r WHERE r.ticket_id=t.id) LIMIT 100 FOR UPDATE OF t SKIP LOCKED);
  UPDATE account_erasure_requests SET storage_verified_at=clock_timestamp() WHERE profile_id=p_profile_id;
 ELSE
  errors:=array_append(errors,'ERASURE_STORAGE_PENDING');
  UPDATE account_erasure_requests SET storage_verified_at=NULL WHERE profile_id=p_profile_id;
 END IF;
 -- No amount, balance, membership, status or original primary key is changed.
 UPDATE profiles SET email=NULL,nickname=NULL,avatar_url=NULL,last_ip=NULL,last_login_at=NULL,signup_attribution=NULL /* ANALYTICS signup attribution */
  ,phone=NULL /* PHONE-OTP verified phone */
  WHERE id=p_profile_id;
 UPDATE account_erasure_requests SET profile_scrubbed_at=coalesce(profile_scrubbed_at,clock_timestamp())
  WHERE profile_id=p_profile_id;
 -- One locked order at a time; malformed finance stays unchanged and reviewable.
 FOR entry IN SELECT * FROM payment_orders WHERE user_id=p_profile_id AND request_erased_at IS NULL
  AND erasure_payment_terminal(to_jsonb(payment_orders))
  AND (checkout_request IS NOT NULL OR purchase_change_request IS NOT NULL)
  ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
  BEGIN
   UPDATE payment_orders SET checkout_request=erasure_payment_envelope(checkout_request,'checkout'),
    purchase_change_request=erasure_payment_envelope(purchase_change_request,'change'),request_erased_at=clock_timestamp()
    WHERE id=entry.id;
  EXCEPTION WHEN raise_exception THEN errors:=array_append(errors,'ERASURE_PAYMENT_REQUEST_REVIEW');
  END;
 END LOOP;
 PERFORM account_erasure_prune_business(p_profile_id);
 remaining:=account_erasure_local_remaining(p_profile_id);
 proof:=account_erasure_financial_proof(p_profile_id);
 manual:=(proof->>'manualReview')::bigint;
 -- IP/abuse retention and legacy financial JSON have no invented retention decision here.
 IF EXISTS(SELECT 1 FROM invitation_records WHERE (inviter_id=p_profile_id OR invitee_id=p_profile_id)
  AND (inviter_email IS NOT NULL OR invitee_email IS NOT NULL OR ip_address IS NOT NULL OR user_agent IS NOT NULL)) THEN
  manual:=manual+1; errors:=array_append(errors,'ERASURE_INVITATION_REVIEW');
 END IF;
 errors:=ARRAY(SELECT DISTINCT code FROM unnest(errors) AS code);
 UPDATE account_erasure_requests SET
  local_cleaned_at=CASE WHEN remaining=0 AND cardinality(errors)=0 THEN clock_timestamp() ELSE NULL END,
  stage=CASE WHEN stage='completed' THEN stage WHEN manual>0 OR (proof->>'financialPending')::bigint>0
    THEN 'billing_pending' ELSE 'erasing' END,
  review_codes=(CASE WHEN manual>0 THEN ARRAY['ERASURE_FINANCIAL_EVIDENCE_REVIEW']||errors WHEN (proof->>'financialPending')::bigint>0 THEN ARRAY['ERASURE_FINANCIAL_PENDING_REVIEW']||errors ELSE errors END)
   ||CASE WHEN auth_delete_started_at IS NOT NULL AND auth_deleted_at IS NULL THEN ARRAY['ERASURE_AUTH_PENDING'] ELSE '{}'::text[] END,
  next_review_at=CASE WHEN manual>0 OR (proof->>'financialPending')::bigint>0 OR auth_delete_started_at IS NOT NULL AND auth_deleted_at IS NULL
   THEN coalesce(next_review_at,clock_timestamp()+interval '30 days') ELSE NULL END,
  stage_updated_at=clock_timestamp()
 WHERE profile_id=p_profile_id;
 RETURN jsonb_build_object('remaining',remaining,'manualReview',manual,'errors',to_jsonb(errors));
END $function$;

-- account_erasure_local_remaining: whole definition, only `phone IS NOT NULL` added to the profile check.
CREATE OR REPLACE FUNCTION public.account_erasure_local_remaining(p_profile_id uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT account_erasure_business_remaining(p_profile_id)+account_erasure_body_remaining(p_profile_id)
 +(SELECT count(*) FROM opc_video_material_bindings WHERE actor_id=p_profile_id)
 +(SELECT count(*) FROM opc_account_strategy_request_bases WHERE actor_id=p_profile_id)
 +(SELECT count(*) FROM runtime_test_windows WHERE p_profile_id=ANY(actor_ids))
 +(SELECT count(*) FROM tickets WHERE user_id=p_profile_id)
 +(SELECT count(*) FROM ticket_replies WHERE user_id=p_profile_id)
 +(SELECT count(*) FROM application_logs WHERE user_id=p_profile_id)
 +(SELECT count(*) FROM user_activity_logs WHERE user_id=p_profile_id AND content_erased_at IS NULL)
 +(SELECT count(*) FROM user_checkins WHERE user_id=p_profile_id)
 +(SELECT count(*) FROM ticket_upload_intents WHERE profile_id=p_profile_id)
 +(SELECT count(*) FROM profiles WHERE id=p_profile_id AND
   (email IS NOT NULL OR phone IS NOT NULL OR nickname IS NOT NULL OR avatar_url IS NOT NULL OR last_ip IS NOT NULL
    OR last_login_at IS NOT NULL));
$function$;

COMMIT;
