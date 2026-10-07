-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
BEGIN;
LOCK TABLE public.credit_transactions,public.billing_history,public.token_stats,public.ai_usage_logs IN ACCESS EXCLUSIVE MODE;
DO $$ DECLARE t text; present boolean; BEGIN
 FOREACH t IN ARRAY ARRAY['credit_transactions','billing_history','token_stats','ai_usage_logs'] LOOP
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE content_erased_at IS NOT NULL)',t) INTO present;
  IF present THEN RAISE EXCEPTION 'ERASURE_LEDGER_ROLLBACK_REQUIRES_FORWARD_FIX'; END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['credit_transactions','billing_history','token_stats','ai_usage_logs'] LOOP
  EXECUTE format('DROP TRIGGER zz_erasure_ledger_guard ON public.%I',t);
  EXECUTE format('ALTER TABLE public.%I DROP COLUMN content_erased_at',t);
 END LOOP;
END $$;
DROP FUNCTION public.account_erasure_scrub_ledger(uuid,text,integer,uuid);
DROP FUNCTION public.erasure_ledger_guard();
DROP FUNCTION public.erasure_ledger_metadata(jsonb);
DROP FUNCTION public.erasure_ledger_value(jsonb,jsonb);
COMMIT;
