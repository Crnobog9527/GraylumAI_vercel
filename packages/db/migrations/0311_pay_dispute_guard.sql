-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-DISPUTE-GUARD D1. Provisional 0311; controller confirms number before staging apply.
-- Rollback: disable dispute dispatch first, restore predecessor function bodies, and forward-fix.
-- Keep ALL financial rows and frozen balances; an active admin must explicitly withdraw each hold.
-- Never drop these tables or simply restore balances from a database backup.
-- Existing source consumed_amount remains authoritative; no second consumption ledger is introduced.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE IF NOT EXISTS public.payment_disputes(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 provider text NOT NULL DEFAULT 'stripe' CHECK(provider='stripe'),
 merchant_namespace text NOT NULL CHECK(merchant_namespace ~ '^[A-Za-z0-9_-]{1,64}$'),
 mode text NOT NULL CHECK(mode IN ('test','live')),
 provider_dispute_id text NOT NULL CHECK(provider_dispute_id ~ '^du_[A-Za-z0-9_]{1,160}$'),
 payment_key text NOT NULL,
 provider_charge_id text NOT NULL,
 provider_payment_intent_id text NOT NULL,
 provider_invoice_id text,
 provider_subscription_id text,
 original_payment_at timestamptz NOT NULL,
 last_event_at timestamptz NOT NULL,
 order_id uuid REFERENCES public.payment_orders(id) ON DELETE RESTRICT,
 subscription_id uuid REFERENCES public.user_subscriptions(id) ON DELETE RESTRICT,
 amount bigint NOT NULL CHECK(amount>=0),currency text NOT NULL CHECK(currency ~ '^[a-z]{3}$'),
 reason text NOT NULL CHECK(reason ~ '^[a-z_]{1,80}$'),
 status text NOT NULL CHECK(status IN ('warning_needs_response','warning_under_review','warning_closed',
  'needs_response','under_review','won','lost','prevented')),
 evidence_due_by timestamptz,opened_at timestamptz NOT NULL,closed_at timestamptz,outcome text,source_review_required boolean NOT NULL DEFAULT false,
 freeze_state text NOT NULL DEFAULT 'pending' CHECK(freeze_state IN ('pending','frozen','withdrawn','superseded','review','external')),
 renewal_stop_state text NOT NULL DEFAULT 'pending' CHECK(renewal_stop_state IN ('pending','confirmed','manual','not_applicable')),
 stop_attempts integer NOT NULL DEFAULT 0 CHECK(stop_attempts BETWEEN 0 AND 3),
 alerted_at timestamptz,freeze_alerted_at timestamptz,stop_alerted_at timestamptz,unmatched_alerted_at timestamptz,closed_alerted_at timestamptz,
 withdrawn_by uuid,withdrawn_at timestamptz,
 CONSTRAINT payment_disputes_identity UNIQUE(merchant_namespace,mode,provider_dispute_id),
 CONSTRAINT payment_disputes_canonical CHECK(payment_key=merchant_namespace||':'||mode||':'||provider_payment_intent_id)
);
CREATE INDEX IF NOT EXISTS payment_disputes_payment ON public.payment_disputes(payment_key);
CREATE INDEX IF NOT EXISTS payment_disputes_order ON public.payment_disputes(order_id);
CREATE INDEX IF NOT EXISTS payment_disputes_subscription ON public.payment_disputes(subscription_id) WHERE freeze_state='frozen';
CREATE TABLE IF NOT EXISTS public.payment_dispute_event_receipts(
 merchant_namespace text NOT NULL,mode text NOT NULL,event_id text NOT NULL,
 dispute_id uuid NOT NULL REFERENCES public.payment_disputes(id) ON DELETE RESTRICT,
 event_type text NOT NULL,event_at timestamptz NOT NULL,processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(merchant_namespace,mode,event_id)
);
CREATE TABLE IF NOT EXISTS public.payment_dispute_fund_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 dispute_id uuid NOT NULL REFERENCES public.payment_disputes(id) ON DELETE RESTRICT,
 merchant_namespace text NOT NULL,mode text NOT NULL,event_id text NOT NULL,
 action text NOT NULL CHECK(action IN ('withdrawn','reinstated')),amount bigint NOT NULL CHECK(amount>=0),
 currency text NOT NULL,occurred_at timestamptz NOT NULL,balance_transaction_ids text[] NOT NULL DEFAULT '{}',
 UNIQUE(merchant_namespace,mode,event_id)
);
ALTER TABLE public.subscription_credit_grants ADD COLUMN IF NOT EXISTS dispute_frozen boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS dispute_frozen_credits integer NOT NULL DEFAULT 0 CHECK(dispute_frozen_credits>=0);
ALTER TABLE public.credit_package_sources ADD COLUMN IF NOT EXISTS dispute_frozen boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS dispute_frozen_credits integer NOT NULL DEFAULT 0 CHECK(dispute_frozen_credits>=0);
ALTER TABLE public.payment_orders ADD COLUMN IF NOT EXISTS dispute_payment_key text,
 ADD COLUMN IF NOT EXISTS dispute_subscription_key text,
 ADD COLUMN IF NOT EXISTS dispute_refund_status text CHECK(dispute_refund_status IN ('blocked','dispatching','pending','succeeded','manual')),
 ADD COLUMN IF NOT EXISTS dispute_refund_claimed_at timestamptz,
 ADD COLUMN IF NOT EXISTS dispute_refund_id text;

CREATE UNIQUE INDEX IF NOT EXISTS payment_orders_dispute_payment_unique
 ON public.payment_orders(dispute_payment_key) WHERE dispute_payment_key IS NOT NULL;

-- Canonical payment identity wins. A lookup hint must agree; never choose an arbitrary OR row.
CREATE OR REPLACE FUNCTION public.pay_dispute_resolve_order(p_key text,p_hint uuid,p_merchant text,p_mode text)
RETURNS payment_orders LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE o payment_orders;
BEGIN
 SELECT * INTO o FROM payment_orders WHERE dispute_payment_key=p_key;
 IF o.id IS NOT NULL AND p_hint IS NOT NULL AND o.id<>p_hint THEN
  RAISE EXCEPTION 'PAY_DISPUTE_MAPPING_CONFLICT'; END IF;
 IF o.id IS NULL THEN SELECT * INTO o FROM payment_orders WHERE id=p_hint; END IF;
 IF o.id IS NOT NULL AND (o.payment_channel IS DISTINCT FROM 'stripe'
  OR o.merchant_namespace IS DISTINCT FROM p_merchant OR o.payment_mode IS DISTINCT FROM p_mode
  OR o.dispute_payment_key IS NOT NULL AND o.dispute_payment_key<>p_key) THEN
  RAISE EXCEPTION 'PAY_DISPUTE_MAPPING_CONFLICT'; END IF;
 RETURN o;
END $$;
-- Existing scoped provider refs remain authoritative for membership subscriptions.
CREATE OR REPLACE FUNCTION public.pay_dispute_order_subscription(p_order uuid,p_supplied text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE o payment_orders;external_ text;count_ integer;
BEGIN
 SELECT * INTO o FROM payment_orders WHERE id=p_order;
 SELECT count(*),min(external_id) INTO count_,external_ FROM payment_provider_refs
  WHERE subscription_id=o.subscription_id AND channel='stripe' AND object_type='subscription'
   AND merchant_namespace=o.merchant_namespace AND mode=o.payment_mode;
 IF count_>1 OR external_ IS NOT NULL AND p_supplied IS NOT NULL AND external_<>p_supplied THEN
  RAISE EXCEPTION 'PAY_DISPUTE_SUBSCRIPTION_CONFLICT'; END IF;
 external_:=coalesce(external_,p_supplied);
 IF o.dispute_subscription_key IS NOT NULL THEN
  IF external_ IS NULL THEN
   external_:=substring(o.dispute_subscription_key FROM length(o.merchant_namespace||':'||o.payment_mode||':')+1);
  END IF;
  IF o.dispute_subscription_key IS DISTINCT FROM o.merchant_namespace||':'||o.payment_mode||':'||external_ THEN
   RAISE EXCEPTION 'PAY_DISPUTE_SUBSCRIPTION_CONFLICT'; END IF;
 END IF;
 IF external_ IS NOT NULL AND external_ !~ '^sub_[A-Za-z0-9_]{1,160}$' THEN
  RAISE EXCEPTION 'PAY_DISPUTE_SUBSCRIPTION_CONFLICT'; END IF;
 RETURN external_;
END $$;

DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['payment_disputes','payment_dispute_event_receipts','payment_dispute_fund_events'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON public.%I TO service_role',t);
  EXECUTE format('DROP POLICY IF EXISTS dispute_service ON public.%I',t);
  EXECUTE format('CREATE POLICY dispute_service ON public.%I FOR ALL TO service_role USING(true) WITH CHECK(true)',t);
 END LOOP;
END $$;

-- Both dispute processing and fulfillment take subscription, then canonical payment, then profile/source locks.
CREATE OR REPLACE FUNCTION public.pay_dispute_lock(p_payment text,p_subscription text) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF p_subscription IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('dispute:subscription:'||p_subscription,0)); END IF;
 IF p_payment IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('dispute:payment:'||p_payment,0)); END IF;
END $$;
CREATE OR REPLACE FUNCTION public.pay_dispute_order_lock(p_order uuid) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE o payment_orders;
BEGIN
 SELECT * INTO o FROM payment_orders WHERE id=p_order;
 PERFORM pay_dispute_lock(o.dispute_payment_key,o.dispute_subscription_key);
