-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- INTEGRATION-BASE PR B1 (Owner 2026-11-14: Feishu connector before launch, plan B "作品一键写入飞书多维表格", per-table
-- authorization code, Pro/Gold only). Number 0529 assigned by the controller.
--   * user_connections: one row per (profile, provider) for connectors that need a credential of the user's own (Shotviva does
--     not: it keeps profiles.shotviva_account_id and the partner key). The credential itself is never in this table: it is a
--     Vault secret named graylum.user.<profile>.<provider>; the row keeps its id, its last four characters, the target the
--     credential is for (e.g. the Feishu Base), a label to show, and when it last failed. Written only through the three
--     functions below; the service role may read the row (never the secret) for the status shown on the integrations page.
--     No ON DELETE CASCADE: profiles are kept as shells by erasure, which deletes these rows itself.
--   * user_connection_set / _secret / _delete / _failed: service role only. _failed marks the credential with the given last four
--     as rejected by the provider (the page then asks to reconnect). _set refuses a closed account or one with an erasure
--     request, replaces the secret in place on reconnect; _delete removes the secret and the row (disconnect).
--   * Account erasure: account_erasure_local_cleanup deletes the secrets and rows; account_erasure_local_remaining counts the
--     rows. Both are whole definitions copied from packages/db/functions/erasure and changed only by those lines.
-- Compatibility: additive. Old code never reads the table; the erasure functions behave as before when it is empty.
-- Repeatable: IF NOT EXISTS / CREATE OR REPLACE; grants are idempotent; running it twice changes nothing.
-- Recovery: re-apply the two erasure definitions from packages/db/functions at the staging commit before this migration, then
--   DROP the four functions; the table can stay (nothing else reads it) or be dropped once empty (delete its Vault secrets first).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE IF NOT EXISTS public.user_connections(
 profile_id uuid NOT NULL REFERENCES public.profiles(id),
 provider text NOT NULL CONSTRAINT user_connections_provider_check CHECK (provider IN ('feishu_base')),
 vault_secret_id uuid NOT NULL,
 last4 text NOT NULL CONSTRAINT user_connections_last4_check CHECK (char_length(last4)=4),
 target jsonb NOT NULL DEFAULT '{}'::jsonb
  CONSTRAINT user_connections_target_check CHECK (jsonb_typeof(target)='object' AND octet_length(target::text)<=2048),
 label text CONSTRAINT user_connections_label_check CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 200),
 failed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(profile_id,provider)
);
ALTER TABLE public.user_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_connections FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.user_connections TO service_role;

CREATE OR REPLACE FUNCTION public.user_connection_set(p_profile_id uuid, p_provider text, p_secret text, p_target jsonb,
 p_label text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r user_connections; sid uuid; vname text;
BEGIN
 IF p_profile_id IS NULL OR p_provider IS NULL OR p_provider NOT IN ('feishu_base')
 THEN RAISE EXCEPTION 'CONNECTION_INPUT_INVALID' USING ERRCODE='23514'; END IF;
 -- Printable ASCII without spaces, 16-1024 characters.
 IF p_secret IS NULL OR char_length(p_secret)<16 OR char_length(p_secret)>1024 OR p_secret !~ '^[!-~]+$'
 THEN RAISE EXCEPTION 'CONNECTION_INPUT_INVALID' USING ERRCODE='23514'; END IF;
 IF p_target IS NULL OR jsonb_typeof(p_target)<>'object' OR octet_length(p_target::text)>2048
  OR (p_label IS NOT NULL AND char_length(p_label) NOT BETWEEN 1 AND 200)
 THEN RAISE EXCEPTION 'CONNECTION_INPUT_INVALID' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_profile_id AND status='active' AND is_deleted::text='false')
  OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=p_profile_id)
 THEN RAISE EXCEPTION 'CONNECTION_ACCOUNT_CLOSED' USING ERRCODE='PT403'; END IF;
 IF to_regclass('vault.secrets') IS NULL
 THEN RAISE EXCEPTION 'CONNECTION_VAULT_MISSING' USING ERRCODE='55000'; END IF;
 vname:='graylum.user.'||p_profile_id||'.'||p_provider;
 SELECT * INTO r FROM user_connections WHERE profile_id=p_profile_id AND provider=p_provider FOR UPDATE;
 IF FOUND AND EXISTS(SELECT 1 FROM vault.secrets WHERE id=r.vault_secret_id) THEN
  PERFORM vault.update_secret(r.vault_secret_id,p_secret);
  sid:=r.vault_secret_id;
 ELSE
  -- A leftover entry under our name is replaced, never reused blindly.
  DELETE FROM vault.secrets WHERE name=vname;
  sid:=vault.create_secret(p_secret,vname,'Graylum user connector credential');
 END IF;
 INSERT INTO user_connections(profile_id,provider,vault_secret_id,last4,target,label)
 VALUES(p_profile_id,p_provider,sid,right(p_secret,4),p_target,p_label)
 ON CONFLICT(profile_id,provider) DO UPDATE SET vault_secret_id=EXCLUDED.vault_secret_id,last4=EXCLUDED.last4,
  target=EXCLUDED.target,label=EXCLUDED.label,failed_at=NULL,updated_at=now();
 RETURN jsonb_build_object('provider',p_provider,'last4',right(p_secret,4),'target',p_target,'label',p_label);
