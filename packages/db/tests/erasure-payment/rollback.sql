-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
BEGIN;
LOCK TABLE public.payment_orders,public.user_subscriptions,public.subscription_credit_grants IN ACCESS EXCLUSIVE MODE;
DO $$ DECLARE t text; present boolean; BEGIN
 FOREACH t IN ARRAY ARRAY['payment_orders','user_subscriptions','subscription_credit_grants'] LOOP
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE metadata_scrubbed_at IS NOT NULL)',t) INTO present;
  IF present THEN RAISE EXCEPTION 'ERASURE_PAYMENT_ROLLBACK_REQUIRES_FORWARD_FIX'; END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['payment_orders','user_subscriptions','subscription_credit_grants'] LOOP
  EXECUTE format('DROP TRIGGER zz_erasure_payment_guard ON public.%I',t);
  EXECUTE format('ALTER TABLE public.%I DROP COLUMN metadata_scrubbed_at',t);
 END LOOP;
END $$;
DROP FUNCTION public.account_erasure_scrub_payment(uuid,text,integer,uuid);
DROP FUNCTION public.erasure_payment_guard();
DROP FUNCTION public.erasure_payment_metadata(jsonb,text);
COMMIT;