END $$;
CREATE OR REPLACE FUNCTION public.pay_dispute_order_frozen(p_order uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM payment_disputes WHERE order_id=p_order AND freeze_state='frozen')
$$;

-- PAY-FOUNDER F5 already projects this hook into badge and public-wall visibility.
CREATE OR REPLACE FUNCTION public.pay_founder_order_frozen(p_order uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT pay_dispute_order_frozen(p_order)
$$;

-- The caller holds the profile lock. Each source has one reversible balance hold even if a payment has multiple disputes.
CREATE OR REPLACE FUNCTION public.pay_dispute_freeze(p_dispute uuid) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE d payment_disputes;o payment_orders;u profiles;g record;n integer;total integer:=0;unknown boolean:=false;
BEGIN
 SELECT * INTO d FROM payment_disputes WHERE id=p_dispute;
 IF d.order_id IS NULL OR d.freeze_state NOT IN ('pending','review') THEN RETURN; END IF;
 SELECT * INTO u FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=d.order_id) FOR UPDATE;
 SELECT * INTO o FROM payment_orders WHERE id=d.order_id FOR UPDATE;
 SELECT * INTO d FROM payment_disputes WHERE id=p_dispute FOR UPDATE;
 IF d.freeze_state NOT IN ('pending','review') THEN RETURN; END IF;
 IF o.status IN ('refunded','partially_refunded') THEN
  UPDATE payment_disputes SET freeze_state='superseded' WHERE id=d.id; RETURN; END IF;
 PERFORM 1 FROM subscription_credit_grants WHERE user_id=u.id ORDER BY id FOR UPDATE;
 PERFORM 1 FROM credit_package_sources WHERE user_id=u.id ORDER BY id FOR UPDATE;
 FOR g IN SELECT 'subscription_grant' AS kind,id,status,credits_granted-consumed_amount AS remaining,dispute_frozen,
   accounting_state='trusted' AND NOT EXISTS(SELECT 1 FROM credit_source_reviews r
    WHERE r.source_kind='subscription_grant' AND r.source_id=subscription_credit_grants.id) AS trusted
  FROM subscription_credit_grants WHERE source_order_id=o.id
  UNION ALL SELECT 'credit_package',id,status,credits_granted-consumed_amount,dispute_frozen,
   NOT EXISTS(SELECT 1 FROM credit_source_reviews r WHERE r.source_kind='credit_package' AND r.source_id=credit_package_sources.id)
  FROM credit_package_sources WHERE order_id=o.id LOOP
  IF NOT g.trusted THEN unknown:=true;CONTINUE; END IF;
  IF g.dispute_frozen THEN CONTINUE; END IF;
  n:=CASE WHEN g.status='granted' THEN greatest(g.remaining,0) ELSE 0 END;
  IF total+n>greatest(u.credits,0) THEN unknown:=true; CONTINUE; END IF;
  IF g.kind='subscription_grant' THEN
   UPDATE subscription_credit_grants SET dispute_frozen=true,dispute_frozen_credits=n WHERE id=g.id;
  ELSE
   UPDATE credit_package_sources SET dispute_frozen=true,dispute_frozen_credits=n WHERE id=g.id;
  END IF;
  total:=total+n;
 END LOOP;
 IF total>0 THEN
  UPDATE profiles SET credits=credits-total WHERE id=u.id;
  INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_order_id,
   idempotency_key,balance_before,balance_after)
  VALUES(u.id,-total,'deduction','Payment dispute hold','adjustment','dispute_freeze','payment_order',o.id,
   'dispute:'||d.id||':freeze',u.credits,u.credits-total);
 END IF;
 -- Unknown sources never cause a balance deduction; membership/future grants still pause and an alert requests review.
 UPDATE payment_disputes SET freeze_state='frozen',subscription_id=o.subscription_id,
  source_review_required=unknown,
  renewal_stop_state=CASE WHEN o.auto_renew THEN renewal_stop_state ELSE 'not_applicable' END WHERE id=d.id;
 PERFORM pay_common_settle_membership_level(u.id);
END $$;

CREATE OR REPLACE FUNCTION public.pay_dispute_receive(p_merchant text,p_mode text,p_event jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d payment_disputes;o payment_orders;fresh boolean;terminal boolean;at_ timestamptz;subkey text;pk text;provider_sub text;locked_sub text;hint uuid;
BEGIN
 IF p_mode NOT IN ('test','live') OR p_event->>'id' !~ '^evt_[A-Za-z0-9_]{1,160}$'
  OR p_event->>'disputeId' !~ '^du_[A-Za-z0-9_]{1,160}$' OR p_event->>'paymentIntentId' !~ '^pi_[A-Za-z0-9_]{1,160}$'
  OR p_event->>'chargeId' !~ '^ch_[A-Za-z0-9_]{1,160}$'
  OR p_event->>'type' NOT IN ('charge.dispute.created','charge.dispute.updated','charge.dispute.closed',
    'charge.dispute.funds_withdrawn','charge.dispute.funds_reinstated')
  OR nullif(p_event->>'paymentAt','') IS NULL OR nullif(p_event->>'created','') IS NULL THEN
  RAISE EXCEPTION 'PAY_DISPUTE_EVENT_INVALID'; END IF;
 pk:=p_merchant||':'||p_mode||':'||(p_event->>'paymentIntentId');
 hint:=nullif(p_event->>'orderId','')::uuid;
 o:=pay_dispute_resolve_order(pk,hint,p_merchant,p_mode);
 SELECT * INTO d FROM payment_disputes WHERE merchant_namespace=p_merchant AND mode=p_mode
  AND provider_dispute_id=p_event->>'disputeId';
 IF d.provider_subscription_id IS NOT NULL AND p_event->>'subscriptionId' IS NOT NULL
  AND d.provider_subscription_id<>p_event->>'subscriptionId' THEN RAISE EXCEPTION 'PAY_DISPUTE_SUBSCRIPTION_CONFLICT'; END IF;
 provider_sub:=pay_dispute_order_subscription(o.id,coalesce(p_event->>'subscriptionId',d.provider_subscription_id));
 locked_sub:=provider_sub;
 subkey:=CASE WHEN provider_sub IS NOT NULL THEN p_merchant||':'||p_mode||':'||provider_sub END;
 PERFORM pay_dispute_lock(pk,subkey);
 -- Recheck after waiting. A newly mapped subscription requires retry from the correct lock order.
 o:=pay_dispute_resolve_order(pk,hint,p_merchant,p_mode);
 SELECT * INTO d FROM payment_disputes WHERE merchant_namespace=p_merchant AND mode=p_mode
  AND provider_dispute_id=p_event->>'disputeId';
 IF d.provider_subscription_id IS NOT NULL AND p_event->>'subscriptionId' IS NOT NULL
  AND d.provider_subscription_id<>p_event->>'subscriptionId' THEN RAISE EXCEPTION 'PAY_DISPUTE_SUBSCRIPTION_CONFLICT'; END IF;
 provider_sub:=pay_dispute_order_subscription(o.id,coalesce(p_event->>'subscriptionId',d.provider_subscription_id));
 IF provider_sub IS DISTINCT FROM locked_sub THEN RAISE EXCEPTION 'PAY_DISPUTE_MAPPING_RETRY' USING ERRCODE='40001'; END IF;
 IF o.id IS NOT NULL THEN
  PERFORM 1 FROM profiles WHERE id=o.user_id FOR UPDATE;
  UPDATE payment_orders SET dispute_payment_key=pk,dispute_subscription_key=coalesce(dispute_subscription_key,subkey) WHERE id=o.id;
 END IF;
 at_:=(p_event->>'created')::timestamptz;
 INSERT INTO payment_disputes(merchant_namespace,mode,provider_dispute_id,payment_key,provider_charge_id,
  provider_payment_intent_id,provider_invoice_id,provider_subscription_id,original_payment_at,last_event_at,order_id,
  subscription_id,amount,currency,reason,status,evidence_due_by,opened_at)
 VALUES(p_merchant,p_mode,p_event->>'disputeId',pk,p_event->>'chargeId',p_event->>'paymentIntentId',
  p_event->>'invoiceId',provider_sub,(p_event->>'paymentAt')::timestamptz,at_,o.id,o.subscription_id,
  (p_event->>'amount')::bigint,p_event->>'currency',p_event->>'reason',p_event->>'status',
  (p_event->>'dueBy')::timestamptz,(p_event->>'openedAt')::timestamptz)
 ON CONFLICT ON CONSTRAINT payment_disputes_identity DO NOTHING;
 SELECT * INTO d FROM payment_disputes WHERE merchant_namespace=p_merchant AND mode=p_mode
  AND provider_dispute_id=p_event->>'disputeId' FOR UPDATE;
 IF d.payment_key<>pk OR d.provider_charge_id<>p_event->>'chargeId' THEN RAISE EXCEPTION 'PAY_DISPUTE_IDENTITY_CONFLICT'; END IF;
 INSERT INTO payment_dispute_event_receipts(merchant_namespace,mode,event_id,dispute_id,event_type,event_at)
 VALUES(p_merchant,p_mode,p_event->>'id',d.id,p_event->>'type',at_) ON CONFLICT DO NOTHING;
 fresh:=FOUND;
 IF NOT EXISTS(SELECT 1 FROM payment_dispute_event_receipts WHERE merchant_namespace=p_merchant AND mode=p_mode
  AND event_id=p_event->>'id' AND dispute_id=d.id AND event_type=p_event->>'type') THEN
  RAISE EXCEPTION 'PAY_DISPUTE_EVENT_IDENTITY_CONFLICT'; END IF;
 IF fresh THEN
  terminal:=p_event->>'status' IN ('won','lost','warning_closed','prevented');
  UPDATE payment_disputes SET
   status=CASE WHEN (d.closed_at IS NULL AND at_>=d.last_event_at) OR terminal AND d.closed_at IS NULL
    THEN p_event->>'status' ELSE d.status END,
   closed_at=CASE WHEN terminal AND d.closed_at IS NULL THEN at_ ELSE d.closed_at END,
   outcome=CASE WHEN terminal AND d.closed_at IS NULL THEN p_event->>'status' ELSE d.outcome END,
   last_event_at=greatest(last_event_at,at_),
   evidence_due_by=CASE WHEN at_>=d.last_event_at THEN (p_event->>'dueBy')::timestamptz ELSE evidence_due_by END
  WHERE id=d.id;
  IF p_event->>'type' IN ('charge.dispute.funds_withdrawn','charge.dispute.funds_reinstated') THEN
   INSERT INTO payment_dispute_fund_events(dispute_id,merchant_namespace,mode,event_id,action,amount,currency,occurred_at,
    balance_transaction_ids)
   VALUES(d.id,p_merchant,p_mode,p_event->>'id',CASE WHEN p_event->>'type'='charge.dispute.funds_withdrawn'
    THEN 'withdrawn' ELSE 'reinstated' END,(p_event->>'amount')::bigint,p_event->>'currency',at_,
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p_event->'balanceTransactions','[]')))) ON CONFLICT DO NOTHING;
  END IF;
 END IF;
 IF d.order_id IS NOT NULL AND o.id IS NOT NULL AND d.order_id<>o.id THEN
  RAISE EXCEPTION 'PAY_DISPUTE_MAPPING_CONFLICT'; END IF;
 UPDATE payment_disputes SET order_id=coalesce(order_id,o.id),subscription_id=coalesce(subscription_id,o.subscription_id),
  provider_subscription_id=coalesce(provider_subscription_id,provider_sub),
  provider_invoice_id=coalesce(provider_invoice_id,p_event->>'invoiceId') WHERE id=d.id;
 PERFORM pay_dispute_freeze(d.id);
 RETURN (SELECT to_jsonb(x)||jsonb_build_object('duplicate',NOT fresh) FROM payment_disputes x WHERE id=d.id);