END $function$;

CREATE OR REPLACE FUNCTION public.user_connection_secret(p_profile_id uuid, p_provider text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE sid uuid; v text;
BEGIN
 IF p_profile_id IS NULL OR p_provider IS NULL OR p_provider NOT IN ('feishu_base')
 THEN RAISE EXCEPTION 'CONNECTION_INPUT_INVALID' USING ERRCODE='23514'; END IF;
 SELECT vault_secret_id INTO sid FROM user_connections WHERE profile_id=p_profile_id AND provider=p_provider;
 IF sid IS NULL THEN RETURN NULL; END IF;
 IF to_regclass('vault.decrypted_secrets') IS NULL
 THEN RAISE EXCEPTION 'CONNECTION_VAULT_MISSING' USING ERRCODE='55000'; END IF;
 SELECT decrypted_secret INTO v FROM vault.decrypted_secrets WHERE id=sid;
 IF v IS NULL THEN RAISE EXCEPTION 'CONNECTION_VAULT_ENTRY_MISSING' USING ERRCODE='55000'; END IF;
 RETURN v;
END $function$;

CREATE OR REPLACE FUNCTION public.user_connection_delete(p_profile_id uuid, p_provider text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r user_connections;
BEGIN
 IF p_profile_id IS NULL OR p_provider IS NULL OR p_provider NOT IN ('feishu_base')
 THEN RAISE EXCEPTION 'CONNECTION_INPUT_INVALID' USING ERRCODE='23514'; END IF;
 DELETE FROM user_connections WHERE profile_id=p_profile_id AND provider=p_provider RETURNING * INTO r;
 IF NOT FOUND THEN RETURN false; END IF;
 IF to_regclass('vault.secrets') IS NOT NULL THEN
  EXECUTE 'DELETE FROM vault.secrets WHERE id=$1' USING r.vault_secret_id;
 END IF;
 RETURN true;
END $function$;

CREATE OR REPLACE FUNCTION public.user_connection_failed(p_profile_id uuid, p_provider text, p_last4 text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF p_profile_id IS NULL OR p_provider IS NULL OR p_provider NOT IN ('feishu_base') OR p_last4 IS NULL
 THEN RAISE EXCEPTION 'CONNECTION_INPUT_INVALID' USING ERRCODE='23514'; END IF;
 -- Only the credential that failed: a newer one entered meanwhile (different last four) stays as it is.
 UPDATE user_connections SET failed_at=now(),updated_at=now()
  WHERE profile_id=p_profile_id AND provider=p_provider AND last4=p_last4 AND failed_at IS NULL;
 RETURN FOUND;
END $function$;

REVOKE ALL ON FUNCTION public.user_connection_set(uuid,text,text,jsonb,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.user_connection_secret(uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.user_connection_delete(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.user_connection_set(uuid,text,text,jsonb,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.user_connection_secret(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.user_connection_delete(uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.user_connection_failed(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.user_connection_failed(uuid,text,text) TO service_role;

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
 -- INTEGRATION-BASE: the user's connector secrets (Vault) go first, then their connection rows.
 IF EXISTS(SELECT 1 FROM user_connections WHERE profile_id=p_profile_id) THEN
  DELETE FROM vault.secrets WHERE id IN (SELECT vault_secret_id FROM user_connections WHERE profile_id=p_profile_id);
  DELETE FROM user_connections WHERE profile_id=p_profile_id;
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
 +(SELECT count(*) FROM user_connections WHERE profile_id=p_profile_id) /* INTEGRATION-BASE */
 +(SELECT count(*) FROM profiles WHERE id=p_profile_id AND
   (email IS NOT NULL OR phone IS NOT NULL OR nickname IS NOT NULL OR avatar_url IS NOT NULL OR last_ip IS NOT NULL
    OR last_login_at IS NOT NULL OR shotviva_account_id IS NOT NULL /* INTEGRATION-SHOTVIVA */));
$function$;

COMMIT;
