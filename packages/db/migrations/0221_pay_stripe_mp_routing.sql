-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-STRIPE-MP PR-1 (0221): new card subscriptions route to Stripe instead of Waffo.
-- `card` = international card through Stripe Managed Payments; `card_cn` = mainland China card
-- subscription through plain Stripe (Owner 2026-10-12, #847 migration plan). Admission only:
-- Waffo orders and subscriptions keep their channel for renewal, cancel, refund and reconciliation.
-- No remote price/config/provider mutation. Rollback: switch card/card_cn off in the routes
-- setting and forward-fix; financial rows are never deleted.
BEGIN;
SET LOCAL lock_timeout='5s';

-- Methods. Existing Waffo card rows keep their shape; new card rows are Stripe.
ALTER TABLE public.payment_orders ADD COLUMN IF NOT EXISTS stripe_managed_payments boolean;
ALTER TABLE public.payment_orders DROP CONSTRAINT IF EXISTS payment_orders_payment_method_check;
ALTER TABLE public.payment_orders ADD CONSTRAINT payment_orders_payment_method_check
  CHECK(payment_method IN ('card','card_cn','wechat_pay','alipay'));
ALTER TABLE public.payment_orders DROP CONSTRAINT IF EXISTS pay_waffo_method_contract;
-- coalesce(...,false): an unknown (NULL) comparison must fail, never pass, in every 0221 contract.
ALTER TABLE public.payment_orders ADD CONSTRAINT pay_waffo_method_contract CHECK(coalesce(payment_method IS NULL OR (
  payment_channel IS NOT NULL AND routing_version IS NOT NULL AND routing_version>0 AND terms_version IS NOT NULL AND terms_accepted_at IS NOT NULL
  AND auto_renew IS NOT NULL AND offer_kind IS NOT NULL AND qualification_state IS NOT NULL
  AND ((payment_method='card' AND payment_channel='waffo' AND mode='subscription' AND auto_renew AND stripe_managed_payments IS NULL)
    OR (payment_method IN ('card','card_cn') AND payment_channel='stripe' AND item_type='membership_plan'
      AND mode='subscription' AND auto_renew AND stripe_managed_payments IS NOT DISTINCT FROM (payment_method='card'))
    OR (payment_method='card' AND payment_channel='stripe' AND item_type='credit_package'
      AND mode='payment' AND NOT auto_renew AND stripe_managed_payments IS TRUE)
    OR (payment_method IN ('wechat_pay','alipay') AND payment_channel='stripe' AND mode='payment' AND NOT auto_renew
      AND stripe_managed_payments IS NULL))
  AND (item_type<>'membership_plan' OR entitlement_term IS NOT NULL)
  AND ((entitlement_start IS NULL AND entitlement_end IS NULL) OR
    (entitlement_start IS NOT NULL AND entitlement_end IS NOT NULL AND entitlement_end>entitlement_start))),false));
DROP TRIGGER IF EXISTS pay_waffo_order_freeze ON public.payment_orders;
CREATE TRIGGER pay_waffo_order_freeze BEFORE UPDATE ON public.payment_orders FOR EACH ROW
  EXECUTE FUNCTION public.pay_common_frozen_guard('payment_method','auto_renew','entitlement_term',
    'routing_version','terms_version','terms_accepted_at','offer_kind','entitlement_start','entitlement_end','qualified_paid_at',
    'stripe_managed_payments');

-- One Stripe account now holds wallet one-time membership prices, card subscription prices and the
-- first-month coupon. Usage separates them; existing membership prices are all recurring.
ALTER TABLE public.payment_provider_refs ADD COLUMN IF NOT EXISTS price_usage text;
UPDATE public.payment_provider_refs SET price_usage=CASE WHEN credit_package_id IS NOT NULL THEN 'package' ELSE 'subscription' END
  WHERE object_type='price' AND price_usage IS NULL;
ALTER TABLE public.payment_provider_refs DROP CONSTRAINT IF EXISTS payment_provider_refs_object_type_check;
ALTER TABLE public.payment_provider_refs ADD CONSTRAINT payment_provider_refs_object_type_check
  CHECK(object_type IN ('price','coupon','checkout','invoice','payment','subscription','refund'));
ALTER TABLE public.payment_provider_refs DROP CONSTRAINT IF EXISTS pay_common_ref_target;
ALTER TABLE public.payment_provider_refs ADD CONSTRAINT pay_common_ref_target CHECK(coalesce(
  (object_type='price' AND num_nonnulls(membership_plan_id,credit_package_id)=1
    AND order_id IS NULL AND subscription_id IS NULL AND billing_cycle IS NOT NULL
    AND ((credit_package_id IS NOT NULL AND billing_cycle='one_time')
      OR (membership_plan_id IS NOT NULL AND billing_cycle IN ('monthly','yearly'))))
  OR (object_type='coupon' AND membership_plan_id IS NOT NULL AND billing_cycle='monthly'
    AND num_nonnulls(credit_package_id,order_id,subscription_id)=0)
  OR (object_type IN ('checkout','invoice','payment','refund') AND order_id IS NOT NULL
    AND num_nonnulls(membership_plan_id,credit_package_id,subscription_id,billing_cycle)=0)
  OR (object_type='subscription' AND subscription_id IS NOT NULL
    AND num_nonnulls(membership_plan_id,credit_package_id,order_id,billing_cycle)=0),false));
ALTER TABLE public.payment_provider_refs DROP CONSTRAINT IF EXISTS pay_stripe_mp_price_usage;
ALTER TABLE public.payment_provider_refs ADD CONSTRAINT pay_stripe_mp_price_usage CHECK(coalesce(
  (object_type NOT IN ('price','coupon') AND price_usage IS NULL)
  OR (object_type='price' AND credit_package_id IS NOT NULL AND price_usage='package')
  OR (object_type='price' AND membership_plan_id IS NOT NULL AND price_usage IN ('subscription','one_time'))
  OR (object_type='coupon' AND channel='stripe' AND price_usage='subscription' AND offer_kind='gold_first30'),false));
-- Old catalog writers do not know the column: prices they insert keep their pre-0221 meaning.
CREATE OR REPLACE FUNCTION public.pay_stripe_mp_price_usage_default() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.object_type='price' AND NEW.price_usage IS NULL THEN
    NEW.price_usage:=CASE WHEN NEW.credit_package_id IS NOT NULL THEN 'package' ELSE 'subscription' END;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.pay_stripe_mp_price_usage_default() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS pay_stripe_mp_price_usage_default ON public.payment_provider_refs;
CREATE TRIGGER pay_stripe_mp_price_usage_default BEFORE INSERT ON public.payment_provider_refs
  FOR EACH ROW EXECUTE FUNCTION public.pay_stripe_mp_price_usage_default();
DROP TRIGGER IF EXISTS pay_stripe_mp_price_usage_freeze ON public.payment_provider_refs;
CREATE TRIGGER pay_stripe_mp_price_usage_freeze BEFORE UPDATE ON public.payment_provider_refs
  FOR EACH ROW EXECUTE FUNCTION public.pay_common_frozen_guard('price_usage');
DROP INDEX IF EXISTS public.pay_common_current_plan_price;
CREATE UNIQUE INDEX pay_common_current_plan_price ON public.payment_provider_refs
  (channel,merchant_namespace,mode,membership_plan_id,billing_cycle,offer_kind,price_usage)
  WHERE object_type='price' AND is_current AND membership_plan_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pay_stripe_mp_current_coupon ON public.payment_provider_refs
  (channel,merchant_namespace,mode,membership_plan_id,offer_kind)
  WHERE object_type='coupon' AND is_current;
-- The old admin catalog save only replaces the recurring/package mapping it manages.
DO $catalog_usage$
DECLARE source text;
BEGIN
  source:=pg_get_functiondef('public.pay_common_save_catalog(text,uuid,jsonb,jsonb,text,text,text)'::regprocedure);
  IF position('price_usage' IN source)=0 THEN
    IF position('UPDATE payment_provider_refs SET is_current=false WHERE package_tier=''legacy'' AND' IN source)=0 THEN
      RAISE EXCEPTION 'PAY_STRIPE_MP_CATALOG_PATCH_MISSING'; END IF;
    source:=replace(source,'UPDATE payment_provider_refs SET is_current=false WHERE package_tier=''legacy'' AND',
      'UPDATE payment_provider_refs SET is_current=false WHERE package_tier=''legacy'' AND price_usage IN (''subscription'',''package'') AND');
    EXECUTE source;
  END IF;
END $catalog_usage$;

-- Routes: `card_cn` is optional (absent = closed) so existing settings stay valid.
CREATE OR REPLACE FUNCTION public.pay_waffo_routes_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v jsonb; m text; prior bigint;
BEGIN
  IF TG_OP<>'INSERT' AND OLD.key='payment_method_routes' AND
    (TG_OP='DELETE' OR NEW.key IS DISTINCT FROM OLD.key) THEN
    RAISE EXCEPTION 'PAY_WAFFO_ROUTES_DELETE_DENIED' USING ERRCODE='42501';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.key<>'payment_method_routes' THEN RETURN NEW; END IF;
  IF current_user NOT IN ('postgres','service_role') THEN
    RAISE EXCEPTION 'PAY_WAFFO_ROUTES_WRITE_DENIED' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(7063,2);
  v:=NEW.value;
  IF jsonb_typeof(v) IS DISTINCT FROM 'object'
    OR NOT(v ?& ARRAY['version','card','wechat_pay','alipay'])
    OR (v-ARRAY['version','card','card_cn','wechat_pay','alipay'])<>'{}'::jsonb
    OR jsonb_typeof(v->'version') IS DISTINCT FROM 'number'
    OR coalesce(v->>'version','') !~ '^[1-9][0-9]{0,9}$' THEN
    RAISE EXCEPTION 'PAY_WAFFO_ROUTES_INVALID' USING ERRCODE='23514';
  END IF;
  FOREACH m IN ARRAY ARRAY['card','card_cn','wechat_pay','alipay'] LOOP
    CONTINUE WHEN m='card_cn' AND NOT v ? 'card_cn';
    IF jsonb_typeof(v->m) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v->m->'enabled') IS DISTINCT FROM 'boolean'
      OR ((v->m)-CASE WHEN m IN ('card','card_cn') THEN ARRAY['enabled'] ELSE ARRAY['enabled','annualVerified'] END)<>'{}'::jsonb
      OR (m NOT IN ('card','card_cn') AND jsonb_typeof(v->m->'annualVerified') IS DISTINCT FROM 'boolean') THEN
      RAISE EXCEPTION 'PAY_WAFFO_ROUTES_INVALID' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF TG_OP='UPDATE' THEN prior:=(OLD.value->>'version')::bigint;
  ELSE SELECT (value->>'version')::bigint INTO prior FROM system_settings WHERE key=NEW.key; END IF;
  IF (v->>'version')::bigint<>coalesce(prior,0)+1 THEN
    RAISE EXCEPTION 'PAY_WAFFO_ROUTE_VERSION_CONFLICT' USING ERRCODE='PT409';
  END IF;
  RETURN NEW;
