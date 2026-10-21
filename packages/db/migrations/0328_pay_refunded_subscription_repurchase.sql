-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-STRIPE-MP: a successfully refunded, terminated membership may buy again.
-- 0194 monthly_refund_finish writes canceled + credit_release_terminated_at only after refund/cancel
-- completion. A canceled paid term without that timestamp still retains its membership until expiry.
-- Use the canonical termination timestamp, not the reason text (other refund flows use other reasons).
-- Still-chargeable statuses keep blocking even with a contradictory termination marker. The profile,
-- transition, pending-order, account/identity and row-lock checks are unchanged.
-- No rows, signatures or privileges change. Repeatable; abort on an unknown admission body.
-- Recovery: forward-fix this single predicate; never undo a completed refund or delete financial rows.
BEGIN;
SET LOCAL lock_timeout='5s';

DO $patch$
DECLARE source text;
  old_gate constant text:=$old$      AND (s.status IN ('active','trialing','past_due','incomplete','unpaid') OR s.current_period_end>now())$old$;
  new_gate constant text:=old_gate||E'\n      AND (s.status IS DISTINCT FROM ''canceled'' OR s.credit_release_terminated_at IS NULL)';
BEGIN
  source:=pg_get_functiondef(('public.pay_waffo_admit_purchase(uuid,text,uuid,text,text,text,text,text,bigint,text,'
    ||'jsonb,text,uuid)')::regprocedure);
  IF position(new_gate IN source)=0 THEN
    IF array_length(string_to_array(source,old_gate),1)<>2 THEN
      RAISE EXCEPTION 'PAY_REFUNDED_REPURCHASE_GATE_MISMATCH';
    END IF;
    EXECUTE replace(source,old_gate,new_gate);
  END IF;
END $patch$;
COMMIT;
