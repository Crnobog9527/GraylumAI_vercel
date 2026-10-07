-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE: separable payment metadata only; no money or approval state change.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE FUNCTION public.erasure_payment_metadata(v jsonb,t text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE shape jsonb; refund_shape jsonb; k text; rule jsonb; result jsonb:='{}'; blocked integer:=0;
BEGIN
 IF t NOT IN ('payment_orders','user_subscriptions','subscription_credit_grants') OR t IS NULL THEN
  RAISE EXCEPTION 'ERASURE_PAYMENT_TABLE_DENIED';
 END IF;
 IF v IS NULL OR v='null'::jsonb THEN RETURN jsonb_build_object('value',v,'manualReview',0); END IF;
 IF jsonb_typeof(v)<>'object' THEN RETURN jsonb_build_object('value',v,'manualReview',1); END IF;
 refund_shape:=$refund${
 "refundId": "id",
 "eventId": "id",
 "eventType": "id",
 "refundStatus": "id",
 "chargeId": "id",
 "paymentIntentId": "id",
 "invoiceId": "id",
 "subscriptionId": "id",
 "currency": "id",
 "refundCreatedAt": "id",
 "createdAt": "id",
 "reconciledAt": "id",
 "auditedAt": "id",
 "source": "id",
 "idempotencyKey": "id",
 "refundType": "id",
 "clawbackTransactionId": "id",
 "creditTransactionId": "id",
 "reversalStatus": "id",
 "reconciliationStatus": "id",
 "status": "id",
 "reviewReason": {
  "$enum": [
   "invoice_scope_mismatch",
   "invoice_scope_missing",
   "ambiguous_charge_refunded_refund_identity",
   "missing_trusted_refund_timestamp",
   "missing_trusted_term_start",
   "missing_or_invalid_trusted_term",
   "refund_timestamp_precedes_term_start",
   "no_period_window_covers_refund_timestamp",
   "ambiguous_or_overlapping_period_windows",
   "grant_accounting_review_required",
   "legacy_consumption_unproven",
   "noncanonical_monthly_period_window",
   "noncanonical_annual_period_window",
   "term_start_period_anchor_unknown",
   "unexpected_grant_status",
   "missing_event_id",
   "refund_review_required",
   "first_event_reconciliation_evidence_missing"
  ]
 },
 "shortfallReason": {
  "$enum": [
   "insufficient_balance"
  ]
 },
 "locatedPeriodKey": "id",
 "amountRefunded": "number",
 "refundAmount": "number",
 "amount": "number",
 "grantedCredits": "number",
 "clawbackAmount": "number",
 "requiredClawbackAmount": "number",
 "appliedClawbackAmount": "number",
 "shortfallAmount": "number",
 "balanceBefore": "number",
 "balanceAfter": "number",
 "reversedGrantCount": "number",
 "consumedAtReversal": "number",
 "grantedCreditsMetadataGap": {
  "$enum": [
   "missing_grantedCredits",
   "invalid_grantedCredits"
  ]
 },
 "isFullRefund": "boolean",
 "fullRefund": "boolean",
 "failed": "boolean",
 "clawbackApplied": "boolean",
 "reviewRequired": "boolean",
 "refundIdentityAmbiguous": "boolean",
 "noPreciseRefundSelected": "boolean",
 "alreadyReconciled": "boolean",
 "alreadyReversed": "boolean",
 "alreadyTerminated": "boolean",
 "creditClawbackApplied": "boolean",
 "grantReversalApplied": "boolean",
 "termination": {
  "written": "boolean",
  "terminatedAt": "id",
  "eventId": "id",
  "reason": {
   "$enum": [
    "stripe_refund",
    "stripe_refund:refund",
    "stripe_refund:refund.created",
    "stripe_refund:refund.updated",
    "stripe_refund:refund.failed",
    "stripe_refund:charge.refund.updated",
    "stripe_refund:charge.refunded"
   ]
  }
 }
}$refund$::jsonb;
 shape:=CASE t WHEN 'payment_orders' THEN $order${
 "source": "id",
 "transactionId": "id",
 "subscriptionCreditGrantId": "id",
 "fulfillmentSource": "id",
 "checkoutStatus": "id",
 "paymentStatus": "id",
 "lastPaymentOrderStatus": "id",
 "lastPaymentOrderStatusAt": "id",
 "previousMembershipPlanId": "id",
 "previousBillingCycle": "id",
 "upgradeExecution": "id",
 "refundReconciliationSource": "id",
 "orderId": "id",
 "userId": "id",
 "itemId": "id",
 "itemType": "id",
 "billingCycle": "id",
 "priceId": "id",
 "upgradeAttemptId": "id",
 "paymentIntentId": "id",
 "stripePaymentIntentId": "id",
 "payment_intent": "id",
 "stripe_payment_intent_id": "id",
 "chargeId": "id",
 "stripeChargeId": "id",
 "charge_id": "id",
 "stripe_charge_id": "id",
 "refundId": "id",
 "stripeRefundId": "id",
 "refund_id": "id",
 "stripe_refund_id": "id",
 "grantedCredits": "number",
 "requoteRequired": "boolean",
 "upgradeAttempt": {
  "originalPrice": "id",
  "itemId": "id",
  "createdAt": "number",
  "quote": {
   "amountDue": "number",
   "currency": "id",
   "quotedAt": "number",
   "fingerprint": "id",
   "freshnessProof": "id"
  },
  "stripeMetadata": {
   "orderId": "id",
   "userId": "id",
   "itemId": "id",
   "itemType": "id",
   "billingCycle": "id",
   "priceId": "id",
   "upgradeAttemptId": "id"
  }
 },
 "stripeRefund": "$refund",
 "stripeRefundReconciliation": "$refund",
 "subscriptionCreditGrantReversal": "$refund",
 "refundReconciliation": "$refund",
 "refund": "$refund",
 "lastRefundEvent": "$refund",
 "lastRefundFailure": "$refund",
 "stripeRefundWebhookAudit": "$refund",
 "refundExecutionUnmatchedEvent": "$refund",
 "invoiceFailure": {
  "invoiceId": "id",
  "status": "id"
 },
 "syncCheckoutSessionFulfillment": {
  "status": "id",
  "reason": {
   "$enum": [
    "paid_invoice_missing",
    "paid_invoice_unpaid",
    "checkout_subscription_missing",
    "subscription_retrieve_failed",
    "subscription_unavailable",
    "invoice_resolution_failed",
    "membership_invoice_fulfillment_failed",
    "subscription_state_sync_failed",
    "sync_checkout_failed"
   ]
  }
 }
}$order$::jsonb
 WHEN 'user_subscriptions' THEN $sub${
 "lastInvoiceId": "id",
 "adminOverride": {
  "adminId": "id",
  "overriddenAt": "id",
  "previousLevel": "id",
  "newLevel": "id"
 }
}$sub$::jsonb
 ELSE $grant${
 "sourceType": "id",
 "sourceId": "id",
 "reversal": {
  "refundId": "id",
  "eventId": "id",
  "subscriptionId": "id",
  "periodKey": "id",
  "idempotencyKey": "id",
  "reversedAt": "id",
  "source": "id"
 }
}$grant$::jsonb END;
 FOR k,rule IN SELECT * FROM jsonb_each(shape) LOOP
  IF NOT v ? k THEN CONTINUE; END IF;
  IF rule='"$refund"'::jsonb THEN rule:=refund_shape; END IF;
  IF t='user_subscriptions' AND k='adminOverride' AND jsonb_typeof(v->k)='boolean' THEN
   rule:='"boolean"'::jsonb;
  END IF;
  BEGIN
   result:=result||jsonb_build_object(k,erasure_ledger_value(v->k,rule));
  EXCEPTION WHEN raise_exception THEN
   IF SQLERRM<>'ERASURE_LEDGER_INVALID_EVIDENCE' THEN RAISE; END IF;
   -- Preserve the original uncertain financial sub-object; unrelated private keys still clear.
   result:=result||jsonb_build_object(k,v->k);
   blocked:=blocked+1;
  END;
 END LOOP;
 IF t='payment_orders' AND v ? 'paymentConflicts' THEN
  -- Keep append-only evidence byte-for-byte. Do not relax its existing mutation guard.
  result:=result||jsonb_build_object('paymentConflicts',v->'paymentConflicts');
  BEGIN
   IF erasure_ledger_value(v->'paymentConflicts',
    '[{"code":{"$enum":["PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT"]},"evidence_ref":"id",
     "reason":{"$enum":["PAY_COMMON_RECEIPT_MISMATCH","PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH",
      "PAY_COMMON_INVOICE_EVIDENCE_REJECTED"]}}]'::jsonb) IS DISTINCT FROM v->'paymentConflicts'
    OR jsonb_typeof(v->'paymentConflicts') IS DISTINCT FROM 'array'
    OR jsonb_array_length(v->'paymentConflicts')>32 THEN blocked:=blocked+1; END IF;
  EXCEPTION WHEN raise_exception THEN
   IF SQLERRM<>'ERASURE_LEDGER_INVALID_EVIDENCE' THEN RAISE; END IF;
   blocked:=blocked+1;
  END;
 END IF;
 RETURN jsonb_build_object('value',result,'manualReview',blocked);
