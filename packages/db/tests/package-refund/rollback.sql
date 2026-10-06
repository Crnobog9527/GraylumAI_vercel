-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Empty disposable database only. With any approval or execution, preserve evidence and forward-fix.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM payment_orders WHERE refund_approval IS NOT NULL) THEN
   RAISE EXCEPTION 'PAY_REFUND_ROLLBACK_REQUIRES_FORWARD_FIX';
 END IF;
END $$;
DROP FUNCTION public.pay_common_package_refund_reject(uuid,uuid,uuid,text);
DROP FUNCTION public.pay_common_package_refund_retry(uuid,uuid,uuid,jsonb);
DROP FUNCTION public.pay_common_package_refund_claim(uuid,uuid,uuid,jsonb);
DROP FUNCTION public.pay_common_package_refund_decide(uuid,uuid,uuid,jsonb,text,text,text,text);
DROP FUNCTION public.pay_common_package_refund_quote(uuid,uuid,uuid,jsonb,text,text);
DROP FUNCTION public.pay_common_package_refund_result(uuid,uuid,jsonb);
DROP FUNCTION public.atomic_reconcile_stripe_refund(uuid,text,text,text,text,integer,text,text,text,text,text,text,timestamptz,boolean,boolean);
ALTER FUNCTION public.atomic_reconcile_stripe_refund_before_pr4b(uuid,text,text,text,text,integer,text,text,text,text,text,text,timestamptz,boolean,boolean)
 RENAME TO atomic_reconcile_stripe_refund;
GRANT EXECUTE ON FUNCTION public.atomic_reconcile_stripe_refund(uuid,text,text,text,text,integer,text,text,text,text,text,text,timestamptz,boolean,boolean) TO service_role;
ALTER TABLE public.payment_orders DROP COLUMN refund_approval;
COMMIT;
