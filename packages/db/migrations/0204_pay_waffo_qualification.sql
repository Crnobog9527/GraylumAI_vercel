-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-WAFFO step 1. Provisional 0204; no remote price/config/provider mutation.
-- Keep financial rows on rollback; disable new routes and forward-fix.
BEGIN;
SET LOCAL lock_timeout='5s';

-- Identical provider identifiers in separate modes must remain distinct.
ALTER TABLE public.payment_provider_refs DROP CONSTRAINT IF EXISTS pay_common_ref_identity;
ALTER TABLE public.payment_provider_refs ADD CONSTRAINT pay_common_ref_identity
  UNIQUE(channel,merchant_namespace,mode,object_type,external_id);
DO $patch$
DECLARE source text;
BEGIN
  source:=pg_get_functiondef('public.pay_common_save_catalog(text,uuid,jsonb,jsonb,text,text,text)'::regprocedure);
  IF position('ON CONFLICT(channel,merchant_namespace,object_type,external_id)' IN source)>0 THEN
  source:=replace(source,'ON CONFLICT(channel,merchant_namespace,object_type,external_id)',
    'ON CONFLICT(channel,merchant_namespace,mode,object_type,external_id)');
  source:=replace(source,E'AND object_type=''price'' AND external_id=price->>''external_id'';',
    E'AND mode=p_payment_mode AND object_type=''price'' AND external_id=price->>''external_id'';');
  EXECUTE source;
  END IF;
END $patch$;

-- Derived checkout IDs keep their scope too; unmapped historical rows retain their own uniqueness.
ALTER TABLE public.payment_orders DROP CONSTRAINT IF EXISTS payment_orders_stripe_checkout_session_id_key;
DROP INDEX IF EXISTS public.payment_orders_stripe_checkout_session_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS pay_waffo_scoped_checkout ON public.payment_orders
  (payment_channel,merchant_namespace,payment_mode,stripe_checkout_session_id) WHERE payment_channel IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pay_waffo_legacy_checkout ON public.payment_orders
  (stripe_checkout_session_id) WHERE payment_channel IS NULL;
DO $scope$
DECLARE source text;
BEGIN
  source:=pg_get_functiondef('public.pay_common_record_checkout(uuid,text,text,jsonb)'::regprocedure);
  source:=replace(source,E'\n    AND object_type=''checkout'' AND external_id=session_id;',
    E'\n    AND mode=p_payment_mode AND object_type=''checkout'' AND external_id=session_id;');
  EXECUTE source;
  -- Preserve the existing atomic fulfillment body and locks, adding the trusted connection scope.
  IF to_regprocedure('public.atomic_fulfill_credit_package(text,text,text,text)') IS NULL THEN
    source:=pg_get_functiondef('public.atomic_fulfill_credit_package(text,text)'::regprocedure);
    source:=regexp_replace(source,'p_payment_status text DEFAULT [^)]*',
      'p_payment_status text, p_merchant_namespace text, p_payment_mode text');
    source:=replace(source,'AND external_id=p_checkout_session_id)',
      'AND merchant_namespace=p_merchant_namespace AND mode=p_payment_mode AND external_id=p_checkout_session_id)');
    source:=replace(source,'AND r.external_id=p_checkout_session_id',
      'AND r.merchant_namespace=p_merchant_namespace AND r.mode=p_payment_mode AND r.external_id=p_checkout_session_id');
    EXECUTE source;
  END IF;