END $$;

-- `card` used to mean Waffo. A switch opened for Waffo must not open Managed Payments sales.
UPDATE public.system_settings SET value=jsonb_set(value,'{card,enabled}','false')
  ||jsonb_build_object('version',(value->>'version')::bigint+1)
  WHERE key='payment_method_routes' AND (value->'card'->>'enabled')::boolean;

-- Admission: unchanged rules, Stripe channel for every new method, calendar-month first Gold period.
CREATE OR REPLACE FUNCTION public.pay_waffo_admit_purchase(
  p_user uuid,p_item_type text,p_item uuid,p_cycle text,p_method text,p_offer text,
  p_merchant text,p_mode text,p_version bigint,p_terms text,p_digests jsonb,p_transition text,p_prior uuid
) RETURNS public.payment_orders LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor public.profiles; intent public.payment_orders; product jsonb; ref public.payment_provider_refs;
  routes jsonb; selected_channel text; cents integer; credits integer; bonus integer:=0; discount integer:=100;
  snapshot jsonb; term text; ref_count integer:=0; gold jsonb; prior payment_orders; old_sub user_subscriptions;
  recurring boolean;
BEGIN
  IF p_user IS NULL OR p_item IS NULL OR coalesce(p_item_type,'') NOT IN ('membership_plan','credit_package')
    OR coalesce(p_cycle,'') NOT IN ('monthly','yearly','one_time')
    OR (p_item_type='credit_package') IS DISTINCT FROM (p_cycle='one_time')
    OR coalesce(p_method,'') NOT IN ('card','card_cn','wechat_pay','alipay')
    OR coalesce(p_offer,'') NOT IN ('standard','gold_first30','founder','founder_renewal')
    OR coalesce(p_merchant,'') !~ '^[A-Za-z0-9_-]{1,64}$'
    OR coalesce(p_terms,'') !~ '^[A-Za-z0-9_.:-]{1,80}$' THEN
    RAISE EXCEPTION 'PAY_WAFFO_PURCHASE_INVALID' USING ERRCODE='23514';
  END IF;
  IF p_mode IS DISTINCT FROM 'test' THEN
    RAISE EXCEPTION 'PAY_WAFFO_LIVE_DISABLED' USING ERRCODE='23514';
  END IF;
  -- Same lock used by setting saves, then account lock, then identity locks, then founder pool.
  PERFORM pg_advisory_xact_lock_shared(7063,2);
  SELECT * INTO actor FROM profiles WHERE id=p_user FOR UPDATE;
  IF NOT FOUND OR actor.status IS DISTINCT FROM 'active' OR actor.is_deleted::text IS DISTINCT FROM 'false'
    OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=p_user) THEN
    RAISE EXCEPTION 'PAY_WAFFO_ACCOUNT_CLOSED' USING ERRCODE='42501';
  END IF;
  IF p_transition IS NOT NULL THEN
    SELECT * INTO old_sub FROM user_subscriptions WHERE id=p_prior AND user_id=p_user FOR UPDATE;
    SELECT * INTO prior FROM payment_orders WHERE subscription_id=old_sub.id AND user_id=p_user
      AND payment_mode='test' AND payment_status='paid' AND status='completed' AND fulfilled_at IS NOT NULL
      ORDER BY entitlement_end DESC LIMIT 1 FOR UPDATE;
    IF prior.id IS NULL OR prior.payment_method IS NULL OR prior.entitlement_start IS NULL OR prior.entitlement_end IS NULL
      OR p_item_type<>'membership_plan' OR p_transition NOT IN ('upgrade','founder_renewal') THEN
      RAISE EXCEPTION 'PAY_WAFFO_TRANSITION_DENIED'; END IF;
    IF p_transition='upgrade' THEN
      IF prior.purchase_membership_level<>'pro' OR prior.entitlement_end<=now() OR p_offer NOT IN ('standard','gold_first30','founder')
        OR NOT EXISTS(SELECT 1 FROM membership_plans WHERE id=p_item AND level='gold')
        OR EXISTS(SELECT 1 FROM payment_orders WHERE user_id=p_user AND subscription_id<>old_sub.id
          AND purchase_membership_level='gold' AND payment_status='paid' AND entitlement_end>now())
        OR (prior.auto_renew AND (old_sub.status<>'active' OR old_sub.cancel_at_period_end<>'false'
          OR old_sub.method_cancel_requested_at IS NOT NULL OR old_sub.method_observed_at IS NULL
          OR old_sub.method_observed_at<now()-interval '5 minutes' OR old_sub.current_period_end<=now()+interval '48 hours 31 minutes')) THEN
        RAISE EXCEPTION 'PAY_WAFFO_UPGRADE_WAIT'; END IF;
    ELSE
      IF p_offer<>'founder_renewal' OR p_cycle<>'yearly' OR p_item<>prior.item_id
        OR EXISTS(SELECT 1 FROM payment_orders WHERE source_order_id=prior.id AND method_transition='founder_renewal'
          AND fulfilled_at IS NOT NULL)
        OR pay_waffo_founder_deadline(prior.id) IS NULL OR now()>pay_waffo_founder_deadline(prior.id)
        OR (prior.auto_renew AND old_sub.status<>'canceled') THEN RAISE EXCEPTION 'PAY_WAFFO_FOUNDER_EXPIRED'; END IF;
    END IF;
  ELSIF p_prior IS NOT NULL OR p_offer='founder_renewal' THEN RAISE EXCEPTION 'PAY_WAFFO_TRANSITION_DENIED'; END IF;
  -- Any unresolved method/provider blocks switching; returning a new identity would risk a second charge.
  SELECT * INTO intent FROM payment_orders WHERE user_id=p_user AND fulfilled_at IS NULL
    AND purchase_closed_at IS NULL AND (purchase_action='checkout' OR payment_channel IS NULL)
    AND status NOT IN ('refunded','partially_refunded')
    AND (payment_channel IS NOT NULL OR status NOT IN ('failed','canceled','cancelled','expired')
      OR payment_status='paid') ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    IF intent.item_id=p_item AND intent.item_type=p_item_type AND intent.billing_cycle=p_cycle
      AND intent.payment_method=p_method AND intent.offer_kind=p_offer
      AND intent.merchant_namespace=p_merchant AND intent.payment_mode=p_mode AND intent.terms_version=p_terms
      AND intent.method_transition IS NOT DISTINCT FROM p_transition AND intent.method_prior_subscription IS NOT DISTINCT FROM p_prior THEN
      RETURN intent;
    END IF;
    RAISE EXCEPTION 'PAY_WAFFO_PURCHASE_PENDING' USING ERRCODE='23514';
  END IF;
  SELECT value INTO routes FROM system_settings WHERE key='payment_method_routes';
  IF routes IS NULL OR (routes->p_method->>'enabled')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PAY_WAFFO_SALES_DISABLED' USING ERRCODE='23514';
  END IF;
  IF (routes->>'version')::bigint IS DISTINCT FROM p_version THEN
    RAISE EXCEPTION 'PAY_WAFFO_ROUTE_VERSION_CONFLICT' USING ERRCODE='PT409';
  END IF;
  IF p_method NOT IN ('card','card_cn') AND p_cycle='yearly' AND
    (routes->p_method->>'annualVerified')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PAY_WAFFO_ANNUAL_UNVERIFIED' USING ERRCODE='23514';
  END IF;
  -- Card credit packages are one-time Managed Payments sales; mainland users buy packs by wallet.
  IF p_method='card_cn' AND p_item_type='credit_package' THEN
    RAISE EXCEPTION 'PAY_WAFFO_METHOD_DENIED' USING ERRCODE='23514';
  END IF;
  -- Owner 2026-10-12: new card sales use Stripe (Managed Payments for card, plain Stripe for card_cn).
  -- Waffo stays for its existing orders and subscriptions only.
  selected_channel:='stripe';
  recurring:=p_item_type='membership_plan' AND p_method IN ('card','card_cn');
  IF p_item_type='membership_plan' THEN
    SELECT to_jsonb(p) INTO product FROM membership_plans p WHERE id=p_item AND is_active='true'
      AND level IN ('pro','gold') FOR SHARE;
    IF product IS NULL THEN RAISE EXCEPTION 'PAY_WAFFO_PRODUCT_UNAVAILABLE' USING ERRCODE='23514'; END IF;
    -- Existing tables remain the catalog authority; old staging prices are never silently charged.
    cents:=(product->>CASE p_cycle WHEN 'monthly' THEN 'monthly_price' ELSE 'yearly_price' END)::integer;
    credits:=(product->>'monthly_credits')::integer;
    IF cents IS DISTINCT FROM (CASE WHEN product->>'level'='pro' THEN
        CASE p_cycle WHEN 'monthly' THEN 2900 ELSE 27900 END ELSE
        CASE p_cycle WHEN 'monthly' THEN 6900 ELSE 62100 END END)
      OR credits IS DISTINCT FROM (CASE product->>'level' WHEN 'pro' THEN 3480 ELSE 8970 END) THEN
      RAISE EXCEPTION 'PAY_WAFFO_CATALOG_NOT_READY' USING ERRCODE='23514';
    END IF;
    IF p_cycle='yearly' AND (product->>'yearly_credits')::integer IS DISTINCT FROM credits*12 THEN
      RAISE EXCEPTION 'PAY_WAFFO_CATALOG_NOT_READY' USING ERRCODE='23514';
    END IF;
    IF p_offer<>'standard' AND product->>'level'<>'gold'
      OR p_offer='gold_first30' AND p_cycle<>'monthly'
      OR p_offer IN ('founder','founder_renewal') AND p_cycle<>'yearly' THEN
      RAISE EXCEPTION 'PAY_WAFFO_OFFER_INVALID' USING ERRCODE='23514';
    END IF;
    IF p_transition IS NULL AND (actor.membership_level<>'free' OR EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=p_user
      AND (s.status IN ('active','trialing','past_due','incomplete','unpaid') OR s.current_period_end>now()))) THEN
      -- Upgrade and founder renewal require the controlled PR-2 transition, never a second ordinary checkout.
      RAISE EXCEPTION 'PAY_WAFFO_MEMBERSHIP_TRANSITION_REQUIRED' USING ERRCODE='23514';
    END IF;
    term:=CASE p_cycle WHEN 'monthly' THEN 'month' ELSE 'year' END;
    IF product->>'level'='gold' THEN
      PERFORM pay_waffo_lock_identities(p_digests,p_mode);
      gold:=pay_waffo_gold_digests(p_digests);
      PERFORM pay_waffo_lock_identities(gold,p_mode);
      IF EXISTS(SELECT 1 FROM payment_orders o CROSS JOIN LATERAL jsonb_array_elements(o.gold_identity_digests) d
        JOIN jsonb_array_elements(gold) i ON d=i WHERE o.payment_mode=p_mode
        AND o.qualification_state IN ('reserved','review')
        AND (p_offer='gold_first30' OR o.offer_kind='gold_first30')) THEN
        RAISE EXCEPTION 'PAY_WAFFO_GOLD_FIRST_INELIGIBLE' USING ERRCODE='23514';
      END IF;
      IF p_offer='gold_first30' AND (
        EXISTS(SELECT 1 FROM payment_orders o WHERE o.user_id=p_user
          AND (o.payment_mode=p_mode OR o.payment_mode IS NULL AND p_mode='live')
          AND (o.purchase_membership_level='gold' OR o.metadata->>'membershipLevel'='gold'
            OR EXISTS(SELECT 1 FROM membership_plans p WHERE p.id=o.item_id AND p.level='gold'))
          AND (o.payment_status IN ('paid','refunded','partially_refunded') OR o.fulfilled_at IS NOT NULL))
        OR EXISTS(SELECT 1 FROM opening_grant_identity_digests d JOIN jsonb_array_elements(gold) i
          ON d.kind=i->>'kind' AND d.key_version=i->>'key_version' AND d.digest=i->>'digest'
          WHERE d.purpose='gold_purchase_'||p_mode AND d.expires_at>now())
        OR EXISTS(SELECT 1 FROM payment_orders o CROSS JOIN LATERAL jsonb_array_elements(o.gold_identity_digests) d
          JOIN jsonb_array_elements(gold) i ON d=i
          WHERE o.payment_mode=p_mode AND (o.qualification_state IN ('reserved','review')
            OR o.qualification_state='sold' AND now()<date_trunc('year',coalesce(o.qualified_paid_at,o.created_at),'UTC')+interval '2 years'))
      ) THEN RAISE EXCEPTION 'PAY_WAFFO_GOLD_FIRST_INELIGIBLE' USING ERRCODE='23514'; END IF;
    END IF;
    -- Owner 2026-10-12: the first Gold period is one calendar month for every method (offer id kept).
    IF p_offer='gold_first30' THEN cents:=4900; END IF;
    IF p_offer='founder_renewal' THEN cents:=49600; END IF;
    IF p_offer='founder' THEN
      PERFORM pg_advisory_xact_lock(7063,CASE p_mode WHEN 'test' THEN 3 ELSE 4 END);
      IF EXISTS(SELECT 1 FROM payment_orders WHERE user_id=p_user AND payment_mode=p_mode
        AND offer_kind IN ('founder','founder_renewal') AND qualification_state='sold') THEN
        RAISE EXCEPTION 'PAY_WAFFO_FOUNDER_RENEWAL_REQUIRED' USING ERRCODE='23514';
      END IF;
      IF (SELECT count(*) FROM payment_orders WHERE payment_mode=p_mode AND offer_kind='founder'
        AND (qualification_state IN ('reserved','sold')
          OR qualification_state='review' AND qualification_closed_ref IS NULL))>=50 THEN
        RAISE EXCEPTION 'PAY_WAFFO_FOUNDER_SOLD_OUT' USING ERRCODE='23514';
      END IF;
      cents:=49600;
    END IF;
  ELSE
    IF p_offer<>'standard' OR actor.membership_level NOT IN ('pro','gold') THEN
      RAISE EXCEPTION 'PAY_WAFFO_MEMBERSHIP_REQUIRED' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM user_subscriptions sub JOIN membership_plans plan ON plan.id=sub.membership_plan_id
        JOIN payment_orders paid ON paid.subscription_id=sub.id AND paid.user_id=sub.user_id
        WHERE sub.user_id=p_user AND sub.payment_mode=p_mode AND sub.stripe_subscription_id IS NULL
          AND sub.current_period_start<=now() AND sub.current_period_end>now()
          AND sub.status IN ('active','canceled','cancelled') AND plan.level=actor.membership_level
          AND paid.payment_mode=p_mode AND paid.payment_channel=sub.payment_channel
          AND paid.merchant_namespace=sub.merchant_namespace AND paid.payment_status='paid'
          AND paid.status='completed' AND paid.fulfilled_at IS NOT NULL AND paid.qualification_state='sold'
          AND paid.entitlement_start<=now() AND paid.entitlement_end>now()) THEN
      -- Historical internal rows do not hide a valid membership from the original Stripe source.
      IF NOT EXISTS(SELECT 1 FROM user_subscriptions sub JOIN membership_plans plan ON plan.id=sub.membership_plan_id
        WHERE sub.user_id=p_user AND sub.payment_channel='stripe' AND sub.payment_mode=p_mode
          AND sub.stripe_subscription_id IS NOT NULL AND plan.level=actor.membership_level
          AND sub.current_period_start<=now() AND sub.current_period_end>now()
          AND sub.status IN ('active','trialing')) THEN
        RAISE EXCEPTION 'PAY_WAFFO_MEMBERSHIP_REQUIRED' USING ERRCODE='23514';
      END IF;
      PERFORM pay_common_assert_purchase_facts(p_user,p_item_type,actor.membership_level);
    END IF;
    SELECT to_jsonb(p) INTO product FROM credit_packages p WHERE id=p_item AND active='true' FOR SHARE;
    IF product IS NULL THEN RAISE EXCEPTION 'PAY_WAFFO_PRODUCT_UNAVAILABLE' USING ERRCODE='23514'; END IF;
    discount:=CASE actor.membership_level WHEN 'pro' THEN 95 ELSE 90 END;
    cents:=floor((product->>'price')::numeric*discount/100/10)::integer*10;
    credits:=(product->>'credits_amount')::integer;
    bonus:=coalesce((product->>'bonus_credits')::integer,0);
    IF ((product->>'price')::integer,credits,bonus) NOT IN ((990,990,0),(2990,2990,0),(9990,9990,1000)) THEN
      RAISE EXCEPTION 'PAY_WAFFO_CATALOG_NOT_READY' USING ERRCODE='23514';
    END IF;
  END IF;
  FOR ref IN SELECT * FROM payment_provider_refs r WHERE r.channel=selected_channel AND r.merchant_namespace=p_merchant
    AND r.mode=p_mode AND r.object_type='price' AND r.billing_cycle=p_cycle AND r.offer_kind=(CASE p_offer WHEN 'founder_renewal' THEN 'founder' ELSE p_offer END) AND r.is_current
    AND r.price_usage=CASE WHEN p_item_type='credit_package' THEN 'package' WHEN recurring THEN 'subscription' ELSE 'one_time' END
    AND CASE p_item_type WHEN 'membership_plan' THEN r.membership_plan_id=p_item ELSE r.credit_package_id=p_item AND r.package_tier=actor.membership_level END
    FOR SHARE LOOP ref_count:=ref_count+1; END LOOP;
  IF ref_count<>1 THEN RAISE EXCEPTION 'PAY_WAFFO_PRICE_MAPPING_MISSING' USING ERRCODE='23514'; END IF;
  IF p_item_type='membership_plan' AND p_cycle='yearly' THEN credits:=credits*12; END IF;
  snapshot:=jsonb_build_object('version',1,'item_type',p_item_type,'item_id',p_item,'item_updated_at',
    to_char((product->>'updated_at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'billing_cycle',p_cycle,'currency','usd','unit','major','price',(cents::numeric/100)::numeric(18,2)::text,
    -- One Stripe price serves wallet, card and card_cn; only Managed Payments sessions add tax on top.
    'discount','0.00','tax_behavior','exclusive','credits',credits,'bonus_credits',bonus);
  INSERT INTO payment_orders(user_id,item_type,item_id,billing_cycle,amount_total,currency,mode,status,payment_status,
    payment_channel,merchant_namespace,payment_mode,purchase_request_id,purchase_payload_hash,purchase_snapshot,
    price_ref_id,purchase_action,purchase_membership_level,payment_method,auto_renew,entitlement_term,routing_version,
    terms_version,terms_accepted_at,offer_kind,qualification_state,gold_identity_digests,method_transition,method_prior_subscription,source_order_id,method_upgrade_charge_at,
    stripe_managed_payments)
  VALUES(p_user,p_item_type,p_item,p_cycle,cents,'usd',CASE WHEN recurring THEN 'subscription' ELSE 'payment' END,
    'pending','unpaid',selected_channel,p_merchant,p_mode,gen_random_uuid(),
    encode(extensions.digest(concat_ws(':',snapshot::text,p_method,p_offer,p_terms,ref.id::text),'sha256'),'hex'),
    snapshot,ref.id,'checkout',product->>'level',p_method,recurring,term,p_version,p_terms,clock_timestamp(),
    p_offer,'reserved',CASE WHEN product->>'level'='gold' THEN gold END,p_transition,p_prior,prior.id,
    CASE WHEN p_transition='upgrade' AND prior.auto_renew THEN old_sub.current_period_end END,
    CASE WHEN p_method IN ('card','card_cn') THEN p_method='card' END) RETURNING * INTO intent;
  RETURN intent;
END $$;

COMMIT;
