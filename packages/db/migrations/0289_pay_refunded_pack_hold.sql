-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-DISPUTE-GUARD refund hold (Owner 2026-10-17, #1038 option A): a credit pack refunded outside Graylum
-- without a clawback (0247 external refund "pack_review": order refunded, credits left in the balance for a person
-- to settle) is held out of the spendable balance until that person settles it, exactly like the unused remainder
-- of a terminated subscription period (0061 atomic_pre_deduct, 0162 bill2_payg_claim): a reservation that needs
-- the held credits is refused the existing way (PRE_DEDUCT_TERMINATED_GRANT_REMAINDER_QUARANTINED / waiting_credits).
-- Held amount = the pack source's unused credits (0275 credit_package_sources); other sources are never touched.
-- A source whose remainder cannot be proven (0275 credit_source_reviews, "source unknown") is alert-only, never
-- held or clawed back from the balance (PAY-DISPUTE-GUARD 4.3: never use other sources' credits in its place).
-- Settlement (service role, by an active admin): "clawback" takes the unused credits back once, never below zero
-- (the shortfall is Graylum's and is in the ledger); "kept" leaves them as ordinary balance (Graylum keeps the loss).
-- Either way the hold ends, the decision is final and a repeat is a no-op.
-- Repeatable: column IF NOT EXISTS, functions CREATE OR REPLACE, source edits guarded by a marker.
-- Recovery: restore 0275 credit_source_rows and the predecessor bodies without the marked lines; the review
-- columns are then unused and kept (financial records are never dropped).
BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE public.credit_package_sources
 ADD COLUMN IF NOT EXISTS refund_review text CONSTRAINT credit_package_sources_refund_review CHECK(refund_review IN ('clawback','kept')),
 ADD COLUMN IF NOT EXISTS refund_reviewed_at timestamptz,
 ADD COLUMN IF NOT EXISTS refund_reviewed_by uuid;

-- Unused credits of the user's packs that ended refunded without a clawback and are not settled yet
-- (source-unknown packs excluded).
-- Callers hold the profile lock (the same lock the refund and the settlement take first).
CREATE OR REPLACE FUNCTION public.credit_package_refund_hold(p_user uuid) RETURNS integer
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce(sum(greatest(s.credits_granted-s.consumed_amount,0)),0)::integer
 FROM credit_package_sources s JOIN payment_orders o ON o.id=s.order_id
 WHERE s.user_id=p_user AND s.status='granted' AND s.refund_review IS NULL
  AND o.status IN ('refunded','partially_refunded')
  AND NOT EXISTS(SELECT 1 FROM credit_source_reviews r WHERE r.source_kind='credit_package' AND r.source_id=s.id)
$$;

-- 0275 body with one change: a settled or source-unknown refunded pack is no longer held back. "kept" credits are then ordinary
-- (unattributed) balance; a refunded order is still never consumed from or restored to (credit_source_apply).
CREATE OR REPLACE FUNCTION public.credit_source_rows(p_user uuid)
RETURNS TABLE(kind text,id uuid,remaining integer,since timestamptz,current_period boolean,usable boolean,held boolean)
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM subscription_credit_grants g WHERE g.user_id=p_user ORDER BY g.id FOR UPDATE;
 PERFORM 1 FROM credit_package_sources s WHERE s.user_id=p_user ORDER BY s.id FOR UPDATE;
 RETURN QUERY
 WITH grants AS (
  SELECT g.id,g.credits_granted-g.consumed_amount AS left_,g.period_start,
   g.period_start<=clock_timestamp() AND g.period_end>clock_timestamp() AS covering,
   EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=g.user_id
    AND (s.id=g.subscription_id OR s.stripe_subscription_id=g.stripe_subscription_id)
    AND s.credit_release_terminated_at IS NOT NULL)
   OR (g.subscription_id IS NOT NULL AND EXISTS(SELECT 1 FROM payment_orders o WHERE o.subscription_id=g.subscription_id
    AND o.refund_approval->>'kind'='monthly_first_purchase' AND o.refund_approval->>'hold' IN ('held','terminated'))) AS blocked,
   EXISTS(SELECT 1 FROM credit_source_reviews r WHERE r.source_kind='subscription_grant' AND r.source_id=g.id) AS unknown
  FROM subscription_credit_grants g
  WHERE g.user_id=p_user AND g.status='granted' AND g.accounting_state='trusted' AND g.credits_granted>g.consumed_amount)
 SELECT 'subscription_grant',x.id,x.left_,x.period_start,x.covering,NOT x.blocked AND NOT x.unknown,x.blocked FROM grants x
 UNION ALL
 -- A pack whose order ended as refunded without a clawback (0247 external refund "pack_review")
 -- keeps its credits in the balance for a person to settle: held back, never consumed or restored to.
 SELECT 'credit_package',p.id,p.left_,p.granted_at,false,NOT p.refunded AND NOT p.unknown,
  p.refunded AND p.refund_review IS NULL AND NOT p.unknown FROM (
  SELECT s.id,s.credits_granted-s.consumed_amount AS left_,s.granted_at,s.refund_review,
   EXISTS(SELECT 1 FROM payment_orders o WHERE o.id=s.order_id AND o.status IN ('refunded','partially_refunded')) AS refunded,
   EXISTS(SELECT 1 FROM credit_source_reviews r WHERE r.source_kind='credit_package' AND r.source_id=s.id) AS unknown
  FROM credit_package_sources s WHERE s.user_id=p_user AND s.status='granted' AND s.credits_granted>s.consumed_amount) p;
END $$;

-- A person settles one held pack. Profile first, then order, then source: the lock order of 0247.
CREATE OR REPLACE FUNCTION public.pay_common_pack_refund_review_settle(p_actor uuid,p_order uuid,p_decision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE owner profiles; o payment_orders; s credit_package_sources; unused integer; taken integer:=0;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor AND role='admin' AND status='active' AND is_deleted='false') THEN
  RAISE EXCEPTION 'PAY_PACK_REVIEW_ADMIN_REQUIRED'; END IF;
 IF p_decision IS NULL OR p_decision NOT IN ('clawback','kept') THEN RAISE EXCEPTION 'PAY_PACK_REVIEW_DECISION'; END IF;
 SELECT * INTO owner FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=p_order) FOR UPDATE;
 SELECT * INTO o FROM payment_orders WHERE id=p_order FOR UPDATE;
 SELECT * INTO s FROM credit_package_sources WHERE order_id=p_order FOR UPDATE;
 IF owner.id IS NULL OR o.id IS NULL OR s.id IS NULL OR o.item_type IS DISTINCT FROM 'credit_package' THEN
  RAISE EXCEPTION 'PAY_PACK_REVIEW_UNKNOWN'; END IF;
 IF s.refund_review IS NOT NULL THEN
  IF s.refund_review<>p_decision THEN RAISE EXCEPTION 'PAY_PACK_REVIEW_CONFLICT'; END IF;
  RETURN jsonb_build_object('decision',s.refund_review,'duplicate',true,'userId',o.user_id,
   'creditsTakenBack',coalesce((o.metadata->'packRefundReview'->>'creditsTakenBack')::integer,0),
   'creditsShortfall',coalesce((o.metadata->'packRefundReview'->>'creditsShortfall')::integer,0));
 END IF;
 IF s.status<>'granted' OR o.status NOT IN ('refunded','partially_refunded') THEN RAISE EXCEPTION 'PAY_PACK_REVIEW_NOT_HELD'; END IF;
 unused:=greatest(s.credits_granted-s.consumed_amount,0);
 -- Its recorded remainder is not trusted: taking it from the balance could take other sources' credits.
 IF p_decision='clawback' AND EXISTS(SELECT 1 FROM credit_source_reviews r WHERE r.source_kind='credit_package' AND r.source_id=s.id)
  THEN RAISE EXCEPTION 'PAY_PACK_REVIEW_SOURCE_UNKNOWN'; END IF;
 IF p_decision='clawback' THEN
  taken:=least(greatest(owner.credits,0),unused);
  IF unused>0 THEN
   UPDATE profiles SET credits=credits-taken WHERE id=owner.id;
   INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_order_id,
    source_refund_id,idempotency_key,balance_before,balance_after,metadata)
   VALUES(owner.id,-taken,'deduction','Refunded credit pack settled','refund_clawback','refund_clawback','stripe_refund',o.id,
    o.metadata->'stripeExternalRefund'->>'lastRefundId','pay-common:pack-review:'||o.id,owner.credits,owner.credits-taken,
    jsonb_build_object('creditsUnused',unused,'creditsTakenBack',taken,'creditsShortfall',unused-taken,
     'shortfallAbsorbedBy','graylum','settledBy',p_actor));
  END IF;
  UPDATE credit_package_sources SET status='reversed' WHERE id=s.id;
 END IF;
 UPDATE credit_package_sources SET refund_review=p_decision,refund_reviewed_at=clock_timestamp(),refund_reviewed_by=p_actor,
  updated_at=clock_timestamp() WHERE id=s.id;
 UPDATE payment_orders SET metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('packRefundReview',jsonb_build_object(
  'decision',p_decision,'creditsUnused',unused,'creditsTakenBack',taken,'creditsShortfall',
  CASE WHEN p_decision='clawback' THEN unused-taken ELSE 0 END,'settledAt',clock_timestamp(),'settledBy',p_actor))
 WHERE id=o.id;
 RETURN jsonb_build_object('decision',p_decision,'duplicate',false,'userId',o.user_id,'creditsUnused',unused,
  'creditsTakenBack',taken,'creditsShortfall',CASE WHEN p_decision='clawback' THEN unused-taken ELSE 0 END);
