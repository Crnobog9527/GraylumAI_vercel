-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-NOTIFY PR-N1: payment notice send records (docs/launch/tasks/PAY-NOTIFY.md §4.2, §5).
-- Number 0270 assigned by the controller.
--   * payment_notices holds one row per (kind, source_ref, due_key): a reminder is sent at most once.
--     No e-mail address and no body is stored: only a digest of recipient + language + rendered mail,
--     the template version and non-personal template parameters (dates, amounts, plan ids).
--   * The row id is the provider idempotency key. A send is claimed (state 'sending' with a short lease)
--     before calling the provider; an uncertain result is retried only with the same digest and only
--     within 24 hours of the first attempt, otherwise it goes to manual review.
--   * Explicit provider refusals ('failed') are retried up to 3 attempts in total.
--   * Admin resend (same idempotency key) is allowed only for uncertain results within 24 hours.
--   * Account erasure deletes the user's rows (business leaves, same in-place patch pattern as 0240/0262).
--   * ADMIN-SECRETS: adds the 'resend' slot (Resend API key, entered in the admin, no Vercel fallback).
-- Table and functions are service_role-only through functions; anon/authenticated have nothing.
-- Recovery: forward only. Rows are disposable send records; to withdraw, revoke EXECUTE from service_role.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE IF NOT EXISTS public.payment_notices(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('card_renewal_upcoming','wallet_founder_expiry','wallet_plan_expiry',
  'restore_pro_expiry','dispute_won_resubscribe','founder_ended')),
 source_ref text NOT NULL CHECK (source_ref ~ '^[A-Za-z0-9_:.-]{1,200}$'),
 due_key text NOT NULL CHECK (due_key ~ '^[A-Za-z0-9_:.+-]{1,100}$'),
 template_params jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(template_params)='object' AND octet_length(template_params::text)<=2000),
 state text NOT NULL DEFAULT 'pending'
  CHECK (state IN ('pending','sending','sent','failed','unknown','skipped','manual')),
 manual_reason text CHECK (manual_reason IN ('unknown_unresolved','unknown_expired','digest_mismatch')),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
 first_attempt_at timestamptz,
 lease_expires_at timestamptz,
 provider_message_id text CHECK (provider_message_id ~ '^[A-Za-z0-9_:.-]{1,200}$'),
 payload_digest text CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
 template_version text CHECK (template_version ~ '^[A-Za-z0-9_.:-]{1,40}$'),
 last_error_code text CHECK (last_error_code ~ '^[A-Za-z0-9_.:-]{1,80}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz,
 UNIQUE (kind,source_ref,due_key),
 CHECK ((state='manual')=(manual_reason IS NOT NULL)),
 CHECK (state<>'sent' OR sent_at IS NOT NULL),
 CHECK (state<>'sending' OR lease_expires_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS payment_notices_user_idx ON public.payment_notices(user_id);
CREATE INDEX IF NOT EXISTS payment_notices_attention_idx ON public.payment_notices(updated_at DESC)
 WHERE state IN ('sending','failed','unknown','manual');
ALTER TABLE public.payment_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payment_notices FROM PUBLIC,anon,authenticated,service_role;

-- Create (or find) the record for one reminder. Repeated scans and concurrent jobs meet the unique key.
CREATE OR REPLACE FUNCTION public.payment_notice_enqueue(p_user_id uuid,p_kind text,p_source_ref text,
 p_due_key text,p_template_params jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r payment_notices;
BEGIN
 -- A closing account gets no new rows: account erasure would otherwise have to chase late scans.
 -- account_erasure_confirm locks the profile FOR UPDATE before recording the request; FOR SHARE here
 -- serializes with it, so either the request is visible now or confirmation waits for this insert
 -- (which erasure then prunes).
 PERFORM 1 FROM profiles WHERE id=p_user_id FOR SHARE;
 IF EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=p_user_id) THEN
  RETURN jsonb_build_object('id',NULL,'state','skipped','created',false);
 END IF;
 INSERT INTO payment_notices(user_id,kind,source_ref,due_key,template_params)
 VALUES(p_user_id,p_kind,p_source_ref,p_due_key,coalesce(p_template_params,'{}'::jsonb))
 ON CONFLICT (kind,source_ref,due_key) DO NOTHING RETURNING * INTO r;
 IF NOT FOUND THEN
  SELECT * INTO STRICT r FROM payment_notices WHERE kind=p_kind AND source_ref=p_source_ref AND due_key=p_due_key;
  IF r.user_id<>p_user_id THEN RAISE EXCEPTION 'PAYMENT_NOTICE_OWNER_MISMATCH' USING ERRCODE='23514';END IF;
 END IF;
 RETURN jsonb_build_object('id',r.id,'state',r.state,'created',r.attempts=0 AND r.state='pending');
END $$;

-- What the sender needs to render: the recipient is read live from profiles and never stored here.
CREATE OR REPLACE FUNCTION public.payment_notice_prepare(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('id',n.id,'userId',n.user_id,'kind',n.kind,'sourceRef',n.source_ref,'dueKey',n.due_key,
  'templateParams',n.template_params,'state',n.state,'attempts',n.attempts,'email',p.email,
  'erasing',EXISTS(SELECT 1 FROM account_erasure_requests e WHERE e.profile_id=n.user_id)
   OR coalesce(p.is_deleted::text,'false')<>'false')
 FROM payment_notices n LEFT JOIN profiles p ON p.id=n.user_id WHERE n.id=p_id
$$;

-- Fixed rule for who may press the admin resend button (also shown in the admin list).
CREATE OR REPLACE FUNCTION public.payment_notice_resendable(n payment_notices) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT n.first_attempt_at>now()-interval '24 hours' AND n.payload_digest IS NOT NULL
  AND (n.state='unknown' OR n.state='manual' AND n.manual_reason='unknown_unresolved'
   OR n.state='sending' AND n.lease_expires_at<=now())
$$;

-- Claim one attempt. Decisions: send | busy | skip | manual | done | refused.
--   * p_actor NULL: the system sender. pending, failed (<3 attempts), and uncertain results within 24h.
--   * p_actor set: an admin resend, only for resendable rows; audited without any personal data.
-- The digest must equal the one fixed at the first attempt, otherwise the old idempotency key is unsafe.
CREATE OR REPLACE FUNCTION public.payment_notice_claim(p_id uuid,p_digest text,p_template_version text,
 p_actor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n payment_notices; uncertain boolean;
BEGIN
 IF p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR p_template_version IS NULL
  OR p_template_version !~ '^[A-Za-z0-9_.:-]{1,40}$'
 THEN RAISE EXCEPTION 'PAYMENT_NOTICE_INPUT_INVALID' USING ERRCODE='23514';END IF;
 IF p_actor IS NOT NULL AND NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor AND role='admin'
  AND status='active' AND is_deleted::text='false')
 THEN RAISE EXCEPTION 'PAYMENT_NOTICE_ACTOR_DENIED' USING ERRCODE='42501';END IF;
 SELECT * INTO n FROM payment_notices WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('decision','done');END IF;
 IF EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=n.user_id) THEN
  IF n.state IN ('pending','failed','unknown','sending') THEN
   UPDATE payment_notices SET state='skipped',lease_expires_at=NULL,last_error_code='PAYMENT_NOTICE_ACCOUNT_ERASURE',
    updated_at=now() WHERE id=n.id;
  END IF;
  RETURN jsonb_build_object('decision','skip');
 END IF;
 uncertain:=n.state='unknown' OR n.state='sending' AND n.lease_expires_at<=now();
 IF p_actor IS NOT NULL THEN
  IF NOT payment_notice_resendable(n) THEN RETURN jsonb_build_object('decision','refused');END IF;
 ELSIF n.state='sending' AND NOT uncertain THEN RETURN jsonb_build_object('decision','busy');
 ELSIF NOT (n.state='pending' OR n.state='failed' AND n.attempts<3 OR uncertain) THEN
  RETURN jsonb_build_object('decision','done');
 END IF;
 IF uncertain OR p_actor IS NOT NULL THEN
  -- The provider keeps idempotency keys for 24 hours; after that a resend could deliver twice.
  IF n.first_attempt_at<=now()-interval '24 hours' THEN
   UPDATE payment_notices SET state='manual',manual_reason='unknown_expired',lease_expires_at=NULL,updated_at=now()
    WHERE id=n.id;
   RETURN jsonb_build_object('decision','manual','reason','unknown_expired');
  END IF;
 END IF;
 IF n.payload_digest IS NOT NULL AND (n.payload_digest<>p_digest OR n.template_version<>p_template_version) THEN
  UPDATE payment_notices SET state='manual',manual_reason='digest_mismatch',lease_expires_at=NULL,updated_at=now()
   WHERE id=n.id;
  RETURN jsonb_build_object('decision','manual','reason','digest_mismatch');
 END IF;
 UPDATE payment_notices SET state='sending',manual_reason=NULL,attempts=n.attempts+1,
  first_attempt_at=coalesce(n.first_attempt_at,now()),payload_digest=p_digest,template_version=p_template_version,
  lease_expires_at=now()+interval '2 minutes',updated_at=now()
 WHERE id=n.id RETURNING * INTO n;
 IF p_actor IS NOT NULL THEN
  INSERT INTO user_activity_logs(admin_id,action,action_type,details)
  VALUES(p_actor,'payment_notice_resend','settings',jsonb_build_object('noticeId',n.id,'kind',n.kind,'attempt',n.attempts));
 END IF;
 RETURN jsonb_build_object('decision','send','attempt',n.attempts,
  'firstAttemptAt',to_char(n.first_attempt_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
END $$;

-- Record the result of a claimed attempt. Outcomes: sent | failed | unknown | unresolved (manual review).
CREATE OR REPLACE FUNCTION public.payment_notice_finish(p_id uuid,p_attempt integer,p_outcome text,
 p_provider_message_id text DEFAULT NULL,p_error_code text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n payment_notices;
BEGIN
 IF p_outcome IS NULL OR p_outcome NOT IN ('sent','failed','unknown','unresolved')
  OR p_outcome='sent' AND p_provider_message_id IS NULL
 THEN RAISE EXCEPTION 'PAYMENT_NOTICE_INPUT_INVALID' USING ERRCODE='23514';END IF;
 SELECT * INTO n FROM payment_notices WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','gone');END IF;
 IF p_outcome='unresolved' THEN
  IF n.state NOT IN ('unknown','sending') OR n.attempts<>p_attempt THEN
   RETURN jsonb_build_object('state',n.state,'stale',true);END IF;
  UPDATE payment_notices SET state='manual',manual_reason='unknown_unresolved',lease_expires_at=NULL,
   last_error_code=coalesce(p_error_code,last_error_code),updated_at=now() WHERE id=n.id RETURNING * INTO n;
  RETURN jsonb_build_object('state',n.state);
 END IF;
 -- Only the attempt that holds the claim may record a result; a late answer from an older attempt
 -- after a newer claim (or after erasure skipped it) is ignored, except that a delivery is never lost.
 IF n.attempts<>p_attempt OR n.state NOT IN ('sending','unknown') THEN
  IF p_outcome='sent' AND n.state IN ('sending','unknown','manual','failed') THEN
   UPDATE payment_notices SET state='sent',manual_reason=NULL,sent_at=now(),provider_message_id=p_provider_message_id,
    lease_expires_at=NULL,updated_at=now() WHERE id=n.id RETURNING * INTO n;
  END IF;
  RETURN jsonb_build_object('state',n.state,'stale',true);
 END IF;
 UPDATE payment_notices SET state=p_outcome,
  sent_at=CASE WHEN p_outcome='sent' THEN now() END,
  provider_message_id=CASE WHEN p_outcome='sent' THEN p_provider_message_id ELSE provider_message_id END,
  last_error_code=CASE WHEN p_outcome='sent' THEN NULL ELSE coalesce(p_error_code,last_error_code) END,
  lease_expires_at=NULL,updated_at=now()
 WHERE id=n.id RETURNING * INTO n;
 RETURN jsonb_build_object('state',n.state,'attempts',n.attempts);
END $$;

-- Hold a row without an attempt: keep it pending (e.g. sending not configured yet, recorded only) or
-- skip it for good (no address, account closing, not on the staging test list, superseded).
CREATE OR REPLACE FUNCTION public.payment_notice_hold(p_id uuid,p_state text,p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n payment_notices;
BEGIN
 IF p_state IS NULL OR p_state NOT IN ('pending','skipped') OR p_code IS NULL OR p_code !~ '^[A-Za-z0-9_.:-]{1,80}$'
 THEN RAISE EXCEPTION 'PAYMENT_NOTICE_INPUT_INVALID' USING ERRCODE='23514';END IF;
 UPDATE payment_notices SET state=p_state,last_error_code=p_code,updated_at=now()
 WHERE id=p_id AND (state='pending' OR p_state='skipped' AND state='failed') RETURNING * INTO n;
 IF NOT FOUND THEN RETURN jsonb_build_object('held',false);END IF;
 RETURN jsonb_build_object('held',true,'state',n.state);
END $$;

-- Admin list: rows that need a human. The recipient is shown to the admin, never stored on the row.
CREATE OR REPLACE FUNCTION public.payment_notice_admin_list(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_actor IS NULL OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor AND role='admin'
  AND status='active' AND is_deleted::text='false')
 THEN RAISE EXCEPTION 'PAYMENT_NOTICE_ACTOR_DENIED' USING ERRCODE='42501';END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',x.id,'kind',x.kind,'state',x.state,
  'manualReason',x.manual_reason,'attempts',x.attempts,'lastErrorCode',x.last_error_code,'userEmail',x.email,
  'createdAt',to_char(x.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'firstAttemptAt',to_char(x.first_attempt_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'resendable',x.resendable) ORDER BY x.updated_at DESC,x.id)
  FROM (SELECT n.*,p.email,payment_notice_resendable(n) resendable FROM payment_notices n
   LEFT JOIN profiles p ON p.id=n.user_id
   WHERE n.state IN ('sending','failed','unknown','manual') ORDER BY n.updated_at DESC LIMIT 200) x),'[]'::jsonb);
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace
  WHERE s.nspname='public' AND p.proname LIKE 'payment\_notice\_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  IF split_part(f::text,'(',1)<>'payment_notice_resendable' THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);END IF;
 END LOOP;
END $$;

-- Account erasure: the rows hold no body or address, and go with the account (PAY-NOTIFY §4.2).
DO $$
DECLARE source text; needle text; replacement text; sig text;
BEGIN
 FOR sig,needle,replacement IN SELECT * FROM (VALUES
  ('erasure_business_owner(text,jsonb)', E' CASE\n', E' CASE\n WHEN t=''payment_notices'' THEN RETURN (j->>''user_id'')::uuid;\n'),
  ('account_erasure_prune_business(uuid,integer)', E' FOREACH t IN ARRAY ARRAY[\n',
   E' FOREACH t IN ARRAY ARRAY[\n  ''payment_notices'',\n'),
  ('account_erasure_business_remaining(uuid)', ' SELECT ',
   E' SELECT (SELECT count(*) FROM public.payment_notices WHERE user_id=p_profile_id)+')
 ) changes(signature,anchor,patch) LOOP
  source:=pg_get_functiondef(('public.'||sig)::regprocedure);
  IF position('-- PAY-NOTIFY erasure' IN source)=0 THEN
   IF length(source)-length(replace(source,needle,''))<>length(needle) THEN
    RAISE EXCEPTION 'PAYMENT_NOTICE_ERASURE_SOURCE_MISMATCH: %',sig; END IF;
   EXECUTE replace(source,needle,E' -- PAY-NOTIFY erasure\n'||replacement);
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.erasure_business_owner(text,jsonb),public.account_erasure_prune_business(uuid,integer),
 public.account_erasure_business_remaining(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- ADMIN-SECRETS: the Resend API key is a business third-party key entered in the admin (Owner 2026-10-14).
ALTER TABLE public.platform_secrets DROP CONSTRAINT IF EXISTS platform_secrets_slot_check;
ALTER TABLE public.platform_secrets ADD CONSTRAINT platform_secrets_slot_check
 CHECK (slot IN ('openrouter','postforme','postforme_webhook','tikhub','parallel','firecrawl','resend'));
DO $$
DECLARE source text; sig text; list text:='''firecrawl'''; total integer;
BEGIN
 FOREACH sig IN ARRAY ARRAY['platform_secret_check(text,uuid,bigint)','platform_secret_status()','platform_secret_read(text)'] LOOP
  source:=pg_get_functiondef(('public.'||sig)::regprocedure);
  IF position('''resend''' IN source)=0 THEN
   total:=(length(source)-length(replace(source,list||')',''))+length(source)-length(replace(source,list||']','')))
    /(length(list)+1);
   IF total<>1 THEN RAISE EXCEPTION 'PAYMENT_NOTICE_SECRET_SOURCE_MISMATCH: %',sig;END IF;
   EXECUTE replace(replace(source,list||')',list||',''resend'')'),list||']',list||',''resend'']');
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.platform_secret_check(text,uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.platform_secret_status(),public.platform_secret_read(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.platform_secret_status(),public.platform_secret_read(text) TO service_role;
COMMIT;