END $$;

CREATE OR REPLACE FUNCTION public.pay_dispute_withdraw(p_actor uuid,p_dispute uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d payment_disputes;u profiles;total integer:=0;g record;member jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor AND role='admin' AND status='active' AND is_deleted='false') THEN
  RAISE EXCEPTION 'PAY_DISPUTE_ADMIN_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT * INTO d FROM payment_disputes WHERE id=p_dispute;
 PERFORM pay_dispute_lock(d.payment_key,CASE WHEN d.provider_subscription_id IS NOT NULL THEN
  d.merchant_namespace||':'||d.mode||':'||d.provider_subscription_id END);
 SELECT * INTO u FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=d.order_id) FOR UPDATE;
 SELECT * INTO d FROM payment_disputes WHERE id=p_dispute FOR UPDATE;
 SET CONSTRAINTS pay_dispute_source_sync IMMEDIATE; SET CONSTRAINTS pay_dispute_source_sync DEFERRED;
 IF d.freeze_state='withdrawn' THEN RETURN jsonb_build_object('duplicate',true,'restored',0); END IF;
 IF d.freeze_state<>'frozen' OR u.id IS NULL THEN RAISE EXCEPTION 'PAY_DISPUTE_NOT_FROZEN'; END IF;
 UPDATE payment_disputes SET freeze_state='withdrawn',withdrawn_by=p_actor,withdrawn_at=clock_timestamp() WHERE id=d.id;
 IF NOT pay_dispute_order_frozen(d.order_id) THEN
  PERFORM 1 FROM subscription_credit_grants WHERE user_id=u.id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM credit_package_sources WHERE user_id=u.id ORDER BY id FOR UPDATE;
  SELECT coalesce(sum(n),0)::integer INTO total FROM (
   SELECT dispute_frozen_credits n FROM subscription_credit_grants WHERE source_order_id=d.order_id
   UNION ALL SELECT dispute_frozen_credits FROM credit_package_sources WHERE order_id=d.order_id) x;
  UPDATE subscription_credit_grants SET dispute_frozen=false,dispute_frozen_credits=0 WHERE source_order_id=d.order_id;
  UPDATE credit_package_sources SET dispute_frozen=false,dispute_frozen_credits=0 WHERE order_id=d.order_id;
  UPDATE profiles SET credits=credits+total WHERE id=u.id;
  INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_order_id,
   idempotency_key,balance_before,balance_after)
  VALUES(u.id,total,'adjustment','Payment dispute hold withdrawn','adjustment','dispute_withdraw','payment_order',d.order_id,
   'dispute:'||d.id||':withdraw',u.credits,u.credits+total);
 END IF;
 PERFORM pay_common_settle_membership_level(u.id);
 member:=pay_common_membership_facts(u.id)->'internal_membership';
 IF member->>'mapping_state'='internal_paid' AND member->>'membership_level' IN ('pro','gold') THEN
  UPDATE profiles SET membership_level=member->>'membership_level' WHERE id=u.id;
 END IF;
 RETURN jsonb_build_object('restored',total,'duplicate',false);
END $$;

-- Deferred until all billing balance/ledger writes finish, preserving BILL2's in-function conservation checks.
-- Every new reservation also quarantines any pending positive adjustment in this same transaction.
CREATE OR REPLACE FUNCTION public.pay_dispute_source_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s record;balance integer;n integer;delta integer;oid uuid;
BEGIN
 SELECT credits INTO balance FROM profiles WHERE id=NEW.user_id FOR UPDATE;
 IF TG_TABLE_NAME='subscription_credit_grants' THEN
  SELECT *,source_order_id AS order_id INTO s FROM subscription_credit_grants WHERE id=NEW.id FOR UPDATE;
 ELSE SELECT * INTO s FROM credit_package_sources WHERE id=NEW.id FOR UPDATE; END IF;
 IF NOT s.dispute_frozen THEN RETURN NULL; END IF;
 n:=CASE WHEN s.status='granted' THEN greatest(s.credits_granted-s.consumed_amount,0) ELSE 0 END;
 delta:=n-s.dispute_frozen_credits;
 IF delta=0 THEN RETURN NULL; END IF;
 IF delta>greatest(balance,0) THEN RAISE EXCEPTION 'PAY_DISPUTE_SOURCE_BALANCE_CONFLICT'; END IF;
 UPDATE profiles SET credits=credits-delta WHERE id=s.user_id;
 IF TG_TABLE_NAME='subscription_credit_grants' THEN
  UPDATE subscription_credit_grants SET dispute_frozen_credits=n WHERE id=s.id;
 ELSE UPDATE credit_package_sources SET dispute_frozen_credits=n WHERE id=s.id; END IF;
 INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_order_id,
  idempotency_key,balance_before,balance_after)
 VALUES(s.user_id,-delta,'adjustment','Payment dispute in-flight adjustment','adjustment','dispute_adjustment','payment_order',s.order_id,
  'dispute:source:'||s.id||':'||gen_random_uuid(),balance,balance-delta);
 RETURN NULL;
