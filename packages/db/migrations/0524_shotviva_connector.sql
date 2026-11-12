-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- INTEGRATION-SHOTVIVA PR A (Owner 2026-11-05 / 2026-11-12: Shotviva is a connector inside Graylum, no internal settlement;
-- "打通再上线"). Number 0524 assigned by the controller.
--   * profiles.shotviva_account_id: the one thing Graylum stores about a connected Shotviva account (no token: the
--     partner key in the admin Vault proves "Graylum is calling", this id says for whom; Shotviva checks the pair against
--     its own partner_links). One Graylum profile per Shotviva account (partial unique index). Clients never write it;
--     the server sets it after the one-time code exchange and clears it on disconnect or a revoked link.
--     Account erasure clears it with the other profile fields: account_erasure_local_cleanup, _local_remaining and the
--     identity guard trigger are whole definitions copied from packages/db/functions/erasure and changed only by this column.
--   * platform_secrets slot 'shotviva': the partner key (sv_test_ on staging, sv_live_ in production), entered by the Owner
--     in the admin. The CHECK and the three slot functions are whole definitions changed only by the added slot.
-- Compatibility: additive. Old code never reads the column or the slot; new code treats an empty slot as "connector off".
-- Repeatable: IF NOT EXISTS / DROP ... IF EXISTS / CREATE OR REPLACE throughout; running it twice changes nothing.
-- Recovery: to withdraw, re-apply the six whole definitions from packages/db/functions at the staging commit before this
--   migration and restore the previous CHECK; the column can stay (nothing reads it) or be dropped once empty.
BEGIN;

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS shotviva_account_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_shotviva_account_unique ON public.profiles(shotviva_account_id)
  WHERE shotviva_account_id IS NOT NULL;
-- Clients never write it; the server sets and clears it.
REVOKE INSERT (shotviva_account_id), UPDATE (shotviva_account_id), REFERENCES (shotviva_account_id)
  ON TABLE public.profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT (shotviva_account_id), UPDATE (shotviva_account_id) ON TABLE public.profiles TO service_role;

-- account_erasure_local_cleanup(uuid,boolean)
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
  ,shotviva_account_id=NULL /* INTEGRATION-SHOTVIVA connected Shotviva account */
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

-- account_erasure_local_remaining(uuid)
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
    OR last_login_at IS NOT NULL OR shotviva_account_id IS NOT NULL /* INTEGRATION-SHOTVIVA */));
$function$;

-- account_erasure_identity_guard()
CREATE OR REPLACE FUNCTION public.account_erasure_identity_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=NEW.id AND profile_scrubbed_at IS NOT NULL)
  AND (NEW.email IS NOT NULL OR NEW.nickname IS NOT NULL OR NEW.avatar_url IS NOT NULL
   OR NEW.last_ip IS NOT NULL OR NEW.last_login_at IS NOT NULL OR NEW.signup_attribution IS NOT NULL /* ANALYTICS signup attribution */
   OR NEW.shotviva_account_id IS NOT NULL /* INTEGRATION-SHOTVIVA */) THEN
  RAISE EXCEPTION 'ACCOUNT_ERASURE_IDENTITY_REFILL' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $function$;

ALTER TABLE public.platform_secrets DROP CONSTRAINT IF EXISTS platform_secrets_slot_check;
ALTER TABLE public.platform_secrets ADD CONSTRAINT platform_secrets_slot_check
  CHECK (slot IN ('openrouter','postforme','postforme_webhook','tikhub','parallel','firecrawl','resend','shotviva'));

-- platform_secret_check(text,uuid,bigint)
CREATE OR REPLACE FUNCTION public.platform_secret_check(p_slot text, p_actor uuid, p_revision bigint)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF p_slot IS NULL OR p_slot NOT IN ('openrouter','postforme','postforme_webhook','tikhub','parallel','firecrawl','resend','shotviva')
  OR p_actor IS NULL OR p_revision IS NULL OR p_revision<0 OR p_revision>=9999999999
 THEN RAISE EXCEPTION 'PLATFORM_SECRET_INPUT_INVALID' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor AND role='admin'
  AND status='active' AND is_deleted::text='false')
 THEN RAISE EXCEPTION 'PLATFORM_SECRET_ACTOR_DENIED' USING ERRCODE='42501';END IF;
 IF to_regclass('vault.secrets') IS NULL OR to_regclass('vault.decrypted_secrets') IS NULL
 THEN RAISE EXCEPTION 'PLATFORM_SECRET_VAULT_MISSING' USING ERRCODE='55000';END IF;
END $function$;

-- platform_secret_status()
CREATE OR REPLACE FUNCTION public.platform_secret_status()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT jsonb_agg(jsonb_build_object('slot',s.slot,'configured',p.last4 IS NOT NULL,'last4',p.last4,
  'revision',coalesce(p.revision,0),'updatedBy',p.updated_by,
  'updatedAt',to_char(p.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY s.n)
 FROM unnest(ARRAY['openrouter','postforme','postforme_webhook','tikhub','parallel','firecrawl','resend','shotviva']) WITH ORDINALITY s(slot,n)
 LEFT JOIN platform_secrets p ON p.slot=s.slot
$function$;

-- platform_secret_read(text)
CREATE OR REPLACE FUNCTION public.platform_secret_read(p_slot text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE sid uuid;v text;
BEGIN
 IF p_slot IS NULL OR p_slot NOT IN ('openrouter','postforme','postforme_webhook','tikhub','parallel','firecrawl','resend','shotviva')
 THEN RAISE EXCEPTION 'PLATFORM_SECRET_INPUT_INVALID' USING ERRCODE='23514';END IF;
 SELECT vault_secret_id INTO sid FROM platform_secrets WHERE slot=p_slot;
 IF sid IS NULL THEN RETURN NULL;END IF;
 IF to_regclass('vault.decrypted_secrets') IS NULL
 THEN RAISE EXCEPTION 'PLATFORM_SECRET_VAULT_MISSING' USING ERRCODE='55000';END IF;
 SELECT decrypted_secret INTO v FROM vault.decrypted_secrets WHERE id=sid;
 IF v IS NULL THEN RAISE EXCEPTION 'PLATFORM_SECRET_VAULT_ENTRY_MISSING' USING ERRCODE='55000';END IF;
 RETURN v;
END $function$;

REVOKE ALL ON FUNCTION public.platform_secret_check(text,uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.platform_secret_status(),public.platform_secret_read(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.platform_secret_status(),public.platform_secret_read(text) TO service_role;
COMMIT;