END $$;
REVOKE ALL ON FUNCTION public.erasure_payment_metadata(jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.erasure_payment_metadata(jsonb,text) TO service_role;

CREATE OR REPLACE FUNCTION public.erasure_payment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE prior jsonb; incoming jsonb:=to_jsonb(NEW); projected jsonb; closed boolean;
BEGIN
 IF TG_TABLE_NAME NOT IN ('payment_orders','user_subscriptions','subscription_credit_grants') THEN
  RAISE EXCEPTION 'ERASURE_PAYMENT_TABLE_DENIED';
 END IF;
 IF TG_OP='UPDATE' THEN prior:=to_jsonb(OLD); END IF;
 IF TG_OP='INSERT' AND incoming->>'metadata_scrubbed_at' IS NOT NULL THEN
  RAISE EXCEPTION 'ERASURE_PAYMENT_IMMUTABLE';
 END IF;
 IF current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
  AND current_user<>'service_role' THEN
  IF incoming->>'metadata_scrubbed_at' IS NOT NULL THEN RAISE EXCEPTION 'ERASURE_PAYMENT_DENIED'; END IF;
  RETURN NEW;
 END IF;
 closed:=EXISTS(SELECT 1 FROM account_erasure_requests e JOIN profiles p ON p.id=e.profile_id
  WHERE e.profile_id=NEW.user_id AND p.status='deleted' AND p.is_deleted='true');
 IF prior->>'metadata_scrubbed_at' IS NOT NULL THEN
  IF incoming->'metadata_scrubbed_at' IS DISTINCT FROM prior->'metadata_scrubbed_at'
   OR incoming->'user_id' IS DISTINCT FROM prior->'user_id' THEN
   RAISE EXCEPTION 'ERASURE_PAYMENT_IMMUTABLE';
  END IF;
 ELSIF TG_OP='UPDATE' AND incoming->>'metadata_scrubbed_at' IS NOT NULL THEN
  IF NOT closed OR current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
   OR (incoming-ARRAY['metadata','metadata_scrubbed_at']) IS DISTINCT FROM
      (prior-ARRAY['metadata','metadata_scrubbed_at']) THEN RAISE EXCEPTION 'ERASURE_PAYMENT_DENIED'; END IF;
 ELSIF NOT closed THEN RETURN NEW;
 END IF;
 projected:=erasure_payment_metadata(NEW.metadata,TG_TABLE_NAME);
 IF TG_OP='UPDATE' AND prior->>'metadata_scrubbed_at' IS NULL AND incoming->>'metadata_scrubbed_at' IS NOT NULL
  AND projected->'value' IS DISTINCT FROM erasure_payment_metadata(OLD.metadata,TG_TABLE_NAME)->'value' THEN
  RAISE EXCEPTION 'ERASURE_PAYMENT_EVIDENCE_CHANGED';
 END IF;
 incoming:=incoming||jsonb_build_object('metadata_scrubbed_at',coalesce(prior->>'metadata_scrubbed_at',
  incoming->>'metadata_scrubbed_at',clock_timestamp()::text));
 incoming:=incoming||jsonb_build_object('metadata',projected->'value');
 NEW:=jsonb_populate_record(NEW,incoming);
 IF projected->'value'='null'::jsonb AND incoming->'metadata' IS NOT NULL THEN
  NEW.metadata:=projected->'value';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.erasure_payment_guard() FROM PUBLIC,anon,authenticated,service_role;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['payment_orders','user_subscriptions','subscription_credit_grants'] LOOP
  EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS metadata_scrubbed_at timestamptz',t);
  EXECUTE format('DROP TRIGGER IF EXISTS zz_erasure_payment_guard ON public.%I',t);
  EXECUTE format('CREATE TRIGGER zz_erasure_payment_guard BEFORE INSERT OR UPDATE ON public.%I
   FOR EACH ROW EXECUTE FUNCTION public.erasure_payment_guard()',t);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.account_erasure_scrub_payment(
 p_profile_id uuid,p_table text,p_limit integer DEFAULT 100,p_after_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item record; projected jsonb; processed integer:=0; manual integer:=0; remaining bigint; last_id uuid;
BEGIN
 IF p_table IS NULL OR p_table<>ALL(ARRAY['payment_orders','user_subscriptions','subscription_credit_grants']) THEN
  RAISE EXCEPTION 'ERASURE_PAYMENT_TABLE_DENIED' USING ERRCODE='42501'; END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'ERASURE_BATCH_LIMIT_INVALID'; END IF;
 IF NOT EXISTS(SELECT 1 FROM account_erasure_requests e JOIN profiles p ON p.id=e.profile_id
  WHERE e.profile_id=p_profile_id AND p.status='deleted' AND p.is_deleted='true') THEN
  RAISE EXCEPTION 'ACCOUNT_ERASURE_NOT_CLOSED' USING ERRCODE='42501'; END IF;
 -- One table per transaction; skip busy rows rather than invert the existing money-path locks.
 FOR item IN EXECUTE format('SELECT id,metadata,metadata_scrubbed_at AS scrubbed_at FROM public.%I WHERE user_id=$1
  AND (metadata_scrubbed_at IS NULL OR (erasure_payment_metadata(metadata,%L)->>''manualReview'')::int>0)
  AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3 FOR UPDATE SKIP LOCKED',p_table,p_table)
  USING p_profile_id,p_after_id,p_limit LOOP
  last_id:=item.id;
  projected:=erasure_payment_metadata(item.metadata,p_table);
  manual:=manual+CASE WHEN (projected->>'manualReview')::int>0 THEN 1 ELSE 0 END;
  EXECUTE format('UPDATE public.%I SET metadata=$2,metadata_scrubbed_at=$3 WHERE id=$1',p_table)
   USING item.id,projected->'value',coalesce(item.scrubbed_at,clock_timestamp());
  processed:=processed+1;
 END LOOP;
 EXECUTE format('SELECT count(*) FROM public.%I WHERE user_id=$1 AND (metadata_scrubbed_at IS NULL
  OR (erasure_payment_metadata(metadata,%L)->>''manualReview'')::int>0)',p_table,p_table)
  INTO remaining USING p_profile_id;
 RETURN jsonb_build_object('processed',processed,'remaining',remaining,'manualReview',manual,'nextRowId',last_id);
END $$;
REVOKE ALL ON FUNCTION public.account_erasure_scrub_payment(uuid,text,integer,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.account_erasure_scrub_payment(uuid,text,integer,uuid) TO service_role;
COMMIT;