END $$;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['subscription_credit_grants','credit_package_sources'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS pay_dispute_source_sync ON public.%I',t);
  EXECUTE format('CREATE CONSTRAINT TRIGGER pay_dispute_source_sync AFTER UPDATE ON public.%I '
   ||'DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.pay_dispute_source_sync()',t);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.pay_dispute_pending_hold(p_user uuid) RETURNS integer
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce(sum(n),0)::integer FROM (
  SELECT greatest(credits_granted-consumed_amount-dispute_frozen_credits,0) n FROM subscription_credit_grants
   WHERE user_id=p_user AND dispute_frozen AND status='granted'
  UNION ALL SELECT greatest(credits_granted-consumed_amount-dispute_frozen_credits,0) FROM credit_package_sources
   WHERE user_id=p_user AND dispute_frozen AND status='granted') x
$$;

-- Patches are exact-one and independently marked. A changed predecessor fails instead of silently omitting protection.
DO $patch$ DECLARE p record;src text;BEGIN
 FOR p IN SELECT * FROM (VALUES
 ('public.credit_source_rows(uuid)',
  'WHERE g.user_id=p_user AND g.status=''granted''',
  'WHERE g.user_id=p_user AND NOT g.dispute_frozen AND g.status=''granted''','source-grant'),
 ('public.credit_source_rows(uuid)',
  'WHERE s.user_id=p_user AND s.status=''granted''',
  'WHERE s.user_id=p_user AND NOT s.dispute_frozen AND s.status=''granted''','source-pack'),
 ('public.atomic_pre_deduct(uuid,integer,text,uuid)',
  'v_quarantined_terminated_amount + credit_package_refund_hold(p_user_id)',
  'v_quarantined_terminated_amount + credit_package_refund_hold(p_user_id) + pay_dispute_pending_hold(p_user_id)','reserve-pending'),
 ('public.bill2_payg_claim(uuid,uuid,integer,jsonb)',
  'quarantine+credit_package_refund_hold(a)',
  'quarantine+credit_package_refund_hold(a)+pay_dispute_pending_hold(a)','claim-pending'),
 ('public.pay_common_membership_facts(uuid)',
  'AND o.fulfilled_at IS NOT NULL AND o.status=''completed'' AND o.payment_status=''paid''',
  'AND NOT pay_dispute_order_frozen(o.id) AND o.fulfilled_at IS NOT NULL AND o.status=''completed'' AND o.payment_status=''paid''','membership'),
 ('public.pay_waffo_grant_period(uuid,integer)',
  'SELECT user_id INTO actor.id FROM payment_orders WHERE id=p_order;',
  'PERFORM pay_dispute_order_lock(p_order); SELECT user_id INTO actor.id FROM payment_orders WHERE id=p_order;','grant-lock'),
 ('public.pay_waffo_grant_period(uuid,integer)',
  'OR o.status IS DISTINCT FROM ''completed'' OR o.fulfilled_at IS NULL',
  'OR pay_dispute_order_frozen(o.id) OR o.status IS DISTINCT FROM ''completed'' OR o.fulfilled_at IS NULL','grant-freeze'),
 ('public.pay_stripe_mp_renew_subscription(uuid,text,text,integer,text,timestamptz,timestamptz,timestamptz)',
  'review:=s.method_cancel_requested_at IS NOT NULL',
  'review:=EXISTS(SELECT 1 FROM payment_disputes WHERE (subscription_id=s.id OR provider_subscription_id=(SELECT external_id FROM payment_provider_refs WHERE subscription_id=s.id AND object_type=''subscription'' AND channel=''stripe'' AND merchant_namespace=s.merchant_namespace AND mode=s.payment_mode)) AND merchant_namespace=s.merchant_namespace AND mode=s.payment_mode AND freeze_state IN (''pending'',''frozen'') AND payment_key IS DISTINCT FROM current_setting(''pay_dispute.payment_key'',true)) OR s.method_cancel_requested_at IS NOT NULL',
  'renew-review')
 ) x(sig,anchor,replacement,marker) LOOP
  src:=pg_get_functiondef(p.sig::regprocedure);
  IF position('-- PAY-D1 '||p.marker IN src)>0 THEN CONTINUE; END IF;
  IF array_length(string_to_array(src,p.anchor),1)<>2 THEN RAISE EXCEPTION 'PAY_DISPUTE_PATCH_MISMATCH: % %',p.sig,p.marker; END IF;
  EXECUTE replace(src,p.anchor,p.replacement||' -- PAY-D1 '||p.marker||E'\n');
 END LOOP;
 -- Legacy direct-period selection and its sanity scans must all ignore frozen sources; restoration still uses original binding.
 src:=pg_get_functiondef('public.atomic_pre_deduct(uuid,integer,text,uuid)'::regprocedure);
 IF position('-- PAY-D1 current-source' IN src)=0 THEN
  IF position('g.user_id = p_user_id' IN src)=0 THEN RAISE EXCEPTION 'PAY_DISPUTE_RESERVE_PATCH_MISMATCH'; END IF;
  src:=replace(src,'g.user_id = p_user_id','g.user_id = p_user_id AND NOT g.dispute_frozen');
  EXECUTE replace(src,'BEGIN',E'BEGIN\n -- PAY-D1 current-source');
 END IF;
END $patch$;

-- Atomic adapters reuse the existing grant routines; canonical Stripe identities have already been verified by the API.
CREATE OR REPLACE FUNCTION public.pay_dispute_claim_pending(p_order uuid) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE o payment_orders;d record;provider_sub text;
BEGIN
 SELECT * INTO o FROM payment_orders WHERE id=p_order;
 provider_sub:=pay_dispute_order_subscription(o.id);
 IF EXISTS(SELECT 1 FROM payment_disputes WHERE payment_key=o.dispute_payment_key
  AND (order_id IS NOT NULL AND order_id<>o.id OR provider_subscription_id IS NOT NULL
   AND provider_sub IS DISTINCT FROM provider_subscription_id)) THEN RAISE EXCEPTION 'PAY_DISPUTE_MAPPING_CONFLICT'; END IF;
 UPDATE payment_disputes SET order_id=o.id,subscription_id=o.subscription_id,
  provider_subscription_id=coalesce(provider_subscription_id,provider_sub)
  WHERE payment_key=o.dispute_payment_key AND (order_id IS NULL OR order_id=o.id);
 FOR d IN SELECT id FROM payment_disputes WHERE order_id=o.id AND freeze_state IN ('pending','review') ORDER BY id LOOP
  PERFORM pay_dispute_freeze(d.id);
 END LOOP;
 PERFORM pay_dispute_evidence(o.id);
END $$;
CREATE OR REPLACE FUNCTION public.pay_dispute_fulfill(p_facts jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o payment_orders;pk text;sk text;result jsonb;
BEGIN
 SELECT * INTO o FROM payment_orders WHERE id=(p_facts->>'orderId')::uuid;
 IF o.id IS NULL OR o.payment_channel IS DISTINCT FROM 'stripe' OR o.merchant_namespace IS DISTINCT FROM p_facts->>'merchant'
  OR o.payment_mode IS DISTINCT FROM p_facts->>'mode' OR p_facts->>'paymentIntentId' !~ '^pi_[A-Za-z0-9_]{1,160}$'
  THEN RAISE EXCEPTION 'PAY_DISPUTE_FULFILL_SCOPE'; END IF;
 pk:=o.merchant_namespace||':'||o.payment_mode||':'||(p_facts->>'paymentIntentId');
 sk:=CASE WHEN p_facts->>'subscriptionId' IS NOT NULL THEN o.merchant_namespace||':'||o.payment_mode||':'||(p_facts->>'subscriptionId') END;
 PERFORM pay_dispute_lock(pk,sk);
 PERFORM 1 FROM profiles WHERE id=o.user_id FOR UPDATE;
 IF o.dispute_payment_key IS NOT NULL AND o.dispute_payment_key<>pk THEN RAISE EXCEPTION 'PAY_DISPUTE_FULFILL_CONFLICT'; END IF;
 UPDATE payment_orders SET dispute_payment_key=pk,dispute_subscription_key=sk WHERE id=o.id;
 result:=pay_waffo_fulfill_payment(o.id,o.merchant_namespace,p_facts->>'checkoutId',p_facts->>'paymentId',
  (p_facts->>'amount')::integer,p_facts->>'currency',(p_facts->>'paidAt')::timestamptz,p_facts->>'subscriptionId',
  (p_facts->>'start')::timestamptz,(p_facts->>'end')::timestamptz);
 PERFORM pay_dispute_claim_pending(o.id);
 RETURN result||jsonb_build_object('disputeFrozen',pay_dispute_order_frozen(o.id));
END $$;
CREATE OR REPLACE FUNCTION public.pay_dispute_renew(p_facts jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s user_subscriptions;pk text;sk text;result jsonb;oid uuid;
BEGIN
 SELECT * INTO s FROM user_subscriptions WHERE id=(p_facts->>'subscription')::uuid;
 IF s.id IS NULL OR s.payment_channel IS DISTINCT FROM 'stripe' OR s.merchant_namespace IS DISTINCT FROM p_facts->>'merchant'
  OR s.payment_mode IS DISTINCT FROM p_facts->>'mode' OR p_facts->>'paymentIntentId' !~ '^pi_[A-Za-z0-9_]{1,160}$'
  OR NOT EXISTS(SELECT 1 FROM payment_provider_refs WHERE subscription_id=s.id AND channel='stripe'
   AND merchant_namespace=s.merchant_namespace AND mode=s.payment_mode AND object_type='subscription'
   AND external_id=p_facts->>'subscriptionId') THEN RAISE EXCEPTION 'PAY_DISPUTE_RENEW_SCOPE'; END IF;
 pk:=s.merchant_namespace||':'||s.payment_mode||':'||(p_facts->>'paymentIntentId');
 sk:=s.merchant_namespace||':'||s.payment_mode||':'||(p_facts->>'subscriptionId');
 PERFORM pay_dispute_lock(pk,sk);
 PERFORM set_config('pay_dispute.payment_key',pk,true);
 result:=pay_stripe_mp_renew_subscription(s.id,s.merchant_namespace,p_facts->>'invoiceId',(p_facts->>'amount')::integer,
  p_facts->>'currency',(p_facts->>'paidAt')::timestamptz,(p_facts->>'start')::timestamptz,(p_facts->>'end')::timestamptz);
 oid:=nullif(result->>'orderId','')::uuid;
 IF oid IS NOT NULL THEN
  UPDATE payment_orders SET dispute_payment_key=pk,dispute_subscription_key=sk WHERE id=oid
   AND (dispute_payment_key IS NULL OR dispute_payment_key=pk);
  IF NOT FOUND THEN RAISE EXCEPTION 'PAY_DISPUTE_RENEW_CONFLICT'; END IF;
  PERFORM pay_dispute_claim_pending(oid);
  IF result->>'state'='review' AND EXISTS(SELECT 1 FROM payment_disputes
   WHERE merchant_namespace=s.merchant_namespace AND mode=s.payment_mode
    AND provider_subscription_id=p_facts->>'subscriptionId' AND payment_key<>pk AND freeze_state IN ('pending','frozen')) THEN
   UPDATE payment_orders SET dispute_refund_status=coalesce(dispute_refund_status,'blocked') WHERE id=oid;
  END IF;
 END IF;
 RETURN result||jsonb_build_object('disputeFrozen',pay_dispute_order_frozen(oid),
  'disputeRefundRequired',EXISTS(SELECT 1 FROM payment_orders WHERE id=oid AND dispute_refund_status IS NOT NULL));
END $$;

-- A full external refund takes ownership of an existing hold. It is already out of the balance: never debit it twice.
CREATE OR REPLACE FUNCTION public.pay_dispute_supersede(p_order uuid) RETURNS integer
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE total integer;
BEGIN
 SELECT coalesce(sum(n),0)::integer INTO total FROM (
  SELECT dispute_frozen_credits n FROM subscription_credit_grants WHERE source_order_id=p_order
  UNION ALL SELECT dispute_frozen_credits FROM credit_package_sources WHERE order_id=p_order) x;
 UPDATE payment_disputes SET freeze_state='superseded' WHERE order_id=p_order AND freeze_state IN ('pending','frozen','review');
 UPDATE subscription_credit_grants SET dispute_frozen=false,dispute_frozen_credits=0 WHERE source_order_id=p_order;
 UPDATE credit_package_sources SET dispute_frozen=false,dispute_frozen_credits=0,
  status=CASE WHEN dispute_frozen THEN 'reversed' ELSE status END WHERE order_id=p_order;
 UPDATE credit_transactions SET metadata=coalesce(metadata,'{}')||jsonb_build_object('supersededByRefund',true)
  WHERE source_order_id=p_order AND reason_code IN ('dispute_freeze','dispute_adjustment');
 RETURN total;
END $$;

DO $patch$ DECLARE p record;src text;BEGIN
 FOR p IN SELECT * FROM (VALUES
 ('public.pay_stripe_mp_record_external_refund(uuid,text,text,text,integer,text,timestamptz)',
  'SELECT * INTO owner FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=p_order) FOR UPDATE;',
  'PERFORM pay_dispute_order_lock(p_order); SELECT * INTO owner FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=p_order) FOR UPDATE;',
  'external-lock'),
 ('public.pay_stripe_mp_record_external_refund(uuid,text,text,text,integer,text,timestamptz)',
  'taken:=least(greatest(owner.credits,0),credits_back)::integer;',
  'credits_back:=greatest(credits_back-pay_dispute_supersede(o.id),0); taken:=least(greatest(owner.credits,0),credits_back)::integer;',
  'external-convert'),
 ('public.pay_stripe_mp_record_external_refund(uuid,text,text,text,integer,text,timestamptz)',
  'IF o.item_type=''credit_package'' THEN',
  'IF o.item_type=''credit_package'' THEN PERFORM pay_dispute_supersede(o.id);','external-pack'),
 ('public.pay_common_monthly_refund_claim(uuid,uuid,uuid,jsonb)',
  'v:=monthly_refund_validate(p_actor,p_order,p_terms);',
  'PERFORM pay_dispute_order_lock(p_order); IF EXISTS(SELECT 1 FROM payment_disputes WHERE order_id=p_order AND freeze_state IN (''pending'',''frozen'',''review'')) THEN '
   ||'RAISE EXCEPTION ''PAY_DISPUTE_REFUND_FORBIDDEN''; END IF; v:=monthly_refund_validate(p_actor,p_order,p_terms);','monthly-claim'),
 ('public.pay_common_monthly_refund_finish(uuid,uuid,uuid,jsonb)',
  'PERFORM monthly_refund_assert_admin(p_actor);i:=monthly_refund_lock(p_order,p_intent);',
  'PERFORM pay_dispute_order_lock(p_order); PERFORM monthly_refund_assert_admin(p_actor);i:=monthly_refund_lock(p_order,p_intent);','monthly-finish'),
 ('public.pay_common_package_refund_claim(uuid,uuid,uuid,jsonb)',
  'SELECT credits INTO balance FROM profiles WHERE id=owner_id FOR UPDATE;',
  'PERFORM pay_dispute_order_lock(p_order); IF EXISTS(SELECT 1 FROM payment_disputes WHERE order_id=p_order AND freeze_state IN (''pending'',''frozen'',''review'')) THEN '
   ||'RAISE EXCEPTION ''PAY_DISPUTE_REFUND_FORBIDDEN''; END IF; SELECT credits INTO balance FROM profiles WHERE id=owner_id FOR UPDATE;',
  'pack-claim'),
 ('public.pay_common_package_refund_result(uuid,uuid,jsonb)',
  'PERFORM 1 FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=p_order) FOR UPDATE;',
  'PERFORM pay_dispute_order_lock(p_order); PERFORM 1 FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=p_order) FOR UPDATE;',
  'pack-result'),
 ('public.pay_common_package_refund_retry(uuid,uuid,uuid,jsonb)',
  'PERFORM 1 FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=p_order) FOR UPDATE;',
  'PERFORM pay_dispute_order_lock(p_order); IF EXISTS(SELECT 1 FROM payment_disputes WHERE order_id=p_order AND freeze_state IN (''pending'',''frozen'',''review'')) THEN '
   ||'RAISE EXCEPTION ''PAY_DISPUTE_REFUND_FORBIDDEN''; END IF; PERFORM 1 FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=p_order) FOR UPDATE;',
  'pack-retry')
 ) x(sig,anchor,replacement,marker) LOOP
  src:=pg_get_functiondef(p.sig::regprocedure);
  IF position('-- PAY-D1 '||p.marker IN src)>0 THEN CONTINUE; END IF;
  IF array_length(string_to_array(src,p.anchor),1)<>2 THEN RAISE EXCEPTION 'PAY_DISPUTE_PATCH_MISMATCH: % %',p.sig,p.marker; END IF;
  EXECUTE replace(src,p.anchor,p.replacement||' -- PAY-D1 '||p.marker||E'\n');
 END LOOP;
END $patch$;

DO $patch$ DECLARE src text;BEGIN
 src:=pg_get_functiondef('public.monthly_refund_source_guard()'::regprocedure);
 IF position('-- PAY-D1 held-source-columns' IN src)=0 THEN
  IF position($q$ARRAY['metadata','metadata_scrubbed_at','updated_at']$q$ IN src)=0 THEN
   RAISE EXCEPTION 'PAY_DISPUTE_HELD_SOURCE_PATCH'; END IF;
  src:=replace(src,$q$ARRAY['metadata','metadata_scrubbed_at','updated_at']$q$,
   $q$ARRAY['metadata','metadata_scrubbed_at','updated_at','dispute_frozen','dispute_frozen_credits']$q$);
  EXECUTE replace(src,'BEGIN',E'BEGIN\n -- PAY-D1 held-source-columns');
 END IF;
END $patch$;

-- Excess settlement consumes the reservation's own frozen source before touching other available credits.
-- The original bound period has already increased consumed_amount; other paid sources use D0 attribution.
CREATE OR REPLACE FUNCTION public.pay_dispute_overrun(p_user uuid,p_pre uuid,p_period uuid,p_period_delta integer,p_extra integer)
RETURNS TABLE(period_taken integer,other_taken integer)
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE src record;n integer;need integer;
BEGIN
 period_taken:=0;other_taken:=0;
 IF coalesce(p_extra,0)<=0 THEN RETURN NEXT;RETURN; END IF;
 PERFORM 1 FROM subscription_credit_grants WHERE user_id=p_user ORDER BY id FOR UPDATE;
 PERFORM 1 FROM credit_package_sources WHERE user_id=p_user ORDER BY id FOR UPDATE;
 SELECT least(dispute_frozen_credits,p_period_delta) INTO period_taken FROM subscription_credit_grants
  WHERE id=p_period AND user_id=p_user AND dispute_frozen AND p_period_delta>0;
 UPDATE subscription_credit_grants SET dispute_frozen_credits=dispute_frozen_credits-coalesce(period_taken,0) WHERE id=p_period;
 period_taken:=coalesce(period_taken,0);
 need:=greatest(p_extra-coalesce(p_period_delta,0),0);
 FOR src IN SELECT e.source_kind,e.source_id FROM credit_source_entries e WHERE e.user_id=p_user AND e.pre_deduct_id=p_pre
  AND e.applied AND e.source_kind<>'unattributed' GROUP BY e.source_kind,e.source_id HAVING sum(e.amount)>0
  ORDER BY max(e.id) DESC LOOP
  EXIT WHEN need=0;
  IF src.source_kind='subscription_grant' THEN
   SELECT least(need,dispute_frozen_credits,credits_granted-consumed_amount) INTO n FROM subscription_credit_grants
    WHERE id=src.source_id AND dispute_frozen AND status='granted';
   IF coalesce(n,0)>0 THEN UPDATE subscription_credit_grants SET consumed_amount=consumed_amount+n,
    dispute_frozen_credits=dispute_frozen_credits-n WHERE id=src.source_id; END IF;
  ELSE
   SELECT least(need,dispute_frozen_credits,credits_granted-consumed_amount) INTO n FROM credit_package_sources
    WHERE id=src.source_id AND dispute_frozen AND status='granted';
   IF coalesce(n,0)>0 THEN UPDATE credit_package_sources SET consumed_amount=consumed_amount+n,
    dispute_frozen_credits=dispute_frozen_credits-n WHERE id=src.source_id; END IF;
  END IF;
  IF coalesce(n,0)>0 THEN
   INSERT INTO credit_source_entries(user_id,pre_deduct_id,source_kind,source_id,amount,reason)
    VALUES(p_user,p_pre,src.source_kind,src.source_id,n,'settle');
   other_taken:=other_taken+n;need:=need-n;
  END IF;
 END LOOP;
 RETURN NEXT;
END $$;
DO $patch$ DECLARE f text;src text;BEGIN
 FOREACH f IN ARRAY ARRAY['public.bill2_legacy_settle(uuid,uuid,integer,jsonb,jsonb)',
  'public.bill2_legacy_abort_settle(uuid,uuid,integer,jsonb,text,text)'] LOOP
  src:=pg_get_functiondef(f::regprocedure);
  IF position('-- PAY-D1 frozen-overrun' IN src)>0 THEN CONTINUE; END IF;
  IF array_length(string_to_array(src,'v_balance_after := v_current_balance + v_balance_delta;'),1)<>2
   OR position('-v_balance_delta - v_period_delta' IN src)=0 THEN RAISE EXCEPTION 'PAY_DISPUTE_OVERRUN_PATCH: %',f; END IF;
  src:=replace(src,E'DECLARE\n',E'DECLARE\n  v_dispute_period integer:=0; v_dispute_other integer:=0;\n');
  src:=replace(src,'v_balance_after := v_current_balance + v_balance_delta;',
   E'IF v_balance_delta<0 THEN\n    SELECT period_taken,other_taken INTO v_dispute_period,v_dispute_other\n'
   ||E'    FROM pay_dispute_overrun(p_user_id,p_pre_deduct_id,v_charged_grant_id,v_period_delta,-v_balance_delta);\n'
   ||E'    v_balance_delta:=v_balance_delta+v_dispute_period+v_dispute_other;\n  END IF;\n'
   ||E'  v_balance_after := v_current_balance + v_balance_delta; -- PAY-D1 frozen-overrun\n');
  src:=replace(src,'-v_balance_delta - v_period_delta','-v_balance_delta - v_period_delta + v_dispute_period');
  EXECUTE src;
 END LOOP;
END $patch$;

CREATE OR REPLACE FUNCTION public.pay_dispute_match(p_dispute uuid,p_order uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d payment_disputes;o payment_orders;provider_sub text;locked_sub text;
BEGIN
 SELECT * INTO d FROM payment_disputes WHERE id=p_dispute;
 IF d.id IS NULL THEN RAISE EXCEPTION 'PAY_DISPUTE_MATCH_CONFLICT'; END IF;
 o:=pay_dispute_resolve_order(d.payment_key,p_order,d.merchant_namespace,d.mode);
 IF o.id IS NULL THEN RAISE EXCEPTION 'PAY_DISPUTE_MATCH_CONFLICT'; END IF;
 provider_sub:=pay_dispute_order_subscription(o.id,d.provider_subscription_id);
 locked_sub:=provider_sub;
 PERFORM pay_dispute_lock(d.payment_key,CASE WHEN provider_sub IS NOT NULL THEN
  d.merchant_namespace||':'||d.mode||':'||provider_sub END);
 SELECT * INTO d FROM payment_disputes WHERE id=p_dispute;
 o:=pay_dispute_resolve_order(d.payment_key,p_order,d.merchant_namespace,d.mode);
 provider_sub:=pay_dispute_order_subscription(o.id,d.provider_subscription_id);
 IF provider_sub IS DISTINCT FROM locked_sub THEN RAISE EXCEPTION 'PAY_DISPUTE_MAPPING_RETRY' USING ERRCODE='40001'; END IF;
 PERFORM 1 FROM profiles WHERE id=o.user_id FOR UPDATE;
 UPDATE payment_orders SET dispute_payment_key=d.payment_key,dispute_subscription_key=CASE WHEN provider_sub IS NOT NULL
  THEN d.merchant_namespace||':'||d.mode||':'||provider_sub END WHERE id=o.id;
 PERFORM pay_dispute_evidence(o.id);
 UPDATE payment_disputes SET order_id=o.id,subscription_id=o.subscription_id,
  provider_subscription_id=coalesce(provider_subscription_id,provider_sub) WHERE id=d.id AND (order_id IS NULL OR order_id=o.id);
 IF NOT FOUND THEN RAISE EXCEPTION 'PAY_DISPUTE_MATCH_CONFLICT'; END IF;
 PERFORM pay_dispute_freeze(d.id);
 PERFORM pay_dispute_evidence(o.id);
 RETURN (SELECT to_jsonb(x) FROM payment_disputes x WHERE id=d.id);
END $$;
CREATE OR REPLACE FUNCTION public.pay_dispute_stop_claim(p_dispute uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE payment_disputes SET stop_attempts=stop_attempts+1 WHERE id=p_dispute AND provider_subscription_id IS NOT NULL
  AND renewal_stop_state IN ('pending','manual') AND stop_attempts<3;
 RETURN FOUND;
END $$;
CREATE OR REPLACE FUNCTION public.pay_dispute_stop_confirm(p_dispute uuid,p_canceled boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d payment_disputes;i jsonb;prior text;
BEGIN
 SELECT * INTO d FROM payment_disputes WHERE id=p_dispute;
 PERFORM pay_dispute_lock(d.payment_key,CASE WHEN d.provider_subscription_id IS NOT NULL THEN
  d.merchant_namespace||':'||d.mode||':'||d.provider_subscription_id END);
 IF d.id IS NULL OR d.provider_subscription_id IS NULL THEN RAISE EXCEPTION 'PAY_DISPUTE_STOP_SCOPE'; END IF;
 IF d.subscription_id IS NOT NULL THEN
  PERFORM 1 FROM profiles WHERE id=(SELECT user_id FROM user_subscriptions WHERE id=d.subscription_id) FOR UPDATE;
  SELECT refund_approval INTO i FROM payment_orders WHERE subscription_id=d.subscription_id
   AND refund_approval->>'kind'='monthly_first_purchase' AND refund_approval->>'hold'='held' LIMIT 1;
  prior:=current_setting('pay_common.monthly_transition',true);
  IF i IS NOT NULL THEN PERFORM set_config('pay_common.monthly_transition',i->>'id',true); END IF;
  PERFORM pay_stripe_mp_sync_subscription(d.subscription_id,d.merchant_namespace,true,p_canceled,false);
  PERFORM set_config('pay_common.monthly_transition',coalesce(prior,''),true);
 END IF;
 UPDATE payment_disputes SET renewal_stop_state='confirmed' WHERE id=d.id;
END $$;

-- One durable intent per undelivered renewal; retries cannot create a new refund after Stripe's idempotency window.
CREATE OR REPLACE FUNCTION public.pay_dispute_refund_claim(p_order uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o payment_orders;
BEGIN
 PERFORM pay_dispute_order_lock(p_order);
 PERFORM 1 FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=p_order) FOR UPDATE;
 SELECT * INTO o FROM payment_orders WHERE id=p_order FOR UPDATE;
 IF o.id IS NULL OR o.fulfilled_at IS NOT NULL OR o.payment_channel IS DISTINCT FROM 'stripe'
  OR o.payment_method NOT IN ('card','card_cn') OR o.source_order_id IS NULL OR o.dispute_payment_key IS NULL
  OR o.payment_status NOT IN ('paid','refunded') OR o.dispute_refund_status IS NULL THEN
  RAISE EXCEPTION 'PAY_DISPUTE_REFUND_SCOPE'; END IF;
 IF o.dispute_refund_status='blocked' THEN
  UPDATE payment_orders SET dispute_refund_status='dispatching',dispute_refund_claimed_at=clock_timestamp()
   WHERE id=o.id RETURNING * INTO o;
 END IF;
 RETURN jsonb_build_object('status',o.dispute_refund_status,'claimedAt',o.dispute_refund_claimed_at,'refundId',o.dispute_refund_id,
  'idempotencyKey','dispute:renewal-refund:'||o.id,'orderId',o.id,'paymentKey',o.dispute_payment_key);
END $$;
CREATE OR REPLACE FUNCTION public.pay_dispute_refund_result(p_order uuid,p_state text,p_refund text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o payment_orders;
BEGIN
 PERFORM pay_dispute_order_lock(p_order);
 PERFORM 1 FROM profiles WHERE id=(SELECT user_id FROM payment_orders WHERE id=p_order) FOR UPDATE;
 SELECT * INTO o FROM payment_orders WHERE id=p_order FOR UPDATE;
 IF o.dispute_refund_status IS NULL OR p_state NOT IN ('pending','succeeded','manual') OR p_state IS NULL
  OR p_refund IS NOT NULL AND p_refund !~ '^(re|pyr)_[A-Za-z0-9_]{1,160}$'
  OR o.dispute_refund_id IS NOT NULL AND p_refund IS NOT NULL AND o.dispute_refund_id IS DISTINCT FROM p_refund
  OR p_state IN ('pending','succeeded') AND p_refund IS NULL THEN RAISE EXCEPTION 'PAY_DISPUTE_REFUND_RESULT'; END IF;
 IF o.dispute_refund_status='succeeded' THEN RETURN; END IF;
 UPDATE payment_orders SET dispute_refund_status=p_state,dispute_refund_id=coalesce(dispute_refund_id,p_refund) WHERE id=o.id;
END $$;

DO $patch$ DECLARE p record;src text;BEGIN
 FOR p IN SELECT * FROM (VALUES
 ('public.pay_common_monthly_refund_finish(uuid,uuid,uuid,jsonb)',
  'OR sub->>''cancelAtPeriodEnd'' IS DISTINCT FROM t->>''originalCancelAtPeriodEnd''',
  'OR (sub->>''cancelAtPeriodEnd'' IS DISTINCT FROM t->>''originalCancelAtPeriodEnd'' AND NOT pay_dispute_order_frozen(p_order))',
  'monthly-restore-observation'),
 ('public.pay_common_monthly_refund_finish(uuid,uuid,uuid,jsonb)',
  'UPDATE user_subscriptions SET status=''active'',cancel_at_period_end=t->>''originalCancelAtPeriodEnd''',
  'UPDATE user_subscriptions SET status=''active'',cancel_at_period_end=CASE WHEN pay_dispute_order_frozen(p_order) THEN ''true'' ELSE t->>''originalCancelAtPeriodEnd'' END',
  'monthly-restore-stop'),
 ('public.bill2_payg_compensate(bill2_runs,bill2_calls)',
  'g.credit_release_terminated_at IS NULL AND g.period_end>clock_timestamp()',
  'g.credit_release_terminated_at IS NULL AND (g.dispute_frozen OR g.period_end>clock_timestamp())','compensate-frozen')
 ) x(sig,anchor,replacement,marker) LOOP
  src:=pg_get_functiondef(p.sig::regprocedure);
  IF position('-- PAY-D1 '||p.marker IN src)>0 THEN CONTINUE; END IF;
  IF array_length(string_to_array(src,p.anchor),1)<>2 THEN RAISE EXCEPTION 'PAY_DISPUTE_PATCH_MISMATCH: % %',p.sig,p.marker; END IF;
  EXECUTE replace(src,p.anchor,p.replacement||' -- PAY-D1 '||p.marker||E'\n');
 END LOOP;
END $patch$;

-- PAY-EVIDENCE is a separate task. When its table is installed, this is the shared retention boundary;
-- no evidence content is read or retained here. The evidence cleaner must use this exact root-order lock.
CREATE OR REPLACE FUNCTION public.pay_dispute_evidence(p_order uuid,p_closed_at timestamptz DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE root uuid;next_ uuid;seen uuid[]:='{}';open_ boolean;closed_ timestamptz;
BEGIN
 IF p_order IS NULL OR to_regclass('public.payment_order_evidence') IS NULL THEN RETURN; END IF;
 root:=p_order;
 LOOP
  IF root=ANY(seen) OR cardinality(seen)>=32 THEN RAISE EXCEPTION 'PAY_DISPUTE_EVIDENCE_ORDER_CYCLE'; END IF;
  seen:=array_append(seen,root);
  SELECT source_order_id INTO next_ FROM payment_orders WHERE id=root;
  EXIT WHEN next_ IS NULL;root:=next_;
 END LOOP;
 PERFORM pg_advisory_xact_lock(hashtextextended('payment-evidence:'||root::text,0));
 WITH RECURSIVE orders AS (
  SELECT id FROM payment_orders WHERE id=root
  UNION SELECT o.id FROM payment_orders o JOIN orders prior ON o.source_order_id=prior.id)
 SELECT coalesce(bool_or(d.closed_at IS NULL AND d.freeze_state NOT IN ('superseded','external')),false),max(d.closed_at)
  INTO open_,closed_ FROM payment_disputes d JOIN orders o ON o.id=d.order_id;
 closed_:=greatest(closed_,p_closed_at);
 EXECUTE 'UPDATE public.payment_order_evidence SET hold_reason=CASE WHEN $2 THEN ''payment_dispute'' END,
  pending_delete_at=CASE WHEN $2 OR $3 IS NOT NULL THEN NULL ELSE pending_delete_at END,
  expires_at=CASE WHEN $3 IS NULL THEN expires_at ELSE greatest(expires_at,$3+interval ''90 days'') END WHERE order_id=$1'
 USING root,open_,closed_;
END $$;
DO $patch$ DECLARE p record;src text;BEGIN
 FOR p IN SELECT * FROM (VALUES
 ('public.pay_dispute_receive(text,text,jsonb)',
  'at_:=(p_event->>''created'')::timestamptz;',
  'PERFORM pay_dispute_evidence(o.id); at_:=(p_event->>''created'')::timestamptz;','evidence-before'),
 ('public.pay_dispute_receive(text,text,jsonb)',
  'PERFORM pay_dispute_freeze(d.id);',
  'PERFORM pay_dispute_freeze(d.id); PERFORM pay_dispute_evidence(o.id,(SELECT closed_at FROM payment_disputes WHERE id=d.id));','evidence-after'),
 ('public.pay_dispute_claim_pending(uuid)',
  'UPDATE payment_disputes SET order_id=o.id,subscription_id=o.subscription_id',
  'PERFORM pay_dispute_evidence(o.id); UPDATE payment_disputes SET order_id=o.id,subscription_id=o.subscription_id','evidence-pending'),
 ('public.pay_dispute_supersede(uuid)',
  'RETURN total;',
  'PERFORM pay_dispute_evidence(p_order,clock_timestamp()); RETURN total;','evidence-refund')
 ) x(sig,anchor,replacement,marker) LOOP
  src:=pg_get_functiondef(p.sig::regprocedure);
  IF position('-- PAY-D1 '||p.marker IN src)>0 THEN CONTINUE; END IF;
  IF array_length(string_to_array(src,p.anchor),1)<>2 THEN RAISE EXCEPTION 'PAY_DISPUTE_PATCH_MISMATCH: % %',p.sig,p.marker; END IF;
  EXECUTE replace(src,p.anchor,p.replacement||' -- PAY-D1 '||p.marker||E'\n');
 END LOOP;
END $patch$;

-- A hold converted to a full refund must also intercept credits later returned by reservations in flight.
-- Packs reuse 0285's existing late-clawback mechanism; internal subscription sources use the same deferred pattern.
ALTER TABLE public.subscription_credit_grants ADD COLUMN IF NOT EXISTS dispute_refund_due integer NOT NULL DEFAULT 0
 CHECK(dispute_refund_due>=0);
CREATE OR REPLACE FUNCTION public.pay_dispute_subscription_return(p_user uuid,p_source uuid,p_n integer) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF coalesce(p_n,0)<=0 THEN RETURN; END IF;
 UPDATE subscription_credit_grants g SET dispute_refund_due=dispute_refund_due+p_n
  WHERE g.id=p_source AND g.user_id=p_user AND g.status='reversed'
   AND EXISTS(SELECT 1 FROM payment_disputes WHERE order_id=g.source_order_id AND freeze_state='superseded');
END $$;
DO $patch$ DECLARE p record;src text;BEGIN
 FOR p IN SELECT * FROM (VALUES
 ('public.pay_dispute_supersede(uuid)',
  'status=CASE WHEN dispute_frozen THEN ''reversed'' ELSE status END WHERE order_id=p_order;',
  'refund_review=CASE WHEN dispute_frozen THEN ''clawback'' ELSE refund_review END, '
   ||'refund_reviewed_at=CASE WHEN dispute_frozen THEN clock_timestamp() ELSE refund_reviewed_at END, '
   ||'status=CASE WHEN dispute_frozen THEN ''reversed'' ELSE status END WHERE order_id=p_order;','superseded-pack-return'),
 ('public.credit_source_apply(uuid,uuid,integer,text)',
  E'   ok:=FOUND;\n  ELSIF src.source_kind=''credit_package'' THEN',
  E'   ok:=FOUND;\n   IF NOT ok THEN PERFORM pay_dispute_subscription_return(p_user,src.source_id,x); END IF;\n'
   ||E'  ELSIF src.source_kind=''credit_package'' THEN','superseded-grant-return'),
 ('public.bill2_payg_compensate(bill2_runs,bill2_calls)',
  E'BEGIN\n',
  E'BEGIN\n PERFORM 1 FROM profiles WHERE id=r.actor_id FOR UPDATE;','compensate-lock-order'),
 ('public.pay_dispute_source_sync()',
  'IF NOT s.dispute_frozen THEN RETURN NULL; END IF;',
  E'IF TG_TABLE_NAME=''subscription_credit_grants'' AND (to_jsonb(s)->>''dispute_refund_due'')::integer>0 THEN\n'
   ||E'  n:=(to_jsonb(s)->>''dispute_refund_due'')::integer;delta:=least(greatest(balance,0),n);\n'
   ||E'  UPDATE profiles SET credits=credits-delta WHERE id=s.user_id;\n'
   ||E'  UPDATE subscription_credit_grants SET dispute_refund_due=0 WHERE id=s.id;\n'
   ||E'  INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_order_id,\n'
   ||E'   idempotency_key,balance_before,balance_after,metadata)\n'
   ||E'  VALUES(s.user_id,-delta,''deduction'',''Refunded dispute reservation return'',''refund_clawback'',''refund_clawback'',\n'
   ||E'   ''stripe_refund'',s.order_id,''dispute:refunded-return:''||s.id||'':''||gen_random_uuid(),balance,balance-delta,\n'
   ||E'   jsonb_build_object(''creditsReturned'',n,''creditsShortfall'',n-delta,''shortfallAbsorbedBy'',''graylum''));\n'
   ||E'  balance:=balance-delta;\n END IF;\n IF NOT s.dispute_frozen THEN RETURN NULL; END IF;','superseded-deferred'),
 ('public.pay_dispute_pending_hold(uuid)',
  'greatest(credits_granted-consumed_amount-dispute_frozen_credits,0) n FROM subscription_credit_grants',
  'dispute_refund_due+CASE WHEN dispute_frozen AND status=''granted'' THEN '
   ||'greatest(credits_granted-consumed_amount-dispute_frozen_credits,0) ELSE 0 END n FROM subscription_credit_grants','superseded-pending'),
 ('public.pay_dispute_pending_hold(uuid)',
  'WHERE user_id=p_user AND dispute_frozen AND status=''granted''',
  'WHERE user_id=p_user AND (dispute_frozen AND status=''granted'' OR dispute_refund_due>0)','superseded-pending-filter')
 ) x(sig,anchor,replacement,marker) LOOP
  src:=pg_get_functiondef(p.sig::regprocedure);
  IF position('-- PAY-D1 '||p.marker IN src)>0 THEN CONTINUE; END IF;
  -- The pending-hold filter also occurs on packs. Replace only its first occurrence (the subscription SELECT).
  IF p.marker='superseded-pending-filter' THEN
   IF position(p.anchor IN src)=0 THEN RAISE EXCEPTION 'PAY_DISPUTE_PATCH_MISMATCH: %',p.marker; END IF;
   src:=overlay(src placing p.replacement||' -- PAY-D1 '||p.marker||E'\n' from position(p.anchor IN src) for length(p.anchor));
   EXECUTE src; CONTINUE;
  END IF;
  IF array_length(string_to_array(src,p.anchor),1)<>2 THEN RAISE EXCEPTION 'PAY_DISPUTE_PATCH_MISMATCH: % %',p.sig,p.marker; END IF;
  EXECUTE replace(src,p.anchor,p.replacement||' -- PAY-D1 '||p.marker||E'\n');
 END LOOP;
END $patch$;

DO $patch$ DECLARE p record;src text;BEGIN
 FOR p IN SELECT * FROM (VALUES
 ('public.pay_common_monthly_refund_finish(uuid,uuid,uuid,jsonb)',
  E' PERFORM set_config(''pay_common.monthly_transition'','''',true);\n RETURN i;',
  E' PERFORM set_config(''pay_common.monthly_transition'','''',true);\n'
   ||E' IF cash=''succeeded'' THEN PERFORM pay_dispute_supersede(p_order); END IF;\n'
   ||E' PERFORM pay_common_settle_membership_level((t->>''userId'')::uuid);\n RETURN i;','monthly-finish-freeze'),
 ('public.pay_common_package_refund_result(uuid,uuid,jsonb)',
  E' RETURN i;\nEND',
  E' IF next_status=''succeeded'' THEN PERFORM pay_dispute_supersede(o.id); END IF;\n RETURN i;\nEND','package-finish-freeze')
 ) x(sig,anchor,replacement,marker) LOOP
  src:=pg_get_functiondef(p.sig::regprocedure);
  IF position('-- PAY-D1 '||p.marker IN src)>0 THEN CONTINUE; END IF;
  IF array_length(string_to_array(src,p.anchor),1)<>2 THEN RAISE EXCEPTION 'PAY_DISPUTE_PATCH_MISMATCH: % %',p.sig,p.marker; END IF;
  EXECUTE replace(src,p.anchor,p.replacement||' -- PAY-D1 '||p.marker||E'\n');
 END LOOP;
END $patch$;

DO $patch$ DECLARE src text;anchor text;BEGIN
 src:=pg_get_functiondef('public.credit_source_apply(uuid,uuid,integer,text)'::regprocedure);
 IF position('-- PAY-D1 allocator-pending' IN src)=0 THEN
  anchor:='SELECT balance::bigint+p_n-coalesce(sum(r.remaining) FILTER (WHERE r.usable OR r.held),0) INTO pool';
  IF array_length(string_to_array(src,anchor),1)<>2 THEN RAISE EXCEPTION 'PAY_DISPUTE_ALLOCATOR_PATCH'; END IF;
  EXECUTE replace(src,anchor,
   E'SELECT balance::bigint+p_n-pay_dispute_pending_hold(p_user)\n'
   ||E'   -coalesce((SELECT sum(refund_clawback_due) FROM credit_package_sources WHERE user_id=p_user),0)\n'
   ||E'   -coalesce(sum(r.remaining) FILTER (WHERE r.usable OR r.held),0) INTO pool -- PAY-D1 allocator-pending\n');
 END IF;
END $patch$;

-- A wallet pack keeps its original refund path unless a dispute hold must be converted atomically.
DO $patch$ DECLARE src text;anchor text;BEGIN
 src:=pg_get_functiondef('public.pay_stripe_mp_record_external_refund(uuid,text,text,text,integer,text,timestamptz)'::regprocedure);
 IF position('-- PAY-D1 wallet-pack-convert' IN src)=0 THEN
  anchor:='OR o.item_type=''membership_plan'' AND o.payment_method IN (''wechat_pay'',''alipay'')';
  IF array_length(string_to_array(src,anchor),1)<>2 THEN RAISE EXCEPTION 'PAY_DISPUTE_WALLET_PATCH'; END IF;
  EXECUTE replace(src,anchor,
   E'OR (o.item_type=''membership_plan'' OR o.item_type=''credit_package'' AND pay_dispute_order_frozen(o.id))\n'
   ||E'  AND o.payment_method IN (''wechat_pay'',''alipay'') -- PAY-D1 wallet-pack-convert\n');
 END IF;
END $patch$;

DO $patch$ DECLARE src text;anchor text;BEGIN
 src:=pg_get_functiondef('public.pay_dispute_overrun(uuid,uuid,uuid,integer,integer)'::regprocedure);
 IF position('-- PAY-D1 overrun-review' IN src)=0 THEN
  anchor:=E' END LOOP;\n RETURN NEXT;';
  IF array_length(string_to_array(src,anchor),1)<>2 THEN RAISE EXCEPTION 'PAY_DISPUTE_OVERRUN_REVIEW_PATCH'; END IF;
  EXECUTE replace(src,anchor,E' END LOOP;\n IF p_extra>period_taken+other_taken THEN\n'
   ||E'  UPDATE payment_disputes d SET source_review_required=true,freeze_alerted_at=NULL\n'
   ||E'   WHERE d.freeze_state=''frozen'' AND d.order_id IN (\n'
   ||E'    SELECT source_order_id FROM subscription_credit_grants WHERE id=p_period AND dispute_frozen\n'
   ||E'    UNION SELECT s.order_id FROM credit_source_entries e JOIN credit_package_sources s ON s.id=e.source_id\n'
   ||E'     WHERE e.pre_deduct_id=p_pre AND e.source_kind=''credit_package'' AND s.dispute_frozen\n'
   ||E'    UNION SELECT g.source_order_id FROM credit_source_entries e JOIN subscription_credit_grants g ON g.id=e.source_id\n'
   ||E'     WHERE e.pre_deduct_id=p_pre AND e.source_kind=''subscription_grant'' AND g.dispute_frozen);\n'
   ||E' END IF;\n RETURN NEXT; -- PAY-D1 overrun-review\n');
 END IF;
END $patch$;

-- A fully withdrawn hold is an explained, net-zero adjustment, never consumption.
-- Other negative adjustments and actual spend remain subject to the original refund guards.
CREATE OR REPLACE FUNCTION public.pay_dispute_neutral_adjustment(p_transaction uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM credit_transactions c WHERE c.id=p_transaction AND c.ledger_type='adjustment'
  AND c.counts_as_spend IS DISTINCT FROM true AND c.source_type='payment_order'
  AND c.reason_code IN ('dispute_freeze','dispute_adjustment','dispute_withdraw')
  AND EXISTS(SELECT 1 FROM payment_disputes d WHERE d.order_id=c.source_order_id AND d.freeze_state='withdrawn')
  AND NOT EXISTS(SELECT 1 FROM payment_disputes d WHERE d.order_id=c.source_order_id
   AND d.freeze_state IN ('pending','frozen','review'))
  AND (SELECT coalesce(sum(j.amount),0) FROM credit_transactions j WHERE j.user_id=c.user_id
   AND j.source_order_id=c.source_order_id AND j.source_type='payment_order' AND j.ledger_type='adjustment'
   AND j.reason_code IN ('dispute_freeze','dispute_adjustment','dispute_withdraw'))=0)
$$;
DO $patch$ DECLARE sig text;src text;anchor text;BEGIN
 FOREACH sig IN ARRAY ARRAY['public.pay_common_package_refund_quote(uuid,uuid,uuid,jsonb,text,text)',
  'public.monthly_refund_validate(uuid,uuid,jsonb)'] LOOP
  src:=pg_get_functiondef(sig::regprocedure);
  IF position('-- PAY-D1 withdrawn-refund' IN src)>0 THEN CONTINUE; END IF;
  anchor:='coalesce(c.reason_code,'''')<>''bill2_reserve''';
  IF array_length(string_to_array(src,anchor),1)<>2 THEN RAISE EXCEPTION 'PAY_DISPUTE_REFUND_QUOTE_PATCH: %',sig; END IF;
  EXECUTE replace(src,anchor,anchor||E' AND NOT pay_dispute_neutral_adjustment(c.id) -- PAY-D1 withdrawn-refund\n');
 END LOOP;
END $patch$;

DO $$ DECLARE f record;BEGIN
 FOR f IN SELECT oid::regprocedure sig,proname FROM pg_proc WHERE pronamespace='public'::regnamespace
  AND proname LIKE 'pay_dispute_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.sig);
  IF f.proname IN ('pay_dispute_receive','pay_dispute_withdraw','pay_dispute_fulfill','pay_dispute_renew','pay_dispute_match','pay_dispute_stop_claim','pay_dispute_stop_confirm','pay_dispute_refund_claim','pay_dispute_refund_result') THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.sig); END IF;
 END LOOP;
END $$;
COMMIT;
