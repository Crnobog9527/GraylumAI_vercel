-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- No settings are seeded. Missing selection means Waffo, currently unavailable.
-- Recovery: preserve orders and select Waffo to stop fresh sales; forward-fix only.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $check$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=
    'public.pay_common_create_purchase(uuid,text,uuid,text,text,text,text)'::regprocedure)
    NOT IN ('5e2725b6aa44e6fc4b87070ae119eab1','02a5342c01264759c6152fe6a92b73c6') THEN
    RAISE EXCEPTION 'PAY_COMMON_CHANNEL_SCHEMA_DRIFT';
  END IF;
  IF to_regprocedure('public.pay_common_channel_setting_guard()') IS NOT NULL AND
    (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.pay_common_channel_setting_guard()'))
    IS DISTINCT FROM '74063149af95709918e9d706b7ab0ea5' THEN
    RAISE EXCEPTION 'PAY_COMMON_CHANNEL_SCHEMA_DRIFT';
  END IF;
END $check$;
CREATE OR REPLACE FUNCTION public.pay_common_channel_setting_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $guard$
DECLARE prior jsonb; expected bigint;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.key='payment_new_purchase_channel' AND
    (TG_OP='DELETE' OR NEW.key IS DISTINCT FROM OLD.key) THEN
    RAISE EXCEPTION 'PAY_COMMON_CHANNEL_DELETE_DENIED' USING ERRCODE='42501';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.key <> 'payment_new_purchase_channel' THEN RETURN NEW; END IF;
  IF current_user NOT IN ('postgres','service_role') THEN
    RAISE EXCEPTION 'PAY_COMMON_CHANNEL_WRITE_DENIED' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(7063, 1);
  IF jsonb_typeof(NEW.value) IS DISTINCT FROM 'object'
    OR NOT (NEW.value ?& ARRAY['channel','version'])
    OR (NEW.value - 'channel' - 'version') <> '{}'::jsonb
    OR NEW.value->>'channel' NOT IN ('waffo','stripe')
    OR jsonb_typeof(NEW.value->'channel') IS DISTINCT FROM 'string'
    OR jsonb_typeof(NEW.value->'version') IS DISTINCT FROM 'number'
    OR (NEW.value->>'version') !~ '^[1-9][0-9]{0,9}$' THEN
    RAISE EXCEPTION 'PAY_COMMON_CHANNEL_SETTING_INVALID' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN prior := OLD.value;
  ELSE SELECT value INTO prior FROM public.system_settings WHERE key=NEW.key; END IF;
  expected := coalesce((prior->>'version')::bigint,0)+1;
  IF (NEW.value->>'version')::bigint <> expected THEN
    RAISE EXCEPTION 'PAY_COMMON_CHANNEL_VERSION_CONFLICT' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $guard$;

DROP TRIGGER IF EXISTS pay_common_channel_setting_guard ON public.system_settings;
CREATE TRIGGER pay_common_channel_setting_guard BEFORE INSERT OR UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.pay_common_channel_setting_guard();
REVOKE ALL ON FUNCTION public.pay_common_channel_setting_guard() FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.pay_common_create_purchase(
  p_user_id uuid, p_item_type text, p_item_id uuid, p_billing_cycle text,
  p_merchant_namespace text, p_payment_mode text, p_expected_level text
) RETURNS public.payment_orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE
  mapping_count integer;
  actor public.profiles; intent public.payment_orders; product jsonb; mapped public.payment_provider_refs;
  snapshot jsonb; price_cents integer; discount integer:=100; final_cents integer;
  request_hash text; grant_credits integer; bonus integer; version_time text;
BEGIN
  -- Serialize selection and insertion against channel saves, including a missing settings row.
  PERFORM pg_advisory_xact_lock_shared(7063, 1);
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
  IF EXISTS(SELECT 1 FROM public.payment_orders o WHERE o.user_id=p_user_id
    AND o.item_type=p_item_type AND o.payment_channel IS NULL AND o.fulfilled_at IS NULL
    AND (o.status NOT IN ('expired','canceled','cancelled','failed','refunded','partially_refunded')
      OR o.payment_status='paid')) THEN
    RAISE EXCEPTION 'PAY_COMMON_LEGACY_ORDER_UNRESOLVED' USING ERRCODE='23514';
  END IF;
  PERFORM public.pay_common_assert_purchase_facts(p_user_id,p_item_type,actor.membership_level);
  request_hash:=encode(extensions.digest(
    concat_ws(':',p_item_type,p_item_id::text,p_billing_cycle),'sha256'),'hex');
  -- One unresolved action per subject. A browser cancellation or local timeout never retires it.
  SELECT * INTO intent FROM public.payment_orders o WHERE o.user_id=p_user_id
    AND o.payment_channel='stripe' AND o.item_type=p_item_type
    AND o.purchase_action='checkout'
    AND o.purchase_closed_at IS NULL
    AND o.fulfilled_at IS NULL ORDER BY o.created_at LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    -- Same-scope previous intent is returned for authoritative retirement on explicit item switch.
    IF intent.merchant_namespace IS DISTINCT FROM p_merchant_namespace
      OR intent.payment_mode IS DISTINCT FROM p_payment_mode THEN
      RAISE EXCEPTION 'PAY_COMMON_PURCHASE_PENDING' USING ERRCODE='23514';
    END IF;
    RETURN intent;
  END IF;
  -- Only fresh intents consult the default. Existing intents above retain their frozen channel.
  SELECT value INTO snapshot FROM public.system_settings WHERE key='payment_new_purchase_channel';
  IF snapshot IS NULL THEN snapshot := '{"channel":"waffo","version":0}'::jsonb; END IF;
  IF snapshot->>'channel' NOT IN ('waffo','stripe') OR snapshot->>'channel' IS NULL THEN
    RAISE EXCEPTION 'PAY_COMMON_CHANNEL_SETTING_INVALID' USING ERRCODE='23514';
  END IF;
  IF snapshot->>'channel'='waffo' THEN
    RAISE EXCEPTION 'PAY_COMMON_CHANNEL_NOT_READY' USING ERRCODE='23514';
  END IF;
  IF p_payment_mode <> 'test' THEN
    RAISE EXCEPTION 'PAY_COMMON_LIVE_PURCHASE_DISABLED' USING ERRCODE='23514';
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
    SELECT to_jsonb(p) INTO product FROM public.credit_packages p WHERE id=p_item_id AND active='true' FOR SHARE;
    IF actor.membership_level<>'free' THEN
      SELECT package_discount INTO discount FROM public.membership_plans
        WHERE level=actor.membership_level AND is_active='true' FOR SHARE;
      IF NOT FOUND OR discount IS NULL OR discount<0 OR discount>100 THEN
        RAISE EXCEPTION 'PAY_COMMON_DISCOUNT_UNKNOWN' USING ERRCODE='23514';
      END IF;
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
  -- Zero/ambiguous current mappings are domain failures, never P0002/P0003.
  FOR mapped IN SELECT * FROM public.payment_provider_refs r
    WHERE r.channel='stripe' AND r.merchant_namespace=p_merchant_namespace AND r.mode=p_payment_mode
    AND r.object_type='price' AND r.billing_cycle=p_billing_cycle AND r.is_current
    AND CASE p_item_type WHEN 'membership_plan' THEN r.membership_plan_id=p_item_id ELSE r.credit_package_id=p_item_id END
    FOR SHARE LOOP
    mapping_count:=coalesce(mapping_count,0)+1;
  END LOOP;
  IF coalesce(mapping_count,0)=0 THEN
    RAISE EXCEPTION 'PAY_COMMON_PRICE_MAPPING_MISSING' USING ERRCODE='23514';
  ELSIF mapping_count<>1 THEN
    RAISE EXCEPTION 'PAY_COMMON_PRICE_MAPPING_AMBIGUOUS' USING ERRCODE='23514';
  END IF;
  final_cents:=round(price_cents::numeric*discount/100)::integer;
  IF final_cents<=0 THEN RAISE EXCEPTION 'PAY_COMMON_AMOUNT_INVALID' USING ERRCODE='23514'; END IF;
  version_time:=to_char((product->>'updated_at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  snapshot:=jsonb_build_object('version',1,'item_type',p_item_type,'item_id',p_item_id,
    'item_updated_at',version_time,'billing_cycle',p_billing_cycle,'currency','usd','unit','major',
    'price',(price_cents::numeric/100)::numeric(18,2)::text,'discount',((price_cents-final_cents)::numeric/100)::numeric(18,2)::text,
    'tax_behavior','unspecified','credits',grant_credits,'bonus_credits',bonus);
  INSERT INTO public.payment_orders(user_id,item_type,item_id,billing_cycle,amount_total,currency,mode,
    status,payment_status,payment_channel,merchant_namespace,payment_mode,
    purchase_request_id,purchase_payload_hash,purchase_snapshot,price_ref_id,purchase_action,purchase_membership_level,metadata)
  VALUES(p_user_id,p_item_type,p_item_id,p_billing_cycle,final_cents,'usd',
    CASE p_item_type WHEN 'membership_plan' THEN 'subscription' ELSE 'payment' END,
    'pending','unpaid','stripe',p_merchant_namespace,p_payment_mode,
    gen_random_uuid(),request_hash,snapshot,mapped.id,'checkout',product->>'level',
    jsonb_build_object('membershipLevel',product->>'level','productName',product->>'name'))
  RETURNING * INTO intent;
  RETURN intent;
END $fn$;
REVOKE ALL ON FUNCTION public.pay_common_create_purchase(uuid,text,uuid,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_common_create_purchase(uuid,text,uuid,text,text,text,text) TO service_role;


COMMIT;