END $scope$;
REVOKE ALL ON FUNCTION public.atomic_fulfill_credit_package(text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_fulfill_credit_package(text,text,text,text) TO service_role;
-- Old callers remain compatible only when the external identifier is unambiguous.
CREATE OR REPLACE FUNCTION public.atomic_fulfill_credit_package(
  p_checkout_session_id text,p_payment_status text DEFAULT 'paid'
) RETURNS TABLE(order_id uuid,user_id uuid,granted_credits integer,fulfilled_at timestamptz,already_fulfilled boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ref public.payment_provider_refs;
BEGIN
  IF (SELECT count(*) FROM payment_provider_refs WHERE channel='stripe' AND object_type='checkout'
    AND external_id=p_checkout_session_id)<>1 THEN RAISE EXCEPTION 'PAY_COMMON_CHECKOUT_MAPPING_UNKNOWN'; END IF;
  SELECT * INTO ref FROM payment_provider_refs WHERE channel='stripe' AND object_type='checkout'
    AND external_id=p_checkout_session_id;
  RETURN QUERY SELECT * FROM public.atomic_fulfill_credit_package(
    p_checkout_session_id,p_payment_status,ref.merchant_namespace,ref.mode);
END $$;

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
    OR (v-ARRAY['version','card','wechat_pay','alipay'])<>'{}'::jsonb
    OR jsonb_typeof(v->'version') IS DISTINCT FROM 'number'
    OR coalesce(v->>'version','') !~ '^[1-9][0-9]{0,9}$' THEN
    RAISE EXCEPTION 'PAY_WAFFO_ROUTES_INVALID' USING ERRCODE='23514';
  END IF;
  FOREACH m IN ARRAY ARRAY['card','wechat_pay','alipay'] LOOP
    IF jsonb_typeof(v->m) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v->m->'enabled') IS DISTINCT FROM 'boolean'
      OR ((v->m)-CASE WHEN m='card' THEN ARRAY['enabled'] ELSE ARRAY['enabled','annualVerified'] END)<>'{}'::jsonb
      OR (m<>'card' AND jsonb_typeof(v->m->'annualVerified') IS DISTINCT FROM 'boolean') THEN
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
REVOKE ALL ON FUNCTION public.pay_waffo_routes_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS pay_waffo_routes_guard ON public.system_settings;
CREATE TRIGGER pay_waffo_routes_guard BEFORE INSERT OR UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.pay_waffo_routes_guard();
-- Missing configuration is disabled. No provider catalog or remote settings are seeded.

-- Explicit facts on the existing order, independent of Stripe subscription identifiers.
ALTER TABLE public.payment_orders
  ADD COLUMN IF NOT EXISTS payment_method text CHECK(payment_method IN ('card','wechat_pay','alipay')),
  ADD COLUMN IF NOT EXISTS auto_renew boolean,
  ADD COLUMN IF NOT EXISTS entitlement_term text CHECK(entitlement_term IN ('month','year','days30')),
  ADD COLUMN IF NOT EXISTS entitlement_start timestamptz,
  ADD COLUMN IF NOT EXISTS entitlement_end timestamptz,
  ADD COLUMN IF NOT EXISTS routing_version bigint,
  ADD COLUMN IF NOT EXISTS terms_version text,
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS offer_kind text CHECK(offer_kind IN ('standard','gold_first30','founder','founder_renewal')),
  ADD COLUMN IF NOT EXISTS qualification_state text CHECK(qualification_state IN ('reserved','sold','released','review')),
  ADD COLUMN IF NOT EXISTS qualification_closed_ref text,
  ADD COLUMN IF NOT EXISTS gold_identity_digests jsonb,
  ADD COLUMN IF NOT EXISTS qualified_paid_at timestamptz;
DROP TRIGGER IF EXISTS pay_waffo_order_freeze ON public.payment_orders;
CREATE TRIGGER pay_waffo_order_freeze BEFORE UPDATE ON public.payment_orders FOR EACH ROW
  EXECUTE FUNCTION public.pay_common_frozen_guard('payment_method','auto_renew','entitlement_term',
    'routing_version','terms_version','terms_accepted_at','offer_kind','entitlement_start','entitlement_end','qualified_paid_at');
ALTER TABLE public.payment_orders DROP CONSTRAINT IF EXISTS pay_waffo_method_contract;
ALTER TABLE public.payment_orders ADD CONSTRAINT pay_waffo_method_contract CHECK(payment_method IS NULL OR (
  payment_channel IS NOT NULL AND routing_version IS NOT NULL AND routing_version>0 AND terms_version IS NOT NULL AND terms_accepted_at IS NOT NULL
  AND auto_renew IS NOT NULL AND offer_kind IS NOT NULL AND qualification_state IS NOT NULL
  AND ((payment_method='card' AND payment_channel='waffo' AND mode='subscription' AND auto_renew)
    OR (payment_method IN ('wechat_pay','alipay') AND payment_channel='stripe' AND mode='payment' AND NOT auto_renew))
  AND (item_type<>'membership_plan' OR entitlement_term IS NOT NULL)
  AND ((entitlement_start IS NULL AND entitlement_end IS NULL) OR
    (entitlement_start IS NOT NULL AND entitlement_end IS NOT NULL AND entitlement_end>entitlement_start))));
-- Product variants reuse provider refs; two first-period products no longer collide with standard monthly.
ALTER TABLE public.payment_provider_refs ADD COLUMN IF NOT EXISTS offer_kind text NOT NULL DEFAULT 'standard'
  CHECK(offer_kind IN ('standard','gold_first30','founder'));
DROP INDEX IF EXISTS public.pay_common_current_plan_price;
CREATE UNIQUE INDEX pay_common_current_plan_price ON public.payment_provider_refs
  (channel,merchant_namespace,mode,membership_plan_id,billing_cycle,offer_kind)
  WHERE object_type='price' AND is_current AND membership_plan_id IS NOT NULL;
-- No fake Stripe IDs for Waffo or wallet annual internal memberships.
ALTER TABLE public.user_subscriptions ALTER COLUMN stripe_subscription_id DROP NOT NULL;
ALTER TABLE public.subscription_credit_grants ALTER COLUMN stripe_subscription_id DROP NOT NULL;
ALTER TABLE public.user_subscriptions DROP CONSTRAINT IF EXISTS pay_waffo_subscription_identity;
ALTER TABLE public.user_subscriptions ADD CONSTRAINT pay_waffo_subscription_identity CHECK(
  stripe_subscription_id IS NOT NULL OR (payment_channel IS NOT NULL AND contract_snapshot IS NOT NULL));
ALTER TABLE public.subscription_credit_grants DROP CONSTRAINT IF EXISTS pay_waffo_grant_identity;
ALTER TABLE public.subscription_credit_grants ADD CONSTRAINT pay_waffo_grant_identity CHECK(
  stripe_subscription_id IS NOT NULL OR (subscription_id IS NOT NULL AND source_order_id IS NOT NULL AND grant_snapshot IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS pay_waffo_internal_grant_period ON public.subscription_credit_grants
  (subscription_id,source_order_id,grant_type,grant_period_key) WHERE stripe_subscription_id IS NULL;
ALTER TABLE public.credit_transactions DROP CONSTRAINT IF EXISTS credit_transactions_source_type_check;
ALTER TABLE public.credit_transactions ADD CONSTRAINT credit_transactions_source_type_check CHECK(source_type IS NULL OR
  source_type IN ('stripe_invoice','stripe_checkout','stripe_refund','ai_task','admin','system','payment_order','payment_refund'));

-- Reuse the identity fact table, but with a separate purpose and expiry. No user/profile FK.
ALTER TABLE public.opening_grant_identity_digests
  DROP CONSTRAINT IF EXISTS opening_grant_identity_digests_purpose_check,
  DROP CONSTRAINT IF EXISTS opening_grant_identity_digests_expires_when_check;
ALTER TABLE public.opening_grant_identity_digests ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE public.opening_grant_identity_digests ADD CONSTRAINT opening_grant_identity_digests_purpose_check
  CHECK(purpose IN ('opening_grant','gold_purchase_test','gold_purchase_live'));
ALTER TABLE public.opening_grant_identity_digests ADD CONSTRAINT opening_grant_identity_digests_expires_when_check CHECK(
  (purpose='opening_grant' AND expires_when='opening_grant_rule_removed' AND expires_at IS NULL) OR
  (purpose IN ('gold_purchase_test','gold_purchase_live') AND expires_when='gold_last_transaction_year_plus_one'
    AND expires_at IS NOT NULL AND expires_at=date_trunc('year',expires_at,'UTC')));
CREATE INDEX IF NOT EXISTS pay_waffo_identity_expiry ON public.opening_grant_identity_digests(expires_at)
  WHERE purpose<>'opening_grant';

-- Minimal durable receipt: no raw payload, email, IP or device facts. Not a second financial ledger.
CREATE TABLE IF NOT EXISTS public.waffo_event_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_namespace text NOT NULL CHECK(merchant_namespace ~ '^[A-Za-z0-9_-]{1,64}$'),
  mode text NOT NULL CHECK(mode IN ('test','live')),
  event_type text NOT NULL CHECK(event_type ~ '^[a-z_]+[.][a-z_]+$'),
  event_id text NOT NULL CHECK(length(event_id) BETWEEN 1 AND 160),
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[0-9a-f]{64}$'),
  resource_refs jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL DEFAULT 'received' CHECK(status IN ('received','applied','review')),
  UNIQUE(merchant_namespace,mode,event_type,event_id)
);
ALTER TABLE public.waffo_event_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.waffo_event_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.waffo_event_receipts TO service_role;
CREATE OR REPLACE FUNCTION public.pay_waffo_receive_event(
  p_merchant text,p_mode text,p_type text,p_id text,p_digest text,p_refs jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE receipt public.waffo_event_receipts;
BEGIN
  IF jsonb_typeof(p_refs) IS DISTINCT FROM 'object' OR p_refs='{}'::jsonb
    OR (p_refs-ARRAY['paymentId','subscriptionId','refundId','orderId','checkoutId'])<>'{}'::jsonb
    OR EXISTS(SELECT 1 FROM jsonb_each(p_refs) e WHERE jsonb_typeof(e.value)<>'string'
      OR (e.value#>>'{}') !~ '^[A-Za-z0-9_:-]{1,160}$') THEN
    RAISE EXCEPTION 'PAY_WAFFO_EVENT_RESOURCE_INVALID' USING ERRCODE='23514';
  END IF;
  INSERT INTO waffo_event_receipts(merchant_namespace,mode,event_type,event_id,payload_digest,resource_refs)
    VALUES(p_merchant,p_mode,p_type,p_id,p_digest,p_refs) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT receipt FROM waffo_event_receipts WHERE merchant_namespace=p_merchant
    AND mode=p_mode AND event_type=p_type AND event_id=p_id FOR UPDATE;
  IF receipt.payload_digest IS DISTINCT FROM p_digest OR receipt.resource_refs IS DISTINCT FROM p_refs THEN
    RAISE EXCEPTION 'PAY_WAFFO_EVENT_CONFLICT' USING ERRCODE='23514';
  END IF;
  RETURN receipt.id;
END $$;
REVOKE ALL ON FUNCTION public.pay_waffo_receive_event(text,text,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_waffo_receive_event(text,text,text,text,text,jsonb) TO service_role;

-- Shared identity locks serialize first-Gold purchases even across re-registered accounts.
CREATE OR REPLACE FUNCTION public.pay_waffo_lock_identities(p_digests jsonb,p_mode text)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE item jsonb; lock_key text;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('test','live') OR jsonb_typeof(p_digests) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_digests) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'PAY_WAFFO_IDENTITY_INVALID' USING ERRCODE='23514';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_digests) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR (item-ARRAY['kind','key_version','digest'])<>'{}'::jsonb
      OR jsonb_typeof(item->'kind') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'key_version') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'digest') IS DISTINCT FROM 'string'
      OR coalesce(item->>'kind','') NOT IN ('email','oauth')
      OR coalesce(item->>'key_version','') !~ '^[A-Za-z0-9_-]{1,32}$'
      OR coalesce(item->>'digest','') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'PAY_WAFFO_IDENTITY_INVALID' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM opening_grant_identity_digests d WHERE d.purpose='gold_purchase_'||p_mode
    AND d.expires_at>now() AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_digests) i
      WHERE i->>'key_version'=d.key_version)) THEN
    RAISE EXCEPTION 'PAY_WAFFO_IDENTITY_VERSION_MISSING' USING ERRCODE='23514';
  END IF;
  FOR lock_key IN SELECT DISTINCT p_mode||':'||(i->>'kind')||':'||(i->>'key_version')||':'||(i->>'digest')
    FROM jsonb_array_elements(p_digests) i ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('gold_purchase:'||lock_key,0));
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.pay_waffo_lock_identities(jsonb,text) FROM PUBLIC,anon,authenticated,service_role;