END $$;

REVOKE ALL ON FUNCTION public.credit_package_refund_hold(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.credit_source_rows(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.pay_common_pack_refund_review_settle(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_common_pack_refund_review_settle(uuid,uuid,text) TO service_role;

-- Add the held pack credits to the existing quarantine of both reservation paths. One line after each anchor;
-- the marker makes a second run a no-op.
DO $$ DECLARE f record;src text;BEGIN
 FOR f IN SELECT * FROM (VALUES
  ('public.atomic_pre_deduct(uuid,integer,text,uuid)',
   E'  IF v_review_required_count > 0 THEN\n',
   E'  v_quarantined_terminated_amount := v_quarantined_terminated_amount + credit_package_refund_hold(p_user_id); -- PAY-REFUND-HOLD\n'),
  ('public.bill2_payg_claim(uuid,uuid,integer,jsonb)',
   E' avail:=greatest(avail-quarantine,0);\n',
   E' quarantine:=quarantine+credit_package_refund_hold(a); -- PAY-REFUND-HOLD\n')
 ) v(sig,anchor,line) LOOP
  src:=pg_get_functiondef(f.sig::regprocedure);
  IF position('-- PAY-REFUND-HOLD' IN src)>0 THEN CONTINUE;END IF;
  IF array_length(string_to_array(src,f.anchor),1)<>2 THEN RAISE EXCEPTION 'PAY_REFUND_HOLD_SOURCE_MISMATCH: %',f.sig;END IF;
  EXECUTE replace(src,f.anchor,f.line||f.anchor);
 END LOOP;
END $$;

COMMIT;
