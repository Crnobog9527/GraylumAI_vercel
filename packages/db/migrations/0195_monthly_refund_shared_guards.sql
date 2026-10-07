-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION public.monthly_refund_account_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE uid uuid;i jsonb;
BEGIN
 uid:=(to_jsonb(NEW)->>CASE WHEN TG_TABLE_NAME='profiles' THEN 'id' ELSE 'user_id' END)::uuid;
 SELECT refund_approval INTO i FROM payment_orders WHERE user_id=uid
 AND refund_approval->>'kind'='monthly_first_purchase' AND refund_approval->>'hold'='held' LIMIT 1;
 IF i IS NOT NULL AND current_setting('pay_common.monthly_transition',true) IS DISTINCT FROM i->>'id' THEN
  IF TG_TABLE_NAME='profiles' THEN
   IF NEW.membership_level IS DISTINCT FROM OLD.membership_level THEN RAISE EXCEPTION 'PAY_MONTHLY_SOURCE_HELD'; END IF;
  ELSIF NEW.item_type='membership_plan' THEN RAISE EXCEPTION 'PAY_MONTHLY_SOURCE_HELD'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS monthly_refund_account_guard ON public.profiles;
CREATE TRIGGER monthly_refund_account_guard BEFORE UPDATE ON public.profiles
 FOR EACH ROW EXECUTE FUNCTION public.monthly_refund_account_guard();
DROP TRIGGER IF EXISTS monthly_refund_account_guard ON public.payment_orders;
CREATE TRIGGER monthly_refund_account_guard BEFORE INSERT ON public.payment_orders
 FOR EACH ROW EXECUTE FUNCTION public.monthly_refund_account_guard();