-- Derive a purpose-specific identifier from the existing server-side HMAC; no new key material.
CREATE OR REPLACE FUNCTION public.pay_waffo_gold_digests(p_digests jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT jsonb_agg(jsonb_build_object('kind',i->>'kind','key_version',i->>'key_version',
    'digest',encode(extensions.digest('gold_purchase:'||(i->>'digest'),'sha256'),'hex')))
  FROM jsonb_array_elements(p_digests) i
$$;
REVOKE ALL ON FUNCTION public.pay_waffo_gold_digests(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.pay_waffo_remember_gold(p_user uuid,p_digests jsonb,p_mode text)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE latest timestamptz; expires timestamptz; first_month timestamptz;
BEGIN
  PERFORM pay_waffo_lock_identities(p_digests,p_mode);
  SELECT max(coalesce(o.qualified_paid_at,o.fulfilled_at,o.created_at)) INTO latest FROM payment_orders o
    WHERE o.user_id=p_user AND (o.payment_mode=p_mode OR o.payment_mode IS NULL AND p_mode='live')
    AND (o.purchase_membership_level='gold' OR o.metadata->>'membershipLevel'='gold'
      OR EXISTS(SELECT 1 FROM membership_plans p WHERE p.id=o.item_id AND p.level='gold'))
    AND (o.payment_status IN ('paid','refunded','partially_refunded') OR o.fulfilled_at IS NOT NULL
      OR o.qualification_state='sold');
  IF latest IS NULL THEN RETURN; END IF;
  expires:=date_trunc('year',latest,'UTC')+interval '2 years';
  IF expires<=now() THEN RETURN; END IF;
  first_month:=date_trunc('month',latest,'UTC');
  INSERT INTO opening_grant_identity_digests(purpose,kind,key_version,digest,first_granted_at,expires_when,expires_at)
    SELECT 'gold_purchase_'||p_mode,i->>'kind',i->>'key_version',i->>'digest',first_month,
      'gold_last_transaction_year_plus_one',expires FROM jsonb_array_elements(p_digests) i
    ON CONFLICT(purpose,kind,key_version,digest) DO UPDATE SET
      expires_at=greatest(opening_grant_identity_digests.expires_at,excluded.expires_at),
      first_granted_at=least(opening_grant_identity_digests.first_granted_at,excluded.first_granted_at);
END $$;
REVOKE ALL ON FUNCTION public.pay_waffo_remember_gold(uuid,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;

-- Same atomic close boundary and old signature; old callers cannot omit the Gold retention step.
CREATE OR REPLACE FUNCTION public.account_erasure_confirm_with_digests(
  p_profile_id uuid,p_request_id uuid,p_digests jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE gold jsonb;
BEGIN
  PERFORM 1 FROM profiles WHERE id=p_profile_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_ERASURE_PROFILE_MISSING' USING ERRCODE='P0002'; END IF;
  PERFORM opening_grant_remember(p_profile_id,p_digests,false);
  gold:=pay_waffo_gold_digests(p_digests);
  PERFORM pay_waffo_remember_gold(p_profile_id,gold,'test');
  PERFORM pay_waffo_remember_gold(p_profile_id,gold,'live');
  RETURN account_erasure_confirm(p_profile_id,p_request_id);
END $$;
REVOKE ALL ON FUNCTION public.account_erasure_confirm_with_digests(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.account_erasure_confirm_with_digests(uuid,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.pay_waffo_expire_gold_identities() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
  DELETE FROM opening_grant_identity_digests WHERE purpose IN ('gold_purchase_test','gold_purchase_live')
    AND expires_at<=now();
  GET DIAGNOSTICS n=ROW_COUNT;
  -- A resolved order no longer needs identity material. Pending late-payment recovery retains it.
  UPDATE payment_orders SET gold_identity_digests=NULL WHERE gold_identity_digests IS NOT NULL
    AND qualification_state IN ('sold','released')
    AND coalesce(qualified_paid_at,created_at)<date_trunc('year',now(),'UTC')-interval '1 year';
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.pay_waffo_expire_gold_identities() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_waffo_expire_gold_identities() TO service_role;
CREATE OR REPLACE FUNCTION public.pay_waffo_create_purchase(
  p_user uuid,p_item_type text,p_item uuid,p_cycle text,p_method text,p_offer text,
  p_merchant text,p_mode text,p_version bigint,p_terms text,p_digests jsonb
) RETURNS public.payment_orders LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor public.profiles; intent public.payment_orders; product jsonb; ref public.payment_provider_refs;
  routes jsonb; selected_channel text; cents integer; credits integer; bonus integer:=0; discount integer:=100;
  snapshot jsonb; term text; ref_count integer:=0; gold jsonb;
BEGIN
  IF p_user IS NULL OR p_item IS NULL OR coalesce(p_item_type,'') NOT IN ('membership_plan','credit_package')
    OR coalesce(p_cycle,'') NOT IN ('monthly','yearly','one_time')
    OR (p_item_type='credit_package') IS DISTINCT FROM (p_cycle='one_time')
    OR coalesce(p_method,'') NOT IN ('card','wechat_pay','alipay')
    OR coalesce(p_offer,'') NOT IN ('standard','gold_first30','founder')
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
  -- Any unresolved method/provider blocks switching; returning a new identity would risk a second charge.
  SELECT * INTO intent FROM payment_orders WHERE user_id=p_user AND fulfilled_at IS NULL
    AND purchase_closed_at IS NULL AND (purchase_action='checkout' OR payment_channel IS NULL)
    AND status NOT IN ('refunded','partially_refunded')
    AND (payment_channel IS NOT NULL OR status NOT IN ('failed','canceled','cancelled','expired')
      OR payment_status='paid') ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    IF intent.item_id=p_item AND intent.item_type=p_item_type AND intent.billing_cycle=p_cycle
      AND intent.payment_method=p_method AND intent.offer_kind=p_offer
      AND intent.merchant_namespace=p_merchant AND intent.payment_mode=p_mode AND intent.terms_version=p_terms THEN
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
  IF p_method<>'card' AND p_cycle='yearly' AND
    (routes->p_method->>'annualVerified')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PAY_WAFFO_ANNUAL_UNVERIFIED' USING ERRCODE='23514';
  END IF;
  IF p_method='card' AND p_item_type='credit_package' THEN
    RAISE EXCEPTION 'PAY_WAFFO_METHOD_DENIED' USING ERRCODE='23514';
  END IF;
  selected_channel:=CASE p_method WHEN 'card' THEN 'waffo' ELSE 'stripe' END;
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
      OR p_offer='founder' AND p_cycle<>'yearly' THEN
      RAISE EXCEPTION 'PAY_WAFFO_OFFER_INVALID' USING ERRCODE='23514';
    END IF;
    IF actor.membership_level<>'free' OR EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=p_user
      AND (s.status IN ('active','trialing','past_due','incomplete','unpaid') OR s.current_period_end>now())) THEN
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
    IF p_offer='gold_first30' THEN cents:=4900; term:='days30'; END IF;
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
    IF EXISTS(SELECT 1 FROM user_subscriptions WHERE user_id=p_user AND stripe_subscription_id IS NULL) THEN
      IF NOT EXISTS(SELECT 1 FROM user_subscriptions sub JOIN membership_plans plan ON plan.id=sub.membership_plan_id
        JOIN payment_orders paid ON paid.subscription_id=sub.id AND paid.user_id=sub.user_id
        WHERE sub.user_id=p_user AND sub.payment_mode=p_mode AND sub.stripe_subscription_id IS NULL
          AND sub.current_period_start<=now() AND sub.current_period_end>now()
          AND sub.status IN ('active','canceled','cancelled') AND plan.level=actor.membership_level
          AND paid.payment_mode=p_mode AND paid.payment_channel=sub.payment_channel
          AND paid.merchant_namespace=sub.merchant_namespace AND paid.payment_status='paid'
          AND paid.status='completed' AND paid.fulfilled_at IS NOT NULL AND paid.qualification_state='sold'
          AND paid.entitlement_start<=now() AND paid.entitlement_end>now()) THEN
        RAISE EXCEPTION 'PAY_WAFFO_MEMBERSHIP_REQUIRED' USING ERRCODE='23514';
      END IF;
    ELSE
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
    AND r.mode=p_mode AND r.object_type='price' AND r.billing_cycle=p_cycle AND r.offer_kind=p_offer AND r.is_current
    AND CASE p_item_type WHEN 'membership_plan' THEN r.membership_plan_id=p_item ELSE r.credit_package_id=p_item END
    FOR SHARE LOOP ref_count:=ref_count+1; END LOOP;
  IF ref_count<>1 THEN RAISE EXCEPTION 'PAY_WAFFO_PRICE_MAPPING_MISSING' USING ERRCODE='23514'; END IF;
  IF p_item_type='membership_plan' AND p_cycle='yearly' THEN credits:=credits*12; END IF;
  snapshot:=jsonb_build_object('version',1,'item_type',p_item_type,'item_id',p_item,'item_updated_at',
    to_char((product->>'updated_at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'billing_cycle',p_cycle,'currency','usd','unit','major','price',(cents::numeric/100)::numeric(18,2)::text,
    'discount','0.00','tax_behavior','inclusive','credits',credits,'bonus_credits',bonus);
  INSERT INTO payment_orders(user_id,item_type,item_id,billing_cycle,amount_total,currency,mode,status,payment_status,
    payment_channel,merchant_namespace,payment_mode,purchase_request_id,purchase_payload_hash,purchase_snapshot,
    price_ref_id,purchase_action,purchase_membership_level,payment_method,auto_renew,entitlement_term,routing_version,
    terms_version,terms_accepted_at,offer_kind,qualification_state,gold_identity_digests)
  VALUES(p_user,p_item_type,p_item,p_cycle,cents,'usd',CASE p_method WHEN 'card' THEN 'subscription' ELSE 'payment' END,
    'pending','unpaid',selected_channel,p_merchant,p_mode,gen_random_uuid(),
    encode(extensions.digest(concat_ws(':',snapshot::text,p_method,p_offer,p_terms,ref.id::text),'sha256'),'hex'),
    snapshot,ref.id,'checkout',product->>'level',p_method,p_method='card',term,p_version,p_terms,clock_timestamp(),
    p_offer,'reserved',CASE WHEN product->>'level'='gold' THEN gold END) RETURNING * INTO intent;
  RETURN intent;
END $$;
REVOKE ALL ON FUNCTION public.pay_waffo_create_purchase(uuid,text,uuid,text,text,text,text,text,bigint,text,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_waffo_create_purchase(uuid,text,uuid,text,text,text,text,text,bigint,text,jsonb)
  TO service_role;

-- Only the verified provider adapter may call this service RPC (adapter is PR-2).
-- A confirmed closed/unpaid session releases reservations; browser close and timeout never do.
CREATE OR REPLACE FUNCTION public.pay_waffo_observe_qualification(
  p_order uuid,p_merchant text,p_mode text,p_checkout text,p_state text,p_payment text,
  p_amount integer,p_currency text,p_paid_at timestamptz
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.payment_orders; actor uuid; existing public.payment_provider_refs;
BEGIN
  SELECT user_id INTO actor FROM payment_orders WHERE id=p_order;
  PERFORM 1 FROM profiles WHERE id=actor FOR UPDATE;
  SELECT * INTO o FROM payment_orders WHERE id=p_order FOR UPDATE;
  IF o.id IS NULL OR o.payment_method IS NULL OR o.merchant_namespace IS DISTINCT FROM p_merchant
    OR o.payment_mode IS DISTINCT FROM p_mode OR NOT EXISTS(SELECT 1 FROM payment_provider_refs
      WHERE order_id=o.id AND channel=o.payment_channel AND merchant_namespace=p_merchant AND mode=p_mode
        AND object_type='checkout' AND external_id=p_checkout) THEN
    RAISE EXCEPTION 'PAY_WAFFO_OBSERVATION_SCOPE' USING ERRCODE='23514';
  END IF;
  IF o.gold_identity_digests IS NOT NULL THEN PERFORM pay_waffo_lock_identities(o.gold_identity_digests,p_mode); END IF;
  IF o.offer_kind='founder' THEN
    PERFORM pg_advisory_xact_lock(7063,CASE p_mode WHEN 'test' THEN 3 ELSE 4 END);
  END IF;
  IF p_state='closed_unpaid' THEN
    IF p_payment IS NOT NULL OR p_amount IS DISTINCT FROM 0 OR p_paid_at IS NOT NULL
      OR o.payment_status IS DISTINCT FROM 'unpaid' OR o.fulfilled_at IS NOT NULL
      OR o.qualification_state IN ('sold','review') THEN
      RAISE EXCEPTION 'PAY_WAFFO_NOT_TERMINAL_UNPAID' USING ERRCODE='23514';
    END IF;
    UPDATE payment_orders SET qualification_state='released',qualification_closed_ref=p_checkout,
      purchase_closed_at=coalesce(purchase_closed_at,clock_timestamp()) WHERE id=o.id;
    RETURN 'released';
  END IF;
  IF p_state IS DISTINCT FROM 'paid' OR coalesce(p_payment,'') !~ '^[A-Za-z0-9_:-]{1,160}$'
    OR p_amount IS DISTINCT FROM o.amount_total OR p_amount<=0 OR p_currency IS DISTINCT FROM o.currency
    OR p_paid_at IS NULL OR p_paid_at<o.created_at-interval '5 minutes'
    OR p_paid_at>clock_timestamp()+interval '5 minutes' THEN
    RAISE EXCEPTION 'PAY_WAFFO_PAYMENT_FACT_MISMATCH' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM payment_provider_refs WHERE order_id=o.id AND object_type='payment'
    AND external_id IS DISTINCT FROM p_payment) THEN
    RAISE EXCEPTION 'PAY_WAFFO_EXTRA_PAYMENT_REVIEW' USING ERRCODE='23514';
  END IF;
  INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
    VALUES(o.payment_channel,p_merchant,p_mode,'payment',p_payment,o.id)
    ON CONFLICT ON CONSTRAINT pay_common_ref_identity DO NOTHING;
  SELECT * INTO existing FROM payment_provider_refs WHERE channel=o.payment_channel
    AND merchant_namespace=p_merchant AND mode=p_mode AND object_type='payment' AND external_id=p_payment;
  IF existing.order_id IS DISTINCT FROM o.id THEN
    RAISE EXCEPTION 'PAY_WAFFO_PAYMENT_REBOUND' USING ERRCODE='23514';
  END IF;
  IF o.qualification_state='sold' THEN RETURN 'sold'; END IF;
  IF o.qualification_state IN ('released','review') THEN
    -- Preserve cash evidence, never take a released founder slot back or restore membership.
    UPDATE payment_orders SET qualification_state='review',payment_status='paid' WHERE id=o.id;
    RETURN 'review';
  END IF;
  UPDATE payment_orders SET qualification_state='sold',payment_status='paid',qualified_paid_at=p_paid_at WHERE id=o.id;
  IF o.gold_identity_digests IS NOT NULL THEN
    PERFORM pay_waffo_remember_gold(actor,o.gold_identity_digests,p_mode);
  END IF;
  -- This step does not grant membership/credits. Closed-account handling remains financial only.
  RETURN 'sold';
END $$;
REVOKE ALL ON FUNCTION public.pay_waffo_observe_qualification(uuid,text,text,text,text,text,integer,text,timestamptz)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_waffo_observe_qualification(uuid,text,text,text,text,text,integer,text,timestamptz)
  TO service_role;

CREATE OR REPLACE FUNCTION public.pay_waffo_internal_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE o public.payment_orders; s public.user_subscriptions;
BEGIN
  IF NEW.stripe_subscription_id IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.subscription_id IS NOT DISTINCT FROM OLD.subscription_id
    AND NEW.source_order_id IS NOT DISTINCT FROM OLD.source_order_id
    AND NEW.grant_snapshot IS NOT DISTINCT FROM OLD.grant_snapshot
    AND NEW.credits_granted IS NOT DISTINCT FROM OLD.credits_granted THEN RETURN NEW; END IF;
  IF EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=NEW.user_id) THEN
    RAISE EXCEPTION 'PAY_WAFFO_ACCOUNT_CLOSED' USING ERRCODE='42501';
  END IF;
  SELECT * INTO o FROM payment_orders WHERE id=NEW.source_order_id;
  SELECT * INTO s FROM user_subscriptions WHERE id=NEW.subscription_id;
  IF o.id IS NULL OR s.id IS NULL OR NEW.user_id IS DISTINCT FROM o.user_id
    OR NEW.user_id IS DISTINCT FROM s.user_id OR o.subscription_id IS DISTINCT FROM s.id
    OR o.payment_channel IS DISTINCT FROM s.payment_channel
    OR o.merchant_namespace IS DISTINCT FROM s.merchant_namespace OR o.payment_mode IS DISTINCT FROM s.payment_mode
    OR NEW.grant_snapshot IS DISTINCT FROM o.purchase_snapshot
    OR o.payment_status IS DISTINCT FROM 'paid' OR o.qualification_state IS DISTINCT FROM 'sold'
    OR NEW.stripe_invoice_id IS NOT NULL
    OR public.pay_waffo_canonical_grant(s,NEW) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PAY_WAFFO_INTERNAL_SOURCE_MISMATCH' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.pay_waffo_internal_source_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS pay_waffo_internal_source_guard ON public.subscription_credit_grants;
CREATE TRIGGER pay_waffo_internal_source_guard BEFORE INSERT OR UPDATE ON public.subscription_credit_grants
FOR EACH ROW EXECUTE FUNCTION public.pay_waffo_internal_source_guard();

-- Preserve the existing reserve/settle/release accounting; only resolve its source by internal ID.
CREATE OR REPLACE FUNCTION public.pay_waffo_canonical_grant(s public.user_subscriptions,g public.subscription_credit_grants)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE o public.payment_orders; start_at timestamptz; end_at timestamptz; idx integer;
BEGIN
  IF g.stripe_subscription_id IS NOT NULL THEN
    RETURN public.refund_1b_is_canonical_period_identity(s.user_id,s.stripe_subscription_id,s.membership_plan_id,
      s.billing_cycle,s.current_period_start,s.current_period_end,g.user_id,g.stripe_subscription_id,g.membership_plan_id,
      g.billing_cycle,g.grant_type,g.grant_period_key,g.period_start,g.period_end,g.period_index,g.total_periods,g.stripe_invoice_id);
  END IF;
  SELECT * INTO o FROM payment_orders WHERE id=g.source_order_id;
  start_at:=coalesce(o.entitlement_start,s.current_period_start);
  end_at:=coalesce(o.entitlement_end,s.current_period_end);
  IF o.id IS NULL OR s.id IS DISTINCT FROM g.subscription_id OR o.subscription_id IS DISTINCT FROM s.id
    OR o.user_id IS DISTINCT FROM g.user_id OR s.user_id IS DISTINCT FROM g.user_id
    OR o.payment_channel IS DISTINCT FROM s.payment_channel OR o.payment_mode IS DISTINCT FROM s.payment_mode
    OR o.merchant_namespace IS DISTINCT FROM s.merchant_namespace OR o.qualification_state IS DISTINCT FROM 'sold'
    OR o.payment_status IS DISTINCT FROM 'paid' OR g.grant_snapshot IS DISTINCT FROM o.purchase_snapshot
    OR g.membership_plan_id IS DISTINCT FROM o.item_id OR g.billing_cycle IS DISTINCT FROM o.billing_cycle
    OR start_at IS NULL OR end_at IS NULL OR end_at<=start_at OR g.stripe_invoice_id IS NOT NULL THEN RETURN false; END IF;
  idx:=coalesce(g.period_index,1);
  IF g.billing_cycle='monthly' THEN
    RETURN g.grant_type='monthly_invoice' AND g.period_index IS NULL AND g.total_periods=1
      AND g.period_start=start_at AND g.period_end=end_at
      AND g.credits_granted=(o.purchase_snapshot->>'credits')::integer+(o.purchase_snapshot->>'bonus_credits')::integer
      AND g.grant_period_key='payment:'||o.id::text||':01';
  END IF;
  RETURN g.billing_cycle='yearly' AND g.grant_type='annual_monthly_release' AND g.total_periods=12
    AND g.period_index BETWEEN 1 AND 12
    AND g.period_start=((start_at AT TIME ZONE 'UTC')+make_interval(months=>idx-1)) AT TIME ZONE 'UTC'
    AND g.period_end=least(end_at,((start_at AT TIME ZONE 'UTC')+make_interval(months=>idx)) AT TIME ZONE 'UTC')
    AND g.credits_granted=(o.purchase_snapshot->>'credits')::integer/12
      +CASE WHEN idx<=(o.purchase_snapshot->>'credits')::integer%12 THEN 1 ELSE 0 END
    AND g.grant_period_key='payment:'||o.id::text||':'||lpad(idx::text,2,'0');
END $$;
REVOKE ALL ON FUNCTION public.pay_waffo_canonical_grant(public.user_subscriptions,public.subscription_credit_grants)
  FROM PUBLIC,anon,authenticated;

DO $bill2$
DECLARE f record; source text; revised text;
BEGIN
  FOR f IN SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN (
    'atomic_pre_deduct','bill2_legacy_settle','bill2_legacy_refund','bill2_legacy_abort_settle',
    'bill2_legacy_finalize_success','bill2_legacy_finalize_failure','bill2_legacy_finalize_abort') LOOP
    source:=pg_get_functiondef(f.oid);
    revised:=replace(source,'ON us.stripe_subscription_id = g.stripe_subscription_id',
      'ON (us.stripe_subscription_id = g.stripe_subscription_id OR (g.stripe_subscription_id IS NULL AND us.id = g.subscription_id))');
    -- The terminated_us alias needs the same internal-ID resolution.
    revised:=replace(revised,'terminated_us.stripe_subscription_id = g.stripe_subscription_id',
      '(terminated_us.stripe_subscription_id = g.stripe_subscription_id OR (g.stripe_subscription_id IS NULL AND terminated_us.id = g.subscription_id))');
    revised:=regexp_replace(revised,
      'public.refund_1b_is_canonical_period_identity\([[:space:]]*us.user_id,[^)]*g.stripe_invoice_id[[:space:]]*\)',
      'public.pay_waffo_canonical_grant(us,g)','g');
    -- Idempotent replacement: a prior patch has already expanded these joins.
    IF position('g.stripe_subscription_id IS NULL AND us.id = g.subscription_id' IN source)=0 THEN
      EXECUTE revised;
    END IF;
  END LOOP;
END $bill2$;

-- New protocol activation never lets an old caller bypass method/terms/qualification checks.
-- The old global setting is retained only for legacy test callers before activation.
DO $legacy$
DECLARE source text;
BEGIN
  source:=pg_get_functiondef('public.pay_common_create_purchase(uuid,text,uuid,text,text,text,text)'::regprocedure);
  IF position('PAY_WAFFO_LEGACY_NEW_PURCHASE_DISABLED' IN source)=0 THEN
    source:=replace(source,'  PERFORM pg_advisory_xact_lock_shared(7063, 1);',
      E'  PERFORM pg_advisory_xact_lock_shared(7063, 2);\n  PERFORM pg_advisory_xact_lock_shared(7063, 1);');
    source:=replace(source,'  IF intent.id IS NULL THEN',E'  IF intent.id IS NULL AND EXISTS(SELECT 1 FROM public.system_settings\n'
      ||E'    WHERE key=''payment_method_routes'') THEN\n'
      ||E'    RAISE EXCEPTION ''PAY_WAFFO_LEGACY_NEW_PURCHASE_DISABLED'' USING ERRCODE=''23514'';\n'
      ||E'  END IF;\n  IF intent.id IS NULL THEN');
    source:=replace(source,'AND r.object_type=''price'' AND r.billing_cycle=p_billing_cycle AND r.is_current',
      'AND r.object_type=''price'' AND r.billing_cycle=p_billing_cycle AND r.is_current AND r.offer_kind=''standard''');
    EXECUTE source;
  END IF;
END $legacy$;

COMMIT;
