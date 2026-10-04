-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-COMMON PR-2. Local purchase admission; no provider calls or configuration.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Packages had no version timestamp. Freeze a server-maintained catalog version just as plans do.
ALTER TABLE public.credit_packages ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE OR REPLACE FUNCTION public.pay_common_package_version() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
BEGIN NEW.updated_at:=clock_timestamp(); RETURN NEW; END $fn$;
REVOKE ALL ON FUNCTION public.pay_common_package_version() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS pay_common_package_version ON public.credit_packages;
CREATE TRIGGER pay_common_package_version BEFORE UPDATE ON public.credit_packages
  FOR EACH ROW EXECUTE FUNCTION public.pay_common_package_version();

CREATE OR REPLACE FUNCTION public.pay_common_create_purchase(
  p_user_id uuid, p_item_type text, p_item_id uuid, p_billing_cycle text,
  p_merchant_namespace text, p_payment_mode text, p_expected_level text
) RETURNS public.payment_orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE
  actor public.profiles; intent public.payment_orders; product jsonb; mapped public.payment_provider_refs;
  snapshot jsonb; price_cents integer; discount integer:=100; final_cents integer;
  request_hash text; grant_credits integer; bonus integer; version_time text;
BEGIN
  IF p_user_id IS NULL OR p_item_id IS NULL OR p_item_type IS NULL OR p_item_type NOT IN ('credit_package','membership_plan')
    OR p_billing_cycle IS NULL OR p_billing_cycle NOT IN ('one_time','monthly','yearly')
    OR (p_item_type='credit_package') IS DISTINCT FROM (p_billing_cycle='one_time')
    OR p_merchant_namespace IS NULL OR p_merchant_namespace !~ '^[A-Za-z0-9_-]{1,64}$'
    OR p_payment_mode IS NULL OR p_payment_mode NOT IN ('test','live') THEN
    RAISE EXCEPTION 'PAY_COMMON_PURCHASE_INPUT_INVALID' USING ERRCODE='23514';
  END IF;
  SELECT * INTO actor FROM public.profiles WHERE id=p_user_id FOR UPDATE;
  IF NOT FOUND OR actor.status IS DISTINCT FROM 'active' OR actor.is_deleted::text IS DISTINCT FROM 'false'
    OR EXISTS(SELECT 1 FROM public.account_erasure_requests WHERE profile_id=p_user_id)
    OR p_expected_level IS NULL OR actor.membership_level IS DISTINCT FROM p_expected_level THEN
    RAISE EXCEPTION 'PAY_COMMON_PURCHASE_ACTOR_DENIED' USING ERRCODE='42501';
  END IF;
  request_hash:=encode(extensions.digest(
    concat_ws(':',p_item_type,p_item_id::text,p_billing_cycle),'sha256'),'hex');
  -- One unresolved action per subject. A browser cancellation or local timeout never retires it.
  SELECT * INTO intent FROM public.payment_orders o WHERE o.user_id=p_user_id
    AND o.payment_channel='stripe' AND o.item_type=p_item_type
    AND o.metadata->>'purchaseAction'='checkout'
    AND o.metadata->>'attemptClosed' IS DISTINCT FROM 'true'
    AND o.fulfilled_at IS NULL ORDER BY o.created_at LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    IF intent.purchase_payload_hash IS DISTINCT FROM request_hash
      OR intent.merchant_namespace IS DISTINCT FROM p_merchant_namespace
      OR intent.payment_mode IS DISTINCT FROM p_payment_mode THEN
      RAISE EXCEPTION 'PAY_COMMON_PURCHASE_PENDING' USING ERRCODE='23514';
    END IF;
    RETURN intent;
  END IF;
  IF p_item_type='membership_plan' THEN
    IF EXISTS(SELECT 1 FROM public.user_subscriptions s WHERE s.user_id=p_user_id
      AND (s.status IN ('active','trialing','past_due','incomplete','unpaid')
        OR s.current_period_end>now() AND s.status NOT IN ('canceled','cancelled'))) THEN
      RAISE EXCEPTION 'PAY_COMMON_SUBSCRIPTION_EXISTS' USING ERRCODE='23514';
    END IF;
    SELECT to_jsonb(p) INTO product FROM public.membership_plans p
      WHERE id=p_item_id AND is_active='true' AND level IN ('pro','gold') FOR SHARE;
    price_cents:=(product->>(CASE p_billing_cycle WHEN 'monthly' THEN 'monthly_price' ELSE 'yearly_price' END))::integer;
    grant_credits:=(product->>(CASE p_billing_cycle WHEN 'monthly' THEN 'monthly_credits' ELSE 'yearly_credits' END))::integer;
    bonus:=CASE p_billing_cycle WHEN 'monthly' THEN coalesce((product->>'monthly_bonus_credits')::integer,0) ELSE 0 END;
  ELSE
    IF actor.membership_level NOT IN ('pro','gold') THEN
      RAISE EXCEPTION 'PAY_COMMON_MEMBERSHIP_REQUIRED' USING ERRCODE='42501';
    END IF;
    SELECT to_jsonb(p) INTO product FROM public.credit_packages p WHERE id=p_item_id AND active='true' FOR SHARE;
    SELECT package_discount INTO discount FROM public.membership_plans
      WHERE level=actor.membership_level AND is_active='true' FOR SHARE;
    IF NOT FOUND OR discount IS NULL OR discount<0 OR discount>100 THEN
      RAISE EXCEPTION 'PAY_COMMON_DISCOUNT_UNKNOWN' USING ERRCODE='23514';
    END IF;
    price_cents:=(product->>'price')::integer;
    grant_credits:=(product->>'credits_amount')::integer;
    bonus:=coalesce((product->>'bonus_credits')::integer,0);
  END IF;
  IF product IS NULL OR price_cents IS NULL OR price_cents<=0 OR grant_credits IS NULL
    OR grant_credits<0 OR bonus<0 OR grant_credits::bigint+bonus<=0
    OR grant_credits::bigint+bonus>2147483647 THEN
    RAISE EXCEPTION 'PAY_COMMON_PRODUCT_UNAVAILABLE' USING ERRCODE='23514';
  END IF;
  SELECT * INTO STRICT mapped FROM public.payment_provider_refs r
    WHERE r.channel='stripe' AND r.merchant_namespace=p_merchant_namespace AND r.mode=p_payment_mode
    AND r.object_type='price' AND r.billing_cycle=p_billing_cycle
    AND CASE p_item_type WHEN 'membership_plan' THEN r.membership_plan_id=p_item_id ELSE r.credit_package_id=p_item_id END;
  final_cents:=round(price_cents::numeric*discount/100)::integer;
  IF final_cents<=0 THEN RAISE EXCEPTION 'PAY_COMMON_AMOUNT_INVALID' USING ERRCODE='23514'; END IF;
  version_time:=to_char((product->>'updated_at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  snapshot:=jsonb_build_object('version',1,'item_type',p_item_type,'item_id',p_item_id,
    'item_updated_at',version_time,'billing_cycle',p_billing_cycle,'currency','usd','unit','major',
    'price',(price_cents::numeric/100)::numeric(18,2)::text,'discount',((price_cents-final_cents)::numeric/100)::numeric(18,2)::text,
    'tax_behavior','unspecified','credits',grant_credits,'bonus_credits',bonus);
  INSERT INTO public.payment_orders(user_id,item_type,item_id,billing_cycle,amount_total,currency,mode,
    status,payment_status,payment_channel,merchant_namespace,payment_mode,
    purchase_request_id,purchase_payload_hash,purchase_snapshot,metadata)
  VALUES(p_user_id,p_item_type,p_item_id,p_billing_cycle,final_cents,'usd',
    CASE p_item_type WHEN 'membership_plan' THEN 'subscription' ELSE 'payment' END,
    'pending','unpaid','stripe',p_merchant_namespace,p_payment_mode,
    gen_random_uuid(),request_hash,snapshot,jsonb_build_object('purchaseAction','checkout',
      'priceRefId',mapped.id,'membershipLevel',product->>'level','productName',product->>'name'))
  RETURNING * INTO intent;
  RETURN intent;
END $fn$;
REVOKE ALL ON FUNCTION public.pay_common_create_purchase(uuid,text,uuid,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_common_create_purchase(uuid,text,uuid,text,text,text,text) TO service_role;
COMMIT;