-- Durable original renewal observation permits account closure after confirmed stop;
-- it never converts a timeout into a successful stop or a new approval.
CREATE OR REPLACE FUNCTION public.pay_common_monthly_refund_observe(
 p_actor uuid,p_order uuid,p_intent uuid,p_evidence jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i jsonb;t jsonb;sub jsonb;
BEGIN
 IF p_actor IS NOT NULL THEN PERFORM monthly_refund_assert_admin(p_actor); END IF;
 i:=monthly_refund_lock(p_order,p_intent);t:=i->'terms';
 PERFORM monthly_refund_observation(i,p_evidence);sub:=p_evidence->'subscription';
 IF i->>'hold' IS DISTINCT FROM 'held' THEN RETURN i; END IF;
 IF sub->>'cancelAtPeriodEnd'='true' AND sub->>'renewalOwnership'=
  (CASE WHEN t->>'originalCancelAtPeriodEnd'='true' THEN 'original' ELSE 'intent' END) THEN
  PERFORM set_config('pay_common.monthly_transition',p_intent::text,true);
  UPDATE user_subscriptions SET cancel_at_period_end='true' WHERE id=(t->>'subscriptionId')::uuid;
  PERFORM set_config('pay_common.monthly_transition','',true);
 END IF;
 RETURN i;
END $$;

-- Approval JSON is never erased or sanitized. Only this exact terminal financial
-- shape is accepted as accounted-for; legacy and unknown JSON still requires review.
CREATE OR REPLACE FUNCTION public.monthly_refund_erasure_safe(i jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE allowed text[]:=ARRAY['kind','id','status','terms','versionHash','localVersion','approvedBy','approvedAt',
 'claimedAt','started','recordedRefund','hold','revision','idempotencyKey','finishedAt'];t jsonb;
BEGIN
 IF i IS NULL OR jsonb_typeof(i)<>'object' OR i->>'kind' IS DISTINCT FROM 'monthly_first_purchase'
 OR i->>'status' IS NULL OR i->>'status' NOT IN ('succeeded','failed') OR i->>'finishedAt' IS NULL
 OR i->>'claimedAt' IS NULL OR i->>'idempotencyKey' IS DISTINCT FROM 'pay-common:monthly-refund:'|| (i->>'id') ||':refund'
 OR i->>'versionHash' !~ '^[a-f0-9]{64}$' OR i->>'localVersion' !~ '^[a-f0-9]{32}$'
 OR i-allowed<>'{}'::jsonb THEN RETURN false; END IF;
 IF NOT i ?& allowed OR erasure_ledger_value(i,$shape${"kind":"id","id":"id","status":"id","versionHash":"id","localVersion":"id","approvedBy":"id","approvedAt":"id","claimedAt":"id","hold":"id","idempotencyKey":"id","finishedAt":"id","terms":{"kind":"id","orderId":"id","userId":"id","ticketId":"id","subscriptionId":"id","providerSubscriptionId":"id","paymentIntentId":"id","chargeId":"id","invoiceId":"id","merchant":"id","mode":"id","currency":"id","plan":"id","paidAt":"id","submittedAt":"id","periodEnd":"id","feePermitted":"id","feeEvidence":"id","paidMinor":"number","basisMinor":"number","feeMinor":"number","netMinor":"number","credits":"number","originalCancelAtPeriodEnd":"boolean","evidenceRefs":["id"],"snapshot":{"item_type":"id","item_id":"id","item_updated_at":"id","billing_cycle":"id","currency":"id","unit":"id","tax_behavior":"id","version":"number","price":"number","discount":"number","credits":"number","bonus_credits":"number"}},"revision":"number","started":{"stop_renewal":"id","refund":"id","cancel":"id","restore_renewal":"id"},"recordedRefund":{"id":"id","status":"id"}}$shape$::jsonb) IS DISTINCT FROM i THEN RETURN false; END IF;
 t:=i->'terms';
 IF t IS NULL OR jsonb_typeof(t)<>'object' OR t-ARRAY['kind','orderId','userId','ticketId','subscriptionId',
 'providerSubscriptionId','paymentIntentId','chargeId','invoiceId','merchant','mode','currency','plan','paidAt','submittedAt',
 'periodEnd','originalCancelAtPeriodEnd','paidMinor','basisMinor','feeMinor','netMinor','credits','feePermitted',
 'feeEvidence','evidenceRefs','snapshot']<>'{}'::jsonb THEN RETURN false; END IF;
 IF (i->'started')-ARRAY['stop_renewal','refund','cancel','restore_renewal']<>'{}'::jsonb
 OR (i->'recordedRefund')-ARRAY['id','status']<>'{}'::jsonb THEN RETURN false; END IF;
 RETURN coalesce((i->>'status'='succeeded' AND i->>'hold'='terminated' AND i->'recordedRefund'->>'status'='succeeded')
 OR (i->>'status'='failed' AND i->>'hold'='released' AND i->'recordedRefund'->>'status' IN ('failed','canceled')),false);
EXCEPTION WHEN others THEN RETURN false;
END $$;
-- Exact bounded replacement of the financial-approval check, leaving all other
-- erasure inventory and completion conditions from the frozen stack untouched.
DO $$
DECLARE original text:=pg_get_functiondef('public.account_erasure_financial_proof(uuid)'::regprocedure);
 needle text:='OR refund_approval IS NOT NULL);';
 replacement text:='OR (refund_approval IS NOT NULL AND NOT monthly_refund_erasure_safe(refund_approval)));';
BEGIN
 IF position(replacement IN original)=0 THEN
  IF length(original)-length(replace(original,needle,''))<>length(needle) THEN RAISE EXCEPTION 'PAY_MONTHLY_ERASURE_SOURCE_MISMATCH'; END IF;
  EXECUTE replace(original,needle,replacement);
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.monthly_refund_account_guard(),public.monthly_refund_erasure_safe(jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.pay_common_monthly_refund_observe(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_common_monthly_refund_observe(uuid,uuid,uuid,jsonb) TO service_role;
COMMIT;
