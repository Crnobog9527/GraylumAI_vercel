-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Local verification / empty-fact recovery only. Erased bodies cannot be restored.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.account_erasure_requests WHERE profile_scrubbed_at IS NOT NULL
  OR local_cleaned_at IS NOT NULL OR storage_verified_at IS NOT NULL OR auth_delete_started_at IS NOT NULL
  OR auth_deleted_at IS NOT NULL OR progress_token_hash IS NOT NULL)
  OR EXISTS(SELECT 1 FROM public.payment_orders WHERE request_erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM public.ticket_upload_intents) THEN
  RAISE EXCEPTION 'ERASURE_COMPLETION_ROLLBACK_REQUIRES_FORWARD_FIX';
 END IF;
END $$;
DO $$
DECLARE original text:=pg_get_functiondef('public.pay_common_frozen_guard()'::regprocedure);
 addition text:=$patch$  IF TG_TABLE_NAME='payment_orders' AND public.erasure_envelope_transition(prior,incoming) THEN
    RETURN NEW;
  END IF;
$patch$;
BEGIN
 IF length(original)-length(replace(original,addition,''))<>length(addition) THEN
  RAISE EXCEPTION 'ERASURE_COMPLETION_ROLLBACK_SOURCE_MISMATCH';
 END IF;
 EXECUTE replace(original,addition,'');
END $$;
DROP TRIGGER aa_erasure_envelope_guard ON public.payment_orders;
DROP TRIGGER account_erasure_identity_guard ON public.profiles;
DROP TRIGGER account_erasure_ticket_guard ON public.tickets;
DROP TRIGGER account_erasure_ticket_guard ON public.ticket_replies;
DROP FUNCTION public.account_erasure_auth_begin(uuid,uuid),public.account_erasure_auth_result(uuid,uuid,boolean),
 public.account_erasure_local_cleanup(uuid,boolean),public.account_erasure_local_remaining(uuid),
 public.account_erasure_work_batch(uuid,integer,uuid),public.account_erasure_financial_proof(uuid),
 public.account_erasure_body_remaining(uuid),public.account_erasure_assert_closed(uuid),
 public.account_erasure_identity_guard(),public.account_erasure_ticket_guard(),public.account_erasure_storage_ready(uuid),
 public.account_erasure_progress_issue(uuid,uuid,text),public.account_erasure_progress_read(uuid,text),
 public.erasure_payment_terminal(jsonb),public.erasure_payment_envelope(jsonb,text),public.erasure_envelope_transition(jsonb,jsonb),public.erasure_envelope_guard();
ALTER TABLE public.payment_orders DROP COLUMN request_erased_at;
ALTER TABLE public.account_erasure_requests
 DROP COLUMN profile_scrubbed_at,DROP COLUMN local_cleaned_at,DROP COLUMN storage_verified_at,
 DROP COLUMN auth_delete_started_at,DROP COLUMN auth_deleted_at,DROP COLUMN review_codes,DROP COLUMN next_review_at,
 DROP COLUMN progress_token_hash,DROP COLUMN progress_expires_at;
DROP FUNCTION public.ticket_upload_begin(uuid,uuid),public.ticket_upload_finish(uuid,uuid,boolean);
DROP TABLE public.ticket_upload_intents;
COMMIT;
