-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-COMMON PR-2. Local purchase admission; no provider calls or configuration.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $migration$
DECLARE actual text;
BEGIN
  LOCK TABLE public.payment_orders, public.user_subscriptions, public.subscription_credit_grants,
    public.payment_provider_refs, public.credit_packages, public.membership_plans IN ACCESS EXCLUSIVE MODE;
-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Catalog-only structural fingerprint of schema public (no business rows are read). The same text
-- runs locally after a replay and, in a READ ONLY transaction, against staging for comparison.
-- Output: group -> md5 (small enough to compare with staging); the local runner can also list
-- the per-object details of any group that differs.
WITH rel AS (
  SELECT c.oid, c.relname, c.relkind FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
), items(k, d) AS (
  SELECT 'rel:' || relname, relkind::text FROM rel
  UNION ALL
  SELECT 'col:' || r.relname || '.' || a.attname,
    format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
      || coalesce(' DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid), '')
      || coalesce(' GENERATED ' || nullif(a.attgenerated::text, ''), '')
      || coalesce(' IDENTITY ' || nullif(a.attidentity::text, ''), '')
  FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
  UNION ALL
  SELECT 'colacl:' || r.relname || '.' || a.attname, (SELECT string_agg(x, ',' ORDER BY x) FROM unnest(a.attacl::text[]) x)
  FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE a.attacl IS NOT NULL
  UNION ALL
  SELECT 'con:' || r.relname || '.' || co.conname, pg_get_constraintdef(co.oid)
  FROM rel r JOIN pg_constraint co ON co.conrelid = r.oid
  UNION ALL
  SELECT 'idx:' || r.relname || '.' || i.indexrelid::regclass::text, pg_get_indexdef(i.indexrelid)
  FROM rel r JOIN pg_index i ON i.indrelid = r.oid
  UNION ALL
  SELECT 'trg:' || r.relname || '.' || t.tgname, pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text
  FROM rel r JOIN pg_trigger t ON t.tgrelid = r.oid AND NOT t.tgisinternal
  UNION ALL
  SELECT 'pol:' || p.tablename || '.' || p.policyname,
    concat_ws(' | ', p.permissive, p.cmd, p.roles::text, p.qual, p.with_check)
  FROM pg_policies p WHERE p.schemaname = 'public'
  UNION ALL
  SELECT 'rls:' || c.relname, c.relrowsecurity::text || '/' || c.relforcerowsecurity::text
  FROM pg_class c JOIN rel r ON r.oid = c.oid WHERE r.relkind IN ('r', 'p')
  UNION ALL
  SELECT 'acl:' || c.relname, coalesce((SELECT string_agg(x, ',' ORDER BY x) FROM unnest(c.relacl::text[]) x), '')
  FROM pg_class c JOIN rel r ON r.oid = c.oid
  UNION ALL
  SELECT 'view:' || r.relname, pg_get_viewdef(r.oid) FROM rel r WHERE r.relkind IN ('v', 'm')
  UNION ALL
  SELECT 'fn:' || p.oid::regprocedure::text, pg_get_functiondef(p.oid)
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
  UNION ALL
  SELECT 'fnacl:' || p.oid::regprocedure::text,
    coalesce((SELECT string_agg(x, ',' ORDER BY x) FROM unnest(p.proacl::text[]) x), '')
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
  UNION ALL
  SELECT 'type:' || t.typname, (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
    FROM pg_enum e WHERE e.enumtypid = t.oid)
  FROM pg_type t WHERE t.typnamespace = 'public'::regnamespace AND t.typtype = 'e'
  UNION ALL
  SELECT 'ext:' || extname, extnamespace::regnamespace::text FROM pg_extension
  UNION ALL
  SELECT 'evt:' || evtname, evtevent || ' ' || evtfoid::regproc::text FROM pg_event_trigger
  UNION ALL
  SELECT 'defacl:' || pg_get_userbyid(d.defaclrole) || '.' || d.defaclobjtype::text,
    (SELECT string_agg(x, ',' ORDER BY x) FROM unnest(d.defaclacl::text[]) x)
  FROM pg_default_acl d WHERE d.defaclnamespace = 'public'::regnamespace
), grouped AS (
  SELECT CASE WHEN k ~ '^(col|colacl|con|idx|trg|pol):' THEN split_part(k, '.', 1) ELSE k END AS g, k, d
  FROM items
)
SELECT md5(string_agg(k || '=' || coalesce(d, '<null>'), E'\n' ORDER BY k)) INTO actual FROM grouped WHERE g ~ '^[^:]+:(payment_orders|user_subscriptions|subscription_credit_grants|payment_provider_refs|credit_packages|membership_plans)$' OR g ~ '^fn(acl)?:(pay_common_|atomic_fulfill_credit_package|atomic_grant_subscription_invoice_credits|atomic_grant_annual_subscription_credits)';

  IF actual = '63550c91138128be0bd85d450646c9e8' THEN RETURN; END IF;
  IF actual IS DISTINCT FROM 'dc3f51dcc333026ecde8a87f26e96d5e' THEN
    RAISE EXCEPTION 'PAY_COMMON_PURCHASE_SCHEMA_DRIFT';
  END IF;


-- Packages had no version timestamp. Freeze a server-maintained catalog version just as plans do.
ALTER TABLE public.credit_packages ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE OR REPLACE FUNCTION public.pay_common_package_version() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
BEGIN NEW.updated_at:=clock_timestamp(); RETURN NEW; END $fn$;
REVOKE ALL ON FUNCTION public.pay_common_package_version() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS pay_common_package_version ON public.credit_packages;
CREATE TRIGGER pay_common_package_version BEFORE UPDATE ON public.credit_packages
  FOR EACH ROW EXECUTE FUNCTION public.pay_common_package_version();

-- Exactly one current price per catalog item/cycle/provider scope. Historical refs remain immutable.
ALTER TABLE public.payment_provider_refs ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS pay_common_current_plan_price
  ON public.payment_provider_refs(channel,merchant_namespace,mode,membership_plan_id,billing_cycle)
  WHERE object_type='price' AND is_current AND membership_plan_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pay_common_current_package_price
  ON public.payment_provider_refs(channel,merchant_namespace,mode,credit_package_id,billing_cycle)
  WHERE object_type='price' AND is_current AND credit_package_id IS NOT NULL;
ALTER TABLE public.payment_orders
  ADD COLUMN IF NOT EXISTS purchase_membership_level text CHECK(purchase_membership_level IN ('pro','gold')),
  ADD COLUMN IF NOT EXISTS price_ref_id uuid REFERENCES public.payment_provider_refs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS purchase_action text CHECK(purchase_action IN ('checkout','subscription_change','renewal')),
  ADD COLUMN IF NOT EXISTS purchase_closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS purchase_close_reason text CHECK(purchase_close_reason IN ('stripe_checkout_expired','stripe_checkout_never_created')),
  ADD COLUMN IF NOT EXISTS purchase_close_ref text;
DROP TRIGGER IF EXISTS pay_common_purchase_freeze ON public.payment_orders;
CREATE TRIGGER pay_common_purchase_freeze BEFORE UPDATE ON public.payment_orders FOR EACH ROW
  EXECUTE FUNCTION public.pay_common_frozen_guard('price_ref_id','purchase_action',
    'purchase_closed_at','purchase_close_reason','purchase_close_ref','purchase_membership_level');

-- New protected fields are written only by bounded SECURITY DEFINER payment operations.
-- Preserve service_role's pre-existing column permissions for all other order fields.
DO $acl$
DECLARE verb text; cols text;
BEGIN
  FOREACH verb IN ARRAY ARRAY['INSERT','UPDATE'] LOOP
    SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO cols
      FROM pg_attribute WHERE attrelid='public.payment_orders'::regclass AND attnum>0 AND NOT attisdropped
      AND attname NOT IN ('price_ref_id','purchase_action','purchase_closed_at','purchase_close_reason','purchase_close_ref','purchase_membership_level');
    EXECUTE format('REVOKE %s ON public.payment_orders FROM service_role',verb);
    EXECUTE format('GRANT %s (%s) ON public.payment_orders TO service_role',verb,cols);
  END LOOP;
END $acl$;
-- Match catalog version semantics: the database, not application time, owns both timestamps.
DROP TRIGGER IF EXISTS pay_common_plan_version ON public.membership_plans;
CREATE TRIGGER pay_common_plan_version BEFORE UPDATE ON public.membership_plans
  FOR EACH ROW EXECUTE FUNCTION public.pay_common_package_version();

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

-- Called only by the Stripe adapter after an authoritative session retrieval, including on
-- checkout.session.expired. Browser return parameters cannot reach this mutation directly.
CREATE OR REPLACE FUNCTION public.pay_common_close_checkout(
  p_user_id uuid,p_order_id uuid,p_session_id text,p_merchant_namespace text,p_payment_mode text,
  p_checkout_status text,p_payment_status text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE intent public.payment_orders; close_reason text;
BEGIN
  IF p_checkout_status IS NULL OR p_checkout_status NOT IN ('expired','never_created')
    OR p_payment_status IS DISTINCT FROM 'unpaid' THEN
    RAISE EXCEPTION 'PAY_COMMON_ATTEMPT_NOT_TERMINAL' USING ERRCODE='23514';
  END IF;
  -- Lock order shared with admission and fulfillment: profile before order.
  PERFORM 1 FROM public.profiles WHERE id=p_user_id FOR UPDATE;
  SELECT * INTO intent FROM public.payment_orders WHERE id=p_order_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR intent.payment_channel IS DISTINCT FROM 'stripe'
    OR intent.merchant_namespace IS DISTINCT FROM p_merchant_namespace
    OR intent.payment_mode IS DISTINCT FROM p_payment_mode OR intent.purchase_action IS DISTINCT FROM 'checkout' THEN
    RAISE EXCEPTION 'PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH' USING ERRCODE='23514';
  END IF;
  IF p_checkout_status='never_created' THEN
    -- Only the service adapter can attest a complete, empty Stripe list after the immutable
    -- expiry plus one hour. Any known provider object or payment evidence forbids this path.
    IF p_session_id IS NOT NULL OR intent.checkout_request->>'expires_at' IS NULL
      OR (intent.checkout_request->>'expires_at')::bigint + 3600 > extract(epoch FROM clock_timestamp())
      OR EXISTS(SELECT 1 FROM public.payment_provider_refs WHERE order_id=intent.id
        AND object_type IN ('checkout','payment_intent','invoice','subscription'))
      OR intent.stripe_checkout_session_id IS NOT NULL
      OR intent.payment_status IS DISTINCT FROM 'unpaid' THEN
      RAISE EXCEPTION 'PAY_COMMON_ATTEMPT_NOT_TERMINAL' USING ERRCODE='23514';
    END IF;
    close_reason:='stripe_checkout_never_created';
  ELSE
    IF NOT EXISTS(SELECT 1 FROM public.payment_provider_refs r WHERE r.order_id=intent.id
      AND r.channel='stripe' AND r.merchant_namespace=p_merchant_namespace AND r.mode=p_payment_mode
      AND r.object_type='checkout' AND r.external_id=p_session_id) THEN
      RAISE EXCEPTION 'PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH' USING ERRCODE='23514';
    END IF;
    close_reason:='stripe_checkout_expired';
  END IF;
  IF intent.fulfilled_at IS NOT NULL OR intent.payment_status IN ('paid','refunded','partially_refunded')
    OR intent.status IN ('completed','refunded','partially_refunded') THEN
    RAISE EXCEPTION 'PAY_COMMON_ATTEMPT_ALREADY_PAID' USING ERRCODE='23514';
  END IF;
  IF intent.purchase_closed_at IS NOT NULL THEN
    IF intent.purchase_close_ref IS DISTINCT FROM p_session_id
      OR intent.purchase_close_reason IS DISTINCT FROM close_reason THEN
      RAISE EXCEPTION 'PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH' USING ERRCODE='23514';
    END IF;
    RETURN false;
  END IF;
  UPDATE public.payment_orders SET purchase_closed_at=clock_timestamp(),
    purchase_close_reason=close_reason,purchase_close_ref=p_session_id,
    status='expired',updated_at=clock_timestamp() WHERE id=intent.id;
  RETURN true;
END $fn$;
REVOKE ALL ON FUNCTION public.pay_common_close_checkout(uuid,uuid,text,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_common_close_checkout(uuid,uuid,text,text,text,text,text) TO service_role;
-- Freeze the exact non-sensitive Checkout envelope before any provider dispatch.
ALTER TABLE public.payment_orders ADD COLUMN checkout_request jsonb;
CREATE TRIGGER pay_common_checkout_request_freeze BEFORE UPDATE ON public.payment_orders
  FOR EACH ROW EXECUTE FUNCTION public.pay_common_frozen_guard('checkout_request');
CREATE FUNCTION public.pay_common_prepare_checkout(p_user_id uuid,p_order_id uuid,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE intent public.payment_orders; price_id text; item jsonb; due integer;
BEGIN
  PERFORM 1 FROM profiles WHERE id=p_user_id AND status='active' AND is_deleted='false' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAY_COMMON_PURCHASE_ACTOR_DENIED' USING ERRCODE='42501'; END IF;
  SELECT * INTO intent FROM payment_orders WHERE id=p_order_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR intent.payment_channel IS DISTINCT FROM 'stripe' OR intent.purchase_action IS DISTINCT FROM 'checkout'
    OR intent.purchase_closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH' USING ERRCODE='23514';
  END IF;
  IF intent.checkout_request IS NOT NULL THEN RETURN intent.checkout_request; END IF;
  SELECT external_id INTO price_id FROM payment_provider_refs WHERE id=intent.price_ref_id
    AND channel='stripe' AND merchant_namespace=intent.merchant_namespace AND mode=intent.payment_mode AND object_type='price';
  item:=p_request->'line_items'->0;
  due:=((intent.purchase_snapshot->>'price')::numeric*100-(intent.purchase_snapshot->>'discount')::numeric*100)::integer;
  IF price_id IS NULL OR p_request IS NULL OR jsonb_typeof(p_request)<>'object' OR octet_length(p_request::text)>12000
    OR p_request - ARRAY['mode','payment_method_types','customer_creation','client_reference_id','line_items',
      'expires_at','success_url','cancel_url','metadata','subscription_data','payment_intent_data'] <> '{}'::jsonb
    OR (p_request->'metadata') - ARRAY['orderId','userId','itemId','itemType','billingCycle','priceId'] <> '{}'::jsonb
    OR item - ARRAY['quantity','price','price_data'] <> '{}'::jsonb
    OR (item ? 'price_data' AND ((item->'price_data') - ARRAY['currency','unit_amount','product_data'] <> '{}'::jsonb
      OR (item->'price_data'->'product_data') - ARRAY['name'] <> '{}'::jsonb))
    OR (p_request ? 'subscription_data' AND (intent.mode<>'subscription'
      OR p_request->'subscription_data' IS DISTINCT FROM jsonb_build_object('metadata',p_request->'metadata')))
    OR (p_request ? 'payment_intent_data' AND (intent.mode<>'payment'
      OR p_request->'payment_intent_data' IS DISTINCT FROM jsonb_build_object('metadata',p_request->'metadata')))
    OR (p_request ? 'payment_method_types' AND p_request->'payment_method_types' IS DISTINCT FROM
      CASE WHEN intent.mode='subscription' THEN '["card"]'::jsonb ELSE '["card","alipay"]'::jsonb END)
    OR (p_request ? 'customer_creation' AND (intent.mode<>'payment' OR p_request->>'customer_creation'<>'always'))
    OR p_request->>'mode' IS DISTINCT FROM intent.mode OR p_request->>'client_reference_id' IS DISTINCT FROM p_user_id::text
    OR p_request->'metadata'->>'orderId' IS DISTINCT FROM intent.id::text
    OR p_request->'metadata'->>'userId' IS DISTINCT FROM p_user_id::text
    OR p_request->'metadata'->>'itemId' IS DISTINCT FROM intent.item_id::text
    OR p_request->'metadata'->>'itemType' IS DISTINCT FROM intent.item_type
    OR p_request->'metadata'->>'billingCycle' IS DISTINCT FROM intent.billing_cycle
    OR p_request->'metadata'->>'priceId' IS DISTINCT FROM price_id
    OR jsonb_array_length(p_request->'line_items') IS DISTINCT FROM 1 OR item->>'quantity' IS DISTINCT FROM '1'
    OR coalesce(p_request->>'expires_at','') !~ '^[0-9]+$'
    OR (p_request->>'expires_at')::bigint NOT BETWEEN extract(epoch FROM now())::bigint+1800 AND extract(epoch FROM now())::bigint+86400
    OR (CASE WHEN (intent.purchase_snapshot->>'discount')::numeric=0
      THEN item->>'price' IS DISTINCT FROM price_id OR item ? 'price_data'
      ELSE item ? 'price' OR item->'price_data'->>'unit_amount' IS DISTINCT FROM due::text
        OR item->'price_data'->>'currency' IS DISTINCT FROM intent.currency END) THEN
    RAISE EXCEPTION 'PAY_COMMON_CHECKOUT_REQUEST_INVALID' USING ERRCODE='23514';
  END IF;
  UPDATE payment_orders SET checkout_request=p_request WHERE id=intent.id;
  RETURN p_request;
END $fn$;
REVOKE ALL ON FUNCTION public.pay_common_prepare_checkout(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_common_prepare_checkout(uuid,uuid,jsonb) TO service_role;

-- Existing checkout persistence now uses a bounded atomic write: original order, authoritative
-- external refs, and compatibility columns commit together. No raw provider object is retained.
CREATE FUNCTION public.pay_common_record_checkout(p_order_id uuid,p_merchant_namespace text,p_payment_mode text,p_session jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE intent public.payment_orders; owner_id uuid; session_id text:=p_session->>'id'; price_id text;
  ref public.payment_provider_refs;
  facts jsonb; fact jsonb; conflicts jsonb; reason text; paid boolean; kind text; external text;
BEGIN
  SELECT user_id INTO owner_id FROM payment_orders WHERE id=p_order_id;
  PERFORM 1 FROM profiles WHERE id=owner_id FOR UPDATE;
  SELECT * INTO intent FROM payment_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND OR intent.payment_channel IS DISTINCT FROM 'stripe'
    OR intent.merchant_namespace IS DISTINCT FROM p_merchant_namespace OR intent.payment_mode IS DISTINCT FROM p_payment_mode
    OR intent.purchase_action IS DISTINCT FROM 'checkout' THEN
    RAISE EXCEPTION 'PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH' USING ERRCODE='23514';
  END IF;
  SELECT external_id INTO price_id FROM payment_provider_refs WHERE id=intent.price_ref_id AND object_type='price'
    AND channel='stripe' AND merchant_namespace=p_merchant_namespace AND mode=p_payment_mode;
  IF session_id IS NULL OR session_id !~ '^cs_[A-Za-z0-9_]+$' THEN
    RAISE EXCEPTION 'PAY_COMMON_RECEIPT_INVALID' USING ERRCODE='23514';
  END IF;
  IF p_session->>'object' IS DISTINCT FROM 'checkout.session' OR price_id IS NULL
    OR p_session->>'livemode' IS DISTINCT FROM (p_payment_mode='live')::text
    OR p_session->>'client_reference_id' IS DISTINCT FROM owner_id::text
    OR p_session->'metadata'->>'orderId' IS DISTINCT FROM intent.id::text
    OR p_session->'metadata'->>'userId' IS DISTINCT FROM owner_id::text
    OR p_session->'metadata'->>'itemId' IS DISTINCT FROM intent.item_id::text
    OR p_session->'metadata'->>'itemType' IS DISTINCT FROM intent.item_type
    OR p_session->'metadata'->>'billingCycle' IS DISTINCT FROM intent.billing_cycle
    OR p_session->'metadata'->>'priceId' IS DISTINCT FROM price_id
    OR p_session->>'amount_total' IS DISTINCT FROM intent.amount_total::text
    OR p_session->>'currency' IS DISTINCT FROM intent.currency OR p_session->>'mode' IS DISTINCT FROM intent.mode
    OR p_session->>'payment_status' IS NULL OR p_session->>'payment_status' NOT IN ('paid','unpaid') THEN
    reason:='PAY_COMMON_RECEIPT_MISMATCH';
  END IF;
  SELECT * INTO ref FROM payment_provider_refs WHERE channel='stripe' AND merchant_namespace=p_merchant_namespace
    AND object_type='checkout' AND external_id=session_id;
  IF FOUND AND (ref.order_id IS DISTINCT FROM intent.id OR ref.mode IS DISTINCT FROM p_payment_mode) THEN
    reason:='PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH';
  END IF;
  IF EXISTS(SELECT 1 FROM payment_provider_refs WHERE order_id=intent.id AND object_type='checkout'
    AND (external_id<>session_id OR channel<>'stripe' OR merchant_namespace<>p_merchant_namespace OR mode<>p_payment_mode)) THEN
    reason:='PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH';
  END IF;
  IF reason IS NOT NULL THEN
    conflicts:=coalesce(intent.metadata->'paymentConflicts','[]'::jsonb);
    fact:=jsonb_build_object('evidence_ref',session_id,'reason',reason);
    IF NOT conflicts @> jsonb_build_array(fact) THEN
      IF jsonb_array_length(conflicts)>=32 THEN RAISE EXCEPTION 'PAY_COMMON_CONFLICT_LIMIT'; END IF;
      UPDATE payment_orders SET metadata=metadata||jsonb_build_object('paymentConflicts',conflicts||jsonb_build_array(fact||jsonb_build_object('code','PAY_COMMON_PAYMENT_EVIDENCE_CONFLICT')))
        WHERE id=intent.id;
    END IF;
    RETURN jsonb_build_object('ok',false,'reason',reason);
  END IF;
  INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
    VALUES('stripe',p_merchant_namespace,p_payment_mode,'checkout',session_id,intent.id) ON CONFLICT DO NOTHING;
  -- Cross-order races cannot silently steal an identity after the precheck.
  IF NOT EXISTS(SELECT 1 FROM payment_provider_refs WHERE channel='stripe' AND merchant_namespace=p_merchant_namespace
    AND mode=p_payment_mode AND object_type='checkout' AND external_id=session_id AND order_id=intent.id) THEN
    RAISE EXCEPTION 'PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH' USING ERRCODE='23514';
  END IF;
  FOREACH kind IN ARRAY ARRAY['payment','invoice'] LOOP
    external:=CASE kind WHEN 'payment' THEN p_session->>'payment_intent' ELSE p_session->>'invoice' END;
    IF external IS NOT NULL THEN
      IF external !~ (CASE kind WHEN 'payment' THEN '^pi_[A-Za-z0-9_]+$' ELSE '^in_[A-Za-z0-9_]+$' END) THEN
        RAISE EXCEPTION 'PAY_COMMON_RECEIPT_INVALID' USING ERRCODE='23514';
      END IF;
      INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
        VALUES('stripe',p_merchant_namespace,p_payment_mode,kind,external,intent.id) ON CONFLICT DO NOTHING;
      IF NOT EXISTS(SELECT 1 FROM payment_provider_refs WHERE channel='stripe' AND merchant_namespace=p_merchant_namespace
        AND mode=p_payment_mode AND object_type=kind AND external_id=external AND order_id=intent.id) THEN
        RAISE EXCEPTION 'PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH' USING ERRCODE='23514';
      END IF;
    END IF;
  END LOOP;
  paid:=p_session->>'payment_status'='paid';
  facts:=coalesce(intent.payment_amount_facts,'[]'::jsonb);
  IF paid THEN
    FOREACH kind IN ARRAY ARRAY['paid','fee','net'] LOOP
      fact:=jsonb_build_object('kind',kind,'amount',CASE WHEN kind='paid' THEN (intent.amount_total::numeric/100)::numeric(18,2)::text END,
        'currency',intent.currency,'unit','major','evidence_ref',session_id);
      IF NOT facts @> jsonb_build_array(fact) THEN facts:=facts||jsonb_build_array(fact); END IF;
    END LOOP;
  END IF;
  IF jsonb_array_length(facts)>128 THEN RAISE EXCEPTION 'PAY_COMMON_AMOUNT_FACT_LIMIT'; END IF;
  UPDATE payment_orders SET stripe_checkout_session_id=session_id,stripe_price_id=price_id,
    stripe_invoice_id=coalesce((SELECT external_id FROM payment_provider_refs WHERE order_id=intent.id AND object_type='invoice'),stripe_invoice_id),
    stripe_customer_id=coalesce(p_session->>'customer',stripe_customer_id),
    payment_status=CASE WHEN payment_status IN ('paid','refunded','partially_refunded') THEN payment_status
      WHEN paid THEN 'paid' ELSE p_session->>'payment_status' END,
    payment_amount_facts=facts,
    metadata=metadata||jsonb_build_object('checkoutStatus',p_session->>'status',
      'lastCheckoutEvidenceSource',CASE WHEN p_session->>'event_type' ~ '^[a-z_.]{1,80}$' THEN p_session->>'event_type' END),
    updated_at=clock_timestamp()
    WHERE id=intent.id;
  RETURN jsonb_build_object('ok',true,'order_id',intent.id);
END $fn$;
REVOKE ALL ON FUNCTION public.pay_common_record_checkout(uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_common_record_checkout(uuid,text,text,jsonb) TO service_role;

-- Extend the original transaction; keep its public signature and single credit ledger.
CREATE OR REPLACE FUNCTION public.atomic_fulfill_credit_package(
  p_checkout_session_id text,p_payment_status text DEFAULT 'paid'
) RETURNS TABLE(order_id uuid,user_id uuid,granted_credits integer,fulfilled_at timestamptz,already_fulfilled boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE intent public.payment_orders; owner_id uuid; local_id uuid; total integer; transaction_id uuid; at_time timestamptz;
BEGIN
  IF p_payment_status IS DISTINCT FROM 'paid' THEN RAISE EXCEPTION 'PAY_COMMON_PAYMENT_NOT_PAID'; END IF;
  IF (SELECT count(*) FROM payment_provider_refs WHERE channel='stripe' AND object_type='checkout'
    AND external_id=p_checkout_session_id)<>1 THEN RAISE EXCEPTION 'PAY_COMMON_CHECKOUT_MAPPING_UNKNOWN'; END IF;
  SELECT r.order_id,o.user_id INTO local_id,owner_id FROM payment_provider_refs r JOIN payment_orders o ON o.id=r.order_id
    WHERE r.channel='stripe' AND r.object_type='checkout' AND r.external_id=p_checkout_session_id
      AND r.merchant_namespace=o.merchant_namespace AND r.mode=o.payment_mode AND o.payment_channel='stripe';
  -- Every payment transaction takes the profile lock before the order lock.
  PERFORM 1 FROM profiles p WHERE p.id=owner_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAY_COMMON_PURCHASE_ACTOR_UNKNOWN'; END IF;
  SELECT * INTO intent FROM payment_orders o WHERE o.id=local_id AND o.user_id=owner_id FOR UPDATE;
  IF NOT FOUND OR intent.item_type<>'credit_package' OR intent.purchase_snapshot IS NULL
    OR intent.payment_status IS DISTINCT FROM 'paid' THEN RAISE EXCEPTION 'PAY_COMMON_PAYMENT_NOT_PAID'; END IF;
  IF intent.fulfilled_at IS NOT NULL THEN
    RETURN QUERY SELECT intent.id,owner_id,0,intent.fulfilled_at,true; RETURN;
  END IF;
  IF intent.status IN ('refunded','partially_refunded') OR intent.purchase_closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'PAY_COMMON_ATTEMPT_ALREADY_TERMINAL';
  END IF;
  total:=(intent.purchase_snapshot->>'credits')::integer+(intent.purchase_snapshot->>'bonus_credits')::integer;
  IF total<=0 THEN RAISE EXCEPTION 'PAY_COMMON_CREDITS_INVALID'; END IF;
  at_time:=clock_timestamp();
  -- A closed subject remains closed; recording a late financial grant never changes status,
  -- login eligibility or membership. Existing account-open guards prevent use of that balance.
  UPDATE profiles p SET credits=p.credits+total WHERE p.id=owner_id;
  INSERT INTO credit_transactions(user_id,amount,type,description,source_order_id,idempotency_key)
    VALUES(owner_id,total,'purchase',format('Stripe credit package [order:%s]',intent.id),intent.id,
      'pay-common:package:'||intent.id::text) RETURNING id INTO transaction_id;
  UPDATE payment_orders o SET status='completed',payment_status='paid',fulfilled_at=at_time,updated_at=at_time,
    metadata=o.metadata||jsonb_build_object('transactionId',transaction_id,'grantedCredits',total,
      'fulfillmentSource','atomic_fulfill_credit_package') WHERE o.id=intent.id;
  RETURN QUERY SELECT intent.id,owner_id,total,at_time,false;
END $fn$;
REVOKE ALL ON FUNCTION public.atomic_fulfill_credit_package(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_fulfill_credit_package(text,text) TO service_role;

-- Transactional recheck of the existing checkout eligibility facts. This guards the interval
-- between the API eligibility read and admission; it does not create another membership store.
CREATE FUNCTION public.pay_common_assert_purchase_facts(p_user_id uuid,p_item_type text,p_level text)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
DECLARE latest_order public.payment_orders; subscription public.user_subscriptions; meta jsonb; key text;
BEGIN
  SELECT * INTO latest_order FROM payment_orders WHERE user_id=p_user_id AND item_type='membership_plan'
    ORDER BY updated_at DESC LIMIT 1 FOR SHARE;
  IF latest_order.status IN ('refunded','partially_refunded') OR latest_order.payment_status IN ('refunded','partially_refunded') THEN
    RAISE EXCEPTION 'REFUNDED_ORDER_REQUIRES_POLICY' USING ERRCODE='23514';
  END IF;
  FOREACH key IN ARRAY ARRAY['stripeRefundReconciliation','subscriptionCreditGrantReversal','refundReconciliation','refund'] LOOP
    meta:=latest_order.metadata->key;
    IF meta->'isFullRefund'='true'::jsonb OR meta->'fullRefund'='true'::jsonb OR meta->'reviewRequired'='true'::jsonb
      OR meta->>'refundType'='full' THEN RAISE EXCEPTION 'REFUNDED_ORDER_REQUIRES_POLICY' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM user_subscriptions WHERE user_id=p_user_id AND status IN ('active','trialing','past_due','incomplete','unpaid'))>1 THEN
    RAISE EXCEPTION 'PAY_COMMON_MEMBERSHIP_FACTS_UNKNOWN' USING ERRCODE='23514';
  END IF;
  SELECT * INTO subscription FROM user_subscriptions WHERE id=(
    SELECT candidates.id FROM (SELECT id,status,stripe_subscription_id,updated_at FROM user_subscriptions
      WHERE user_id=p_user_id ORDER BY updated_at DESC LIMIT 10) candidates
    ORDER BY CASE WHEN stripe_subscription_id IS NOT NULL AND lower(status) IN ('active','trialing','past_due','incomplete','unpaid')
      THEN 0 ELSE 1 END,updated_at DESC LIMIT 1) FOR SHARE;
  IF subscription.id IS NOT NULL AND (subscription.payment_channel IS NOT NULL OR subscription.stripe_subscription_id IS NOT NULL) THEN
    IF subscription.payment_channel IS DISTINCT FROM 'stripe' OR (SELECT count(*) FROM payment_provider_refs r
      WHERE r.subscription_id=subscription.id AND r.channel='stripe' AND r.object_type='subscription'
        AND r.merchant_namespace=subscription.merchant_namespace AND r.mode=subscription.payment_mode)<>1 THEN
      RAISE EXCEPTION 'PAY_COMMON_MEMBERSHIP_FACTS_UNKNOWN' USING ERRCODE='23514';
    END IF;
    IF lower(subscription.status) IN ('active','trialing','past_due','incomplete','unpaid') THEN
      IF p_level='free' OR subscription.cancel_at_period_end='true' AND subscription.current_period_end<=now() THEN
        RAISE EXCEPTION 'ENTITLEMENT_CONFLICT' USING ERRCODE='23514';
      END IF;
      IF p_item_type='membership_plan' THEN RAISE EXCEPTION 'ACTIVE_SUBSCRIPTION_EXISTS' USING ERRCODE='23514'; END IF;
    ELSIF lower(subscription.status) IN ('canceled','cancelled') AND p_level<>'free' THEN
      RAISE EXCEPTION 'ENTITLEMENT_CONFLICT' USING ERRCODE='23514';
    END IF;
  END IF;
  IF p_item_type='membership_plan' AND p_level<>'free' THEN
    RAISE EXCEPTION 'UPGRADE_DOWNGRADE_UNSUPPORTED' USING ERRCODE='23514';
  END IF;
END $fn$;
REVOKE ALL ON FUNCTION public.pay_common_assert_purchase_facts(uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;

-- Keep catalog administration on its existing tables. This narrow transaction is needed
-- because separate PostgREST writes cannot atomically select a current mapping and derive old IDs.
CREATE FUNCTION public.pay_common_save_catalog(p_kind text,p_id uuid,p_values jsonb,p_prices jsonb,
  p_merchant_namespace text,p_payment_mode text,p_expected_level text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE table_name text; allowed text[]; cols text; values_sql text; saved jsonb; current_row jsonb;
  cycle text; price jsonb; expected_cents integer; target uuid:=coalesce(p_id,gen_random_uuid()); old_ref public.payment_provider_refs;
BEGIN
  IF p_kind='credit_package' THEN
    table_name:='credit_packages';
    allowed:=ARRAY['name','price','credits_amount','bonus_credits','sort_order','is_popular','active'];
  ELSIF p_kind='membership_plan' THEN
    table_name:='membership_plans';
    allowed:=ARRAY['name','level','monthly_price','yearly_price','monthly_credits','yearly_credits','monthly_bonus_credits',
      'package_discount','features','max_context_messages','allow_export','allow_batch_export','is_active','sort_order',
      'allow_fusion_review','allow_fusion_compare','library_storage_bytes'];
  ELSE RAISE EXCEPTION 'PAY_COMMON_PRODUCT_UNAVAILABLE'; END IF;
  IF jsonb_typeof(p_values) IS DISTINCT FROM 'object' OR p_values-allowed<>'{}'::jsonb OR p_id IS NULL AND p_values='{}'::jsonb
    OR jsonb_typeof(p_prices) IS DISTINCT FROM 'object'
    OR p_prices-(CASE WHEN p_kind='credit_package' THEN ARRAY['one_time'] ELSE ARRAY['monthly','yearly'] END)<>'{}'::jsonb THEN
    RAISE EXCEPTION 'PAY_COMMON_CATALOG_INPUT_INVALID' USING ERRCODE='23514';
  END IF;
  IF p_prices<>'{}'::jsonb AND (p_merchant_namespace IS NULL OR p_merchant_namespace !~ '^[A-Za-z0-9_-]{1,64}$'
    OR p_payment_mode IS NULL OR p_payment_mode NOT IN ('test','live')) THEN
    RAISE EXCEPTION 'PAY_COMMON_PROVIDER_SCOPE_UNKNOWN';
  END IF;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1 FOR UPDATE',table_name) INTO current_row USING target;
  IF p_id IS NOT NULL AND current_row IS NULL THEN RAISE EXCEPTION 'PAY_COMMON_PRODUCT_UNAVAILABLE'; END IF;
  IF p_expected_level IS NOT NULL AND current_row->>'level' IS DISTINCT FROM p_expected_level THEN
    RAISE EXCEPTION 'PAY_COMMON_CATALOG_CONFLICT' USING ERRCODE='40001';
  END IF;
  -- A catalog amount cannot leave the old current Stripe price buyable. Require an
  -- explicitly supplied, validated price (or explicit removal) for each changed cycle.
  IF current_row IS NOT NULL THEN
    FOREACH cycle IN ARRAY CASE WHEN p_kind='credit_package' THEN ARRAY['one_time'] ELSE ARRAY['monthly','yearly'] END LOOP
      IF p_values ? (CASE cycle WHEN 'monthly' THEN 'monthly_price' WHEN 'yearly' THEN 'yearly_price' ELSE 'price' END)
        AND (p_values->(CASE cycle WHEN 'monthly' THEN 'monthly_price' WHEN 'yearly' THEN 'yearly_price' ELSE 'price' END))
          IS DISTINCT FROM (current_row->(CASE cycle WHEN 'monthly' THEN 'monthly_price' WHEN 'yearly' THEN 'yearly_price' ELSE 'price' END))
        AND NOT (p_prices ? cycle) THEN
        RAISE EXCEPTION 'PAY_COMMON_PRICE_REPLACEMENT_REQUIRED' USING ERRCODE='23514';
      END IF;
    END LOOP;
  END IF;
  SELECT string_agg(quote_ident(k),',' ORDER BY k),string_agg('v.'||quote_ident(k),',' ORDER BY k)
    INTO cols,values_sql FROM jsonb_object_keys(p_values) k;
  IF p_id IS NULL THEN
    EXECUTE format('INSERT INTO public.%I(id,%s) SELECT $1,%s FROM jsonb_populate_record(NULL::public.%I,$2) v RETURNING to_jsonb(%I.*)',
      table_name,cols,values_sql,table_name,table_name) INTO saved USING target,p_values;
  ELSE
    IF p_values='{}'::jsonb THEN saved:=current_row; ELSE
    EXECUTE format('UPDATE public.%I t SET (%s)=(SELECT %s FROM jsonb_populate_record(NULL::public.%I,$2) v) WHERE id=$1 RETURNING to_jsonb(t.*)',
      table_name,cols,values_sql,table_name) INTO saved USING target,p_values;
    END IF;
  END IF;
  FOR cycle,price IN SELECT key,value FROM jsonb_each(p_prices) LOOP
    IF price<>'null'::jsonb THEN
      expected_cents:=(saved->>CASE cycle WHEN 'monthly' THEN 'monthly_price' WHEN 'yearly' THEN 'yearly_price' ELSE 'price' END)::integer;
      IF price->>'external_id' IS NULL OR price->>'external_id' !~ '^price_[A-Za-z0-9_]+$'
        OR price->>'unit_amount' IS DISTINCT FROM expected_cents::text OR expected_cents<=0
        OR price->>'currency' IS DISTINCT FROM 'usd' OR price->>'mode' IS DISTINCT FROM p_payment_mode
        OR price->>'billing_cycle' IS DISTINCT FROM cycle THEN RAISE EXCEPTION 'PAY_COMMON_PRICE_MISMATCH' USING ERRCODE='23514'; END IF;
      SELECT * INTO old_ref FROM payment_provider_refs WHERE channel='stripe' AND merchant_namespace=p_merchant_namespace
        AND object_type='price' AND external_id=price->>'external_id';
      IF FOUND AND (old_ref.mode<>p_payment_mode OR old_ref.billing_cycle<>cycle
        OR (CASE p_kind WHEN 'credit_package' THEN old_ref.credit_package_id IS DISTINCT FROM target
          ELSE old_ref.membership_plan_id IS DISTINCT FROM target END)) THEN
        RAISE EXCEPTION 'PAY_COMMON_PRICE_MAPPING_CONFLICT' USING ERRCODE='23514';
      END IF;
    END IF;
    UPDATE payment_provider_refs SET is_current=false WHERE channel='stripe' AND merchant_namespace=p_merchant_namespace
      AND mode=p_payment_mode AND object_type='price' AND billing_cycle=cycle
      AND CASE p_kind WHEN 'credit_package' THEN credit_package_id=target ELSE membership_plan_id=target END;
    IF price<>'null'::jsonb THEN
      INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,billing_cycle,
        credit_package_id,membership_plan_id,is_current)
      VALUES('stripe',p_merchant_namespace,p_payment_mode,'price',price->>'external_id',cycle,
        CASE WHEN p_kind='credit_package' THEN target END,CASE WHEN p_kind='membership_plan' THEN target END,true)
      ON CONFLICT(channel,merchant_namespace,object_type,external_id) DO UPDATE SET is_current=true;
      IF NOT EXISTS(SELECT 1 FROM payment_provider_refs WHERE channel='stripe' AND merchant_namespace=p_merchant_namespace
        AND mode=p_payment_mode AND object_type='price' AND external_id=price->>'external_id' AND billing_cycle=cycle
        AND CASE p_kind WHEN 'credit_package' THEN credit_package_id=target ELSE membership_plan_id=target END) THEN
        RAISE EXCEPTION 'PAY_COMMON_PRICE_MAPPING_CONFLICT' USING ERRCODE='23514';
      END IF;
    END IF;
    EXECUTE format('UPDATE public.%I SET %I=$2 WHERE id=$1',table_name,
      CASE cycle WHEN 'monthly' THEN 'stripe_monthly_price_id' WHEN 'yearly' THEN 'stripe_yearly_price_id' ELSE 'stripe_price_id' END)
      USING target,CASE WHEN price<>'null'::jsonb THEN price->>'external_id' END;
  END LOOP;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1',table_name) INTO saved USING target;
  RETURN saved;
END $fn$;
REVOKE ALL ON FUNCTION public.pay_common_save_catalog(text,uuid,jsonb,jsonb,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_common_save_catalog(text,uuid,jsonb,jsonb,text,text,text) TO service_role;

-- Safe projection of existing facts: callers receive no merchant namespace, mode, snapshot or
-- private mapping rows. The projection is computed on read and is never a second membership store.
CREATE FUNCTION public.pay_common_membership_facts(p_user_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE subscriptions jsonb; latest_order jsonb;
BEGIN
  IF p_user_id IS NULL OR (current_setting('role',true) IS DISTINCT FROM 'service_role'
    AND auth.uid() IS DISTINCT FROM p_user_id AND NOT EXISTS(SELECT 1 FROM profiles
      WHERE id=auth.uid() AND role='admin' AND status='active' AND is_deleted='false')) THEN
    RAISE EXCEPTION 'PAY_COMMON_FACTS_ACCESS_DENIED' USING ERRCODE='42501';
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) INTO subscriptions FROM (
    SELECT s.id,s.membership_plan_id,s.status,s.cancel_at_period_end,s.billing_cycle,s.current_period_end,s.metadata,
      s.payment_channel,
      CASE WHEN s.payment_channel IS NULL AND s.stripe_subscription_id IS NULL THEN 'none'
        WHEN s.payment_channel='stripe' AND (SELECT count(*) FROM payment_provider_refs r
          WHERE r.subscription_id=s.id AND r.channel=s.payment_channel AND r.merchant_namespace=s.merchant_namespace
            AND r.mode=s.payment_mode AND r.object_type='subscription')=1 THEN 'mapped'
        ELSE 'unknown' END AS mapping_state
    FROM user_subscriptions s WHERE user_id=p_user_id ORDER BY updated_at DESC LIMIT 10
  ) x;
  SELECT jsonb_build_object('id',id,'status',status,'payment_status',payment_status,'metadata',metadata)
    INTO latest_order FROM payment_orders WHERE user_id=p_user_id AND item_type='membership_plan'
    ORDER BY updated_at DESC LIMIT 1;
  RETURN jsonb_build_object('subscriptions',subscriptions,'latest_order',latest_order);
END $fn$;
REVOKE ALL ON FUNCTION public.pay_common_membership_facts(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.pay_common_membership_facts(uuid) TO authenticated,service_role;

-- Existing invoice fulfillment transaction, extended with frozen terms and provider mappings.
CREATE OR REPLACE FUNCTION public.atomic_grant_subscription_invoice_credits(p_user_id uuid, p_membership_plan_id uuid, p_stripe_subscription_id text, p_stripe_invoice_id text, p_source_order_id uuid, p_amount_total integer DEFAULT NULL::integer, p_currency text DEFAULT 'usd'::text, p_payment_status text DEFAULT 'paid'::text, p_stripe_customer_id text DEFAULT NULL::text, p_grant_period_key text DEFAULT NULL::text, p_period_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_period_end timestamp with time zone DEFAULT NULL::timestamp with time zone, p_period_index integer DEFAULT NULL::integer, p_total_periods integer DEFAULT 1, p_credits_granted integer DEFAULT NULL::integer, p_billing_cycle text DEFAULT 'monthly'::text, p_membership_level text DEFAULT NULL::text, p_can_promote_checkout_order boolean DEFAULT false, p_grant_type text DEFAULT 'monthly_invoice'::text, p_idempotency_key text DEFAULT NULL::text, p_description text DEFAULT NULL::text, p_source_type text DEFAULT 'stripe_invoice'::text, p_source_id text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb, p_grant_metadata jsonb DEFAULT '{}'::jsonb, p_now timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(transaction_id uuid, balance_before integer, balance_after integer, amount integer, is_idempotent boolean, granted boolean, blocked_by_termination boolean, grant_id uuid, credits_granted integer, invoice_order_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_source public.payment_orders;
  v_subscription public.user_subscriptions;
  v_scope_ref public.payment_provider_refs;
  v_expected_credits integer;
  v_facts jsonb;
  v_fact jsonb;
  v_kind text;
  v_now TIMESTAMPTZ := COALESCE(p_now, now());
  v_balance_before INTEGER;
  v_balance_after INTEGER;
  v_source_status TEXT;
  v_source_payment_status TEXT;
  v_source_metadata JSONB;
  v_source_customer_id TEXT;
  v_source_price_id TEXT;
  v_source_checkout_session_id TEXT;
  v_invoice_status TEXT;
  v_invoice_payment_status TEXT;
  v_invoice_metadata JSONB;
  v_mirror_id UUID;
  v_mirror_metadata JSONB;
  v_terminated_at TIMESTAMPTZ;
  v_grant_period_start TIMESTAMPTZ;
  v_grant_period_end TIMESTAMPTZ;
  v_grant_period_key TEXT;
  v_grant_period_index INTEGER;
  v_grant_total_periods INTEGER;
  v_existing_grant_id UUID;
  v_existing_grant_transaction_id UUID;
  v_existing_grant_credits INTEGER;
  v_existing_grant_period_start TIMESTAMPTZ;
  v_existing_grant_period_end TIMESTAMPTZ;
  v_existing_grant_period_key TEXT;
  v_existing_grant_period_index INTEGER;
  v_existing_grant_total_periods INTEGER;
  v_transaction_id UUID;
  v_grant_id UUID;
BEGIN
  IF p_metadata->>'stripeSubscriptionStatus' IS NULL OR p_metadata->>'stripeSubscriptionStatus'
    NOT IN ('active','trialing','past_due','unpaid','incomplete','canceled','incomplete_expired','paused')
    OR p_metadata->>'stripeSubscriptionUserId' IS DISTINCT FROM p_user_id::text THEN
    RAISE EXCEPTION 'PAY_COMMON_SUBSCRIPTION_RECEIPT_MISMATCH';
  END IF;
  IF p_user_id IS NULL OR p_membership_plan_id IS NULL
     OR NULLIF(btrim(COALESCE(p_stripe_subscription_id, '')), '') IS NULL
     OR NULLIF(btrim(COALESCE(p_stripe_invoice_id, '')), '') IS NULL
     OR p_source_order_id IS NULL
     OR NULLIF(btrim(COALESCE(p_grant_period_key, '')), '') IS NULL
     OR NULLIF(btrim(COALESCE(p_idempotency_key, '')), '') IS NULL
     OR p_period_start IS NULL OR p_period_end IS NULL OR p_period_end <= p_period_start
     OR p_credits_granted IS NULL OR p_credits_granted <= 0 THEN
    RAISE EXCEPTION 'INVOICE_GRANT_ADMISSION_INPUT_INVALID';
  END IF;

  SELECT credits INTO v_balance_before
  FROM profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_GRANT_PROFILE_MISSING: %', p_user_id;
  END IF;

  SELECT * INTO v_source FROM payment_orders WHERE id=p_source_order_id FOR UPDATE;
  IF NOT FOUND OR v_source.user_id IS DISTINCT FROM p_user_id OR v_source.payment_channel IS DISTINCT FROM 'stripe'
    OR v_source.item_type IS DISTINCT FROM 'membership_plan' OR v_source.item_id IS DISTINCT FROM p_membership_plan_id
    OR v_source.billing_cycle IS DISTINCT FROM p_billing_cycle OR v_source.purchase_snapshot IS NULL
    OR v_source.purchase_membership_level IS DISTINCT FROM p_membership_level
    OR v_source.purchase_closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'PAY_COMMON_INVOICE_SOURCE_MISMATCH';
  END IF;
  SELECT * INTO v_scope_ref FROM payment_provider_refs WHERE id=v_source.price_ref_id AND object_type='price'
    AND channel=v_source.payment_channel AND merchant_namespace=v_source.merchant_namespace AND mode=v_source.payment_mode;
  IF NOT FOUND OR p_payment_status IS DISTINCT FROM 'paid' OR p_currency IS DISTINCT FROM v_source.currency
    OR p_amount_total IS DISTINCT FROM ((v_source.purchase_snapshot->>'price')::numeric*100
      -(v_source.purchase_snapshot->>'discount')::numeric*100)::integer THEN
    RAISE EXCEPTION 'PAY_COMMON_INVOICE_RECEIPT_MISMATCH';
  END IF;
  IF (v_source.stripe_customer_id IS NOT NULL AND p_stripe_customer_id IS DISTINCT FROM v_source.stripe_customer_id)
    OR (p_period_start AT TIME ZONE 'UTC')::time IS DISTINCT FROM (p_period_end AT TIME ZONE 'UTC')::time
    OR (p_billing_cycle='monthly' AND p_period_end-p_period_start NOT BETWEEN interval '28 days' AND interval '31 days')
    OR (p_billing_cycle='yearly' AND p_period_end-p_period_start NOT BETWEEN interval '365 days' AND interval '366 days') THEN
    RAISE EXCEPTION 'PAY_COMMON_INVOICE_RECEIPT_MISMATCH';
  END IF;
  v_expected_credits:=(v_source.purchase_snapshot->>'credits')::integer;
  IF p_billing_cycle='yearly' THEN
    v_expected_credits:=v_expected_credits/12+CASE WHEN v_expected_credits%12>0 THEN 1 ELSE 0 END;
  ELSE v_expected_credits:=v_expected_credits+(v_source.purchase_snapshot->>'bonus_credits')::integer;
  END IF;
  IF p_credits_granted IS DISTINCT FROM v_expected_credits THEN RAISE EXCEPTION 'PAY_COMMON_GRANT_SNAPSHOT_MISMATCH'; END IF;
  v_source_status:=v_source.status; v_source_payment_status:=v_source.payment_status;
  v_source_metadata:=v_source.metadata; v_source_customer_id:=v_source.stripe_customer_id;
  v_source_price_id:=v_scope_ref.external_id;
  SELECT external_id INTO v_source_checkout_session_id FROM payment_provider_refs
    WHERE order_id=v_source.id AND object_type='checkout' AND channel=v_source.payment_channel
      AND merchant_namespace=v_source.merchant_namespace AND mode=v_source.payment_mode;
  SELECT o.id,o.status,o.payment_status,o.metadata
    INTO invoice_order_id,v_invoice_status,v_invoice_payment_status,v_invoice_metadata
    FROM payment_orders o JOIN payment_provider_refs r ON r.order_id=o.id
    WHERE r.channel=v_source.payment_channel AND r.merchant_namespace=v_source.merchant_namespace
      AND r.mode=v_source.payment_mode AND r.object_type='invoice' AND r.external_id=p_stripe_invoice_id
    FOR UPDATE OF o;
  IF invoice_order_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payment_orders WHERE id=invoice_order_id
    AND user_id=p_user_id AND item_id=p_membership_plan_id AND purchase_snapshot=v_source.purchase_snapshot) THEN
    RAISE EXCEPTION 'PAY_COMMON_INVOICE_SOURCE_MISMATCH';
  END IF;

  IF lower(COALESCE(v_source_status, '')) IN ('refunded', 'partially_refunded')
     OR lower(COALESCE(v_source_payment_status, '')) IN ('refunded', 'partially_refunded')
     OR v_source_metadata ? 'stripeRefund'
     OR v_source_metadata ? 'subscriptionCreditGrantReversal'
     OR lower(COALESCE(v_invoice_status, '')) IN ('refunded', 'partially_refunded')
     OR lower(COALESCE(v_invoice_payment_status, '')) IN ('refunded', 'partially_refunded')
     OR v_invoice_metadata ? 'stripeRefund'
     OR v_invoice_metadata ? 'subscriptionCreditGrantReversal' THEN
    RETURN QUERY SELECT NULL::UUID, v_balance_before, v_balance_before, 0, FALSE, FALSE, TRUE, NULL::UUID, 0, invoice_order_id;
    RETURN;
  END IF;

  SELECT s.* INTO v_subscription FROM user_subscriptions s JOIN payment_provider_refs r ON r.subscription_id=s.id
    WHERE r.channel=v_source.payment_channel AND r.merchant_namespace=v_source.merchant_namespace
      AND r.mode=v_source.payment_mode AND r.object_type='subscription' AND r.external_id=p_stripe_subscription_id
    FOR UPDATE OF s;
  IF FOUND AND (v_subscription.user_id IS DISTINCT FROM p_user_id
    OR v_source.subscription_id IS NOT NULL AND v_source.subscription_id<>v_subscription.id) THEN
    RAISE EXCEPTION 'PAY_COMMON_SUBSCRIPTION_OWNER_MISMATCH';
  END IF;
  IF v_subscription.stripe_customer_id IS NOT NULL
    AND p_stripe_customer_id IS DISTINCT FROM v_subscription.stripe_customer_id THEN
    RAISE EXCEPTION 'PAY_COMMON_INVOICE_RECEIPT_MISMATCH';
  END IF;
  v_mirror_id:=v_subscription.id; v_terminated_at:=v_subscription.credit_release_terminated_at;
  v_mirror_metadata:=v_subscription.metadata;
  IF v_mirror_id IS NOT NULL AND v_terminated_at IS NOT NULL THEN
    RETURN QUERY SELECT NULL::UUID, v_balance_before, v_balance_before, 0, FALSE, FALSE, TRUE, NULL::UUID, 0, invoice_order_id;
    RETURN;
  END IF;

  -- Invoice p_period_start/end are the full Stripe subscription term. The
  -- annual grant row receives its own internally derived period-01 window.
  IF p_billing_cycle = 'yearly' THEN
    IF p_grant_type IS DISTINCT FROM 'annual_monthly_release'
       OR p_period_index IS DISTINCT FROM 1
       OR p_total_periods IS DISTINCT FROM 12 THEN
      RAISE EXCEPTION 'INVOICE_GRANT_ANNUAL_PERIOD_INPUT_INVALID';
    END IF;
    v_grant_period_start := p_period_start;
    v_grant_period_end := LEAST(
      (((p_period_start AT TIME ZONE 'UTC') + make_interval(months => 1)) AT TIME ZONE 'UTC'),
      p_period_end
    );
    v_grant_period_index := 1;
    v_grant_total_periods := 12;
    v_grant_period_key := format(
      'annual:%s:01',
      to_char(p_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
    IF v_grant_period_start >= v_grant_period_end
       OR p_grant_period_key IS DISTINCT FROM v_grant_period_key THEN
      RAISE EXCEPTION 'INVOICE_GRANT_ANNUAL_TERM_OR_KEY_NONCANONICAL';
    END IF;
  ELSIF p_billing_cycle = 'monthly' THEN
    IF p_grant_type IS DISTINCT FROM 'monthly_invoice' THEN
      RAISE EXCEPTION 'INVOICE_GRANT_MONTHLY_PERIOD_INPUT_INVALID';
    END IF;
    v_grant_period_start := p_period_start;
    v_grant_period_end := p_period_end;
    v_grant_period_index := p_period_index;
    v_grant_total_periods := p_total_periods;
    v_grant_period_key := p_grant_period_key;
  ELSE
    RAISE EXCEPTION 'INVOICE_GRANT_BILLING_CYCLE_INVALID';
  END IF;

  SELECT id, credit_transaction_id, subscription_credit_grants.credits_granted, period_start, period_end,
         grant_period_key, period_index, total_periods
  INTO v_existing_grant_id, v_existing_grant_transaction_id, v_existing_grant_credits,
       v_existing_grant_period_start, v_existing_grant_period_end,
       v_existing_grant_period_key, v_existing_grant_period_index, v_existing_grant_total_periods
  FROM subscription_credit_grants
  WHERE subscription_id = v_mirror_id
    AND (idempotency_key = p_idempotency_key OR grant_period_key = p_grant_period_key
      OR (grant_type=p_grant_type AND period_start=v_grant_period_start AND period_end=v_grant_period_end
        AND membership_plan_id=p_membership_plan_id))
  ORDER BY (idempotency_key = p_idempotency_key) DESC, created_at ASC
  LIMIT 1 FOR UPDATE;

  IF FOUND THEN
    IF v_existing_grant_period_start IS DISTINCT FROM v_grant_period_start
       OR v_existing_grant_period_end IS DISTINCT FROM v_grant_period_end
       OR v_existing_grant_period_key IS DISTINCT FROM v_grant_period_key
       OR v_existing_grant_period_index IS DISTINCT FROM v_grant_period_index
       OR v_existing_grant_total_periods IS DISTINCT FROM v_grant_total_periods THEN
      RAISE EXCEPTION 'INVOICE_GRANT_EXISTING_REPLAY_ROW_NONCANONICAL';
    END IF;
    RETURN QUERY SELECT v_existing_grant_transaction_id, v_balance_before, v_balance_before,
      COALESCE(v_existing_grant_credits, 0), TRUE, FALSE, FALSE, v_existing_grant_id,
      COALESCE(v_existing_grant_credits, 0), invoice_order_id;
    RETURN;
  END IF;

  IF v_mirror_id IS NULL THEN
    IF v_source.purchase_action IS DISTINCT FROM 'checkout' OR v_source.fulfilled_at IS NOT NULL
      OR v_source.subscription_id IS NOT NULL THEN RAISE EXCEPTION 'PAY_COMMON_SUBSCRIPTION_MAPPING_MISSING'; END IF;
    INSERT INTO user_subscriptions(user_id,membership_plan_id,stripe_subscription_id,stripe_customer_id,stripe_price_id,
      billing_cycle,status,current_period_start,current_period_end,payment_channel,merchant_namespace,payment_mode,contract_snapshot)
    VALUES(p_user_id,p_membership_plan_id,p_stripe_subscription_id,p_stripe_customer_id,v_source_price_id,p_billing_cycle,
      p_metadata->>'stripeSubscriptionStatus',p_period_start,p_period_end,v_source.payment_channel,v_source.merchant_namespace,v_source.payment_mode,v_source.purchase_snapshot)
    RETURNING id INTO v_mirror_id;
    INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,subscription_id)
    VALUES(v_source.payment_channel,v_source.merchant_namespace,v_source.payment_mode,'subscription',p_stripe_subscription_id,v_mirror_id);
  END IF;
  IF invoice_order_id IS NULL THEN
    IF v_source.purchase_action IN ('checkout','subscription_change') AND v_source.fulfilled_at IS NULL THEN invoice_order_id:=v_source.id;
    ELSE
      INSERT INTO payment_orders(user_id,item_type,item_id,billing_cycle,amount_total,currency,mode,status,payment_status,
        payment_channel,merchant_namespace,payment_mode,purchase_request_id,purchase_payload_hash,purchase_snapshot,price_ref_id,purchase_action,
        purchase_membership_level,source_order_id,subscription_id)
      VALUES(p_user_id,'membership_plan',p_membership_plan_id,p_billing_cycle,p_amount_total,p_currency,'subscription','pending','paid',
        v_source.payment_channel,v_source.merchant_namespace,v_source.payment_mode,gen_random_uuid(),
        encode(extensions.digest('invoice:'||p_stripe_invoice_id,'sha256'),'hex'),v_source.purchase_snapshot,v_source.price_ref_id,
        'renewal',v_source.purchase_membership_level,v_source.id,v_mirror_id) RETURNING id INTO invoice_order_id;
    END IF;
    INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
      VALUES(v_source.payment_channel,v_source.merchant_namespace,v_source.payment_mode,'invoice',p_stripe_invoice_id,invoice_order_id);
  END IF;
  UPDATE payment_orders SET subscription_id=v_mirror_id,stripe_subscription_id=p_stripe_subscription_id
    WHERE id IN (invoice_order_id,v_source.id);
  SELECT coalesce(payment_amount_facts,'[]'::jsonb) INTO v_facts FROM payment_orders WHERE id=invoice_order_id;
  FOREACH v_kind IN ARRAY ARRAY['paid','fee','net'] LOOP
    v_fact:=jsonb_build_object('kind',v_kind,'amount',CASE WHEN v_kind='paid' THEN (p_amount_total::numeric/100)::numeric(18,2)::text END,
      'currency',p_currency,'unit','major','evidence_ref',p_stripe_invoice_id);
    IF NOT v_facts @> jsonb_build_array(v_fact) THEN v_facts:=v_facts||jsonb_build_array(v_fact); END IF;
  END LOOP;
  IF jsonb_array_length(v_facts)>128 THEN RAISE EXCEPTION 'PAY_COMMON_AMOUNT_FACT_LIMIT'; END IF;
  UPDATE payment_orders SET stripe_invoice_id=p_stripe_invoice_id,stripe_price_id=v_source_price_id,
    stripe_customer_id=p_stripe_customer_id,payment_amount_facts=v_facts WHERE id=invoice_order_id;

  v_balance_after := v_balance_before + p_credits_granted;
  INSERT INTO credit_transactions (
    user_id, amount, type, description, idempotency_key, balance_before, balance_after,
    ledger_type, reason_code, counts_as_spend, source_type, source_id, source_order_id,
    grant_period_key, metadata
  ) VALUES (
    p_user_id, p_credits_granted, 'addition', p_description, p_idempotency_key, v_balance_before, v_balance_after,
    'grant', p_grant_type, FALSE, p_source_type, p_source_id, p_source_order_id,
    v_grant_period_key, COALESCE(p_metadata, '{}'::JSONB)
  ) RETURNING id INTO v_transaction_id;

  UPDATE profiles
  SET credits = v_balance_after,
      membership_level = CASE WHEN status='active' AND is_deleted='false'
        AND p_metadata->>'stripeSubscriptionStatus' IN ('active','trialing')
        AND (v_subscription.id IS NULL OR v_subscription.status NOT IN ('canceled','cancelled','incomplete_expired'))
        AND NOT EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=p_user_id)
        AND (v_subscription.current_period_start IS NULL OR p_period_start>=v_subscription.current_period_start)
        THEN p_membership_level ELSE membership_level END
  WHERE id = p_user_id;

  INSERT INTO subscription_credit_grants (
    subscription_id,source_order_id,grant_snapshot,
    user_id, membership_plan_id, stripe_subscription_id, stripe_invoice_id, billing_cycle,
    grant_type, grant_period_key, period_start, period_end, period_index, total_periods,
    credits_granted, status, idempotency_key, credit_transaction_id, metadata, created_at, updated_at
  ) VALUES (
    v_mirror_id,invoice_order_id,v_source.purchase_snapshot,
    p_user_id, p_membership_plan_id, p_stripe_subscription_id, p_stripe_invoice_id,
    CASE WHEN p_billing_cycle = 'yearly' THEN 'yearly' ELSE 'monthly' END,
    p_grant_type, v_grant_period_key, v_grant_period_start, v_grant_period_end, v_grant_period_index, v_grant_total_periods,
    p_credits_granted, 'granted', p_idempotency_key, v_transaction_id, COALESCE(p_grant_metadata, '{}'::JSONB), v_now, v_now
  ) RETURNING id INTO v_grant_id;

  -- A late invoice can settle its original period, but cannot roll the current contract back.
  UPDATE user_subscriptions SET membership_plan_id=p_membership_plan_id,stripe_price_id=v_source_price_id,
    stripe_customer_id=p_stripe_customer_id,billing_cycle=p_billing_cycle,current_period_start=p_period_start,
    current_period_end=p_period_end,metadata=coalesce(metadata,'{}')||jsonb_build_object('lastInvoiceId',p_stripe_invoice_id),
    updated_at=v_now
    WHERE id=v_mirror_id AND credit_release_terminated_at IS NULL
      AND (current_period_start IS NULL OR current_period_start<=p_period_start);
  UPDATE payment_orders SET status='completed',payment_status='paid',fulfilled_at=v_now,
    metadata=metadata||jsonb_build_object('transactionId',v_transaction_id,'subscriptionCreditGrantId',v_grant_id,
      'grantedCredits',p_credits_granted,'fulfillmentSource','atomic_grant_subscription_invoice_credits'),updated_at=v_now
    WHERE id=invoice_order_id;

  RETURN QUERY SELECT v_transaction_id, v_balance_before, v_balance_after, p_credits_granted,
    FALSE, TRUE, FALSE, v_grant_id, p_credits_granted, invoice_order_id;
END;
$function$;

-- Annual releases retain the original UTC schedule and share frozen period-01 terms.
CREATE OR REPLACE FUNCTION public.atomic_grant_annual_subscription_credits(p_user_id uuid, p_membership_plan_id uuid, p_stripe_subscription_id text, p_stripe_invoice_id text, p_grant_period_key text, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_period_index integer, p_total_periods integer, p_credits_granted integer, p_idempotency_key text, p_description text, p_source_type text, p_source_id text, p_source_order_id uuid DEFAULT NULL::uuid, p_metadata jsonb DEFAULT '{}'::jsonb, p_grant_metadata jsonb DEFAULT '{}'::jsonb, p_now timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(transaction_id uuid, balance_before integer, balance_after integer, amount integer, is_idempotent boolean, granted boolean, blocked_by_termination boolean, grant_id uuid, credits_granted integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_source public.payment_orders;
  v_internal_subscription uuid;
  v_opening public.subscription_credit_grants;
  v_yearly_credits integer;
  v_now TIMESTAMPTZ := COALESCE(p_now, now());
  v_balance_before INTEGER;
  v_balance_after INTEGER;
  v_subscription_termination_at TIMESTAMPTZ;
  v_term_membership_plan_id UUID;
  v_term_billing_cycle TEXT;
  v_term_start TIMESTAMPTZ;
  v_term_end TIMESTAMPTZ;
  v_expected_period_start TIMESTAMPTZ;
  v_expected_period_end TIMESTAMPTZ;
  v_expected_period_key TEXT;
  v_existing_grant_id UUID;
  v_existing_grant_transaction_id UUID;
  v_existing_grant_credits INTEGER;
  v_existing_period_start TIMESTAMPTZ;
  v_existing_period_end TIMESTAMPTZ;
  v_existing_period_index INTEGER;
  v_existing_total_periods INTEGER;
  v_existing_period_key TEXT;
  v_existing_membership_plan_id UUID;
  v_transaction_id UUID;
  v_grant_id UUID;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'ANNUAL_GRANT_USER_REQUIRED';
  END IF;

  IF btrim(COALESCE(p_stripe_subscription_id, '')) = '' THEN
    RAISE EXCEPTION 'ANNUAL_GRANT_SUBSCRIPTION_ID_REQUIRED';
  END IF;

  IF btrim(COALESCE(p_grant_period_key, '')) = ''
     OR btrim(COALESCE(p_idempotency_key, '')) = '' THEN
    RAISE EXCEPTION 'ANNUAL_GRANT_IDEMPOTENCY_REQUIRED';
  END IF;

  IF p_credits_granted IS NULL OR p_credits_granted <= 0 THEN
    RAISE EXCEPTION 'ANNUAL_GRANT_AMOUNT_MUST_BE_POSITIVE';
  END IF;

  -- Lock order begins at the profile, matching the refund and existing billing
  -- RPCs. No credit mutation occurs before the termination re-read below.
  SELECT credits
  INTO v_balance_before
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNUAL_GRANT_PROFILE_MISSING: %', p_user_id;
  END IF;

  SELECT * INTO v_source FROM payment_orders WHERE id=p_source_order_id FOR UPDATE;
  IF NOT FOUND OR v_source.user_id IS DISTINCT FROM p_user_id OR v_source.payment_channel IS DISTINCT FROM 'stripe'
    OR v_source.subscription_id IS NULL OR v_source.purchase_snapshot IS NULL
    OR v_source.billing_cycle IS DISTINCT FROM 'yearly' OR v_source.item_id IS DISTINCT FROM p_membership_plan_id
    OR v_source.payment_status IS DISTINCT FROM 'paid' OR v_source.fulfilled_at IS NULL
    OR NOT EXISTS(SELECT 1 FROM payment_provider_refs WHERE order_id=v_source.id AND object_type='invoice'
      AND external_id=p_stripe_invoice_id AND channel=v_source.payment_channel
      AND merchant_namespace=v_source.merchant_namespace AND mode=v_source.payment_mode) THEN
    RAISE EXCEPTION 'PAY_COMMON_ANNUAL_CONTRACT_UNKNOWN';
  END IF;
  SELECT s.id,s.membership_plan_id,s.billing_cycle,s.current_period_start,s.current_period_end,s.credit_release_terminated_at
    INTO v_internal_subscription,v_term_membership_plan_id,v_term_billing_cycle,v_term_start,v_term_end,v_subscription_termination_at
    FROM user_subscriptions s JOIN payment_provider_refs r ON r.subscription_id=s.id
    WHERE s.id=v_source.subscription_id AND s.user_id=p_user_id AND r.object_type='subscription'
      AND r.external_id=p_stripe_subscription_id AND r.channel=v_source.payment_channel
      AND r.merchant_namespace=v_source.merchant_namespace AND r.mode=v_source.payment_mode FOR UPDATE OF s;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAY_COMMON_SUBSCRIPTION_MAPPING_MISSING'; END IF;

  IF v_subscription_termination_at IS NOT NULL THEN
    RETURN QUERY SELECT
      NULL::UUID,
      v_balance_before,
      v_balance_before,
      0,
      FALSE,
      FALSE,
      TRUE,
      NULL::UUID,
      0;
    RETURN;
  END IF;

  -- The cron input is only a hint. Under the profile -> subscription lock,
  -- derive the one canonical annual period from the mirror and reject any
  -- stale-term, malformed, or replay-poisoning request before ledger writes.
  IF v_term_billing_cycle IS DISTINCT FROM 'yearly'
     OR v_term_membership_plan_id IS DISTINCT FROM p_membership_plan_id
     OR v_term_start IS NULL OR v_term_end IS NULL OR v_term_end <= v_term_start
     OR p_period_index IS NULL OR p_period_index NOT BETWEEN 1 AND 12
     OR p_total_periods IS NULL OR p_total_periods <> 12 THEN
    RAISE EXCEPTION 'ANNUAL_GRANT_CURRENT_TERM_IDENTITY_INVALID';
  END IF;

  v_expected_period_start := (
    (v_term_start AT TIME ZONE 'UTC') + make_interval(months => p_period_index - 1)
  ) AT TIME ZONE 'UTC';
  v_expected_period_end := LEAST(
    CASE WHEN p_period_index = 12 THEN v_term_end
      ELSE (((v_term_start AT TIME ZONE 'UTC') + make_interval(months => p_period_index)) AT TIME ZONE 'UTC')
    END,
    v_term_end
  );
  v_expected_period_key := format(
    'annual:%s:%s',
    to_char(v_term_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    lpad(p_period_index::TEXT, 2, '0')
  );

  IF v_expected_period_start >= v_expected_period_end
     OR p_period_start IS NULL OR p_period_end IS NULL
     OR p_period_start IS DISTINCT FROM v_expected_period_start
     OR p_period_end IS DISTINCT FROM v_expected_period_end
     OR p_grant_period_key IS DISTINCT FROM v_expected_period_key THEN
    RAISE EXCEPTION 'ANNUAL_GRANT_STALE_OR_NONCANONICAL_PERIOD_INPUT';
  END IF;

  SELECT * INTO v_opening FROM subscription_credit_grants WHERE subscription_id=v_internal_subscription
    AND source_order_id=v_source.id AND grant_type='annual_monthly_release' AND period_index=1
    AND period_start=v_term_start AND status='granted' FOR SHARE;
  IF NOT FOUND OR v_opening.grant_snapshot IS DISTINCT FROM v_source.purchase_snapshot THEN
    RAISE EXCEPTION 'PAY_COMMON_ANNUAL_CONTRACT_UNKNOWN';
  END IF;
  v_yearly_credits:=(v_opening.grant_snapshot->>'credits')::integer;
  IF p_credits_granted IS DISTINCT FROM (v_yearly_credits/12
    +CASE WHEN p_period_index<=v_yearly_credits%12 THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'PAY_COMMON_GRANT_SNAPSHOT_MISMATCH';
  END IF;
  IF v_expected_period_start>v_now THEN RAISE EXCEPTION 'PAY_COMMON_ANNUAL_PERIOD_NOT_DUE'; END IF;

  -- Recheck both idempotency identities while the profile and subscription
  -- locks are held. The subscription-period unique index remains the final
  -- database constraint for any unexpected caller.
  SELECT g.id, g.credit_transaction_id, g.credits_granted, g.period_start, g.period_end,
         g.period_index, g.total_periods, g.grant_period_key, g.membership_plan_id
  INTO v_existing_grant_id, v_existing_grant_transaction_id, v_existing_grant_credits,
       v_existing_period_start, v_existing_period_end, v_existing_period_index,
       v_existing_total_periods, v_existing_period_key, v_existing_membership_plan_id
  FROM subscription_credit_grants AS g
  WHERE g.subscription_id = v_internal_subscription
    AND (g.idempotency_key = p_idempotency_key OR g.grant_period_key = p_grant_period_key)
  ORDER BY (g.idempotency_key = p_idempotency_key) DESC, g.created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing_membership_plan_id IS DISTINCT FROM v_term_membership_plan_id
       OR v_existing_period_index IS DISTINCT FROM p_period_index
       OR v_existing_total_periods IS DISTINCT FROM 12
       OR v_existing_period_start IS DISTINCT FROM v_expected_period_start
       OR v_existing_period_end IS DISTINCT FROM v_expected_period_end
       OR v_existing_period_key IS DISTINCT FROM v_expected_period_key THEN
      RAISE EXCEPTION 'ANNUAL_GRANT_EXISTING_REPLAY_ROW_NONCANONICAL';
    END IF;
    RETURN QUERY SELECT
      v_existing_grant_transaction_id,
      v_balance_before,
      v_balance_before,
      COALESCE(v_existing_grant_credits, 0),
      TRUE,
      FALSE,
      FALSE,
      v_existing_grant_id,
      COALESCE(v_existing_grant_credits, 0);
    RETURN;
  END IF;

  v_balance_after := v_balance_before + p_credits_granted;

  INSERT INTO credit_transactions (
    user_id,
    amount,
    type,
    description,
    idempotency_key,
    balance_before,
    balance_after,
    ledger_type,
    reason_code,
    counts_as_spend,
    source_type,
    source_id,
    source_order_id,
    grant_period_key,
    metadata
  ) VALUES (
    p_user_id,
    p_credits_granted,
    'addition',
    p_description,
    p_idempotency_key,
    v_balance_before,
    v_balance_after,
    'grant',
    'annual_monthly_release',
    FALSE,
    p_source_type,
    p_source_id,
    p_source_order_id,
    p_grant_period_key,
    COALESCE(p_metadata, '{}'::JSONB)
  )
  RETURNING id INTO v_transaction_id;

  UPDATE profiles
  SET credits = v_balance_after
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANNUAL_GRANT_PROFILE_UPDATE_MISS: %', p_user_id;
  END IF;

  INSERT INTO subscription_credit_grants (
    subscription_id,source_order_id,grant_snapshot,
    user_id,
    membership_plan_id,
    stripe_subscription_id,
    stripe_invoice_id,
    billing_cycle,
    grant_type,
    grant_period_key,
    period_start,
    period_end,
    period_index,
    total_periods,
    credits_granted,
    status,
    idempotency_key,
    credit_transaction_id,
    metadata,
    created_at,
    updated_at
  ) VALUES (
    v_internal_subscription,v_source.id,v_opening.grant_snapshot,
    p_user_id,
    p_membership_plan_id,
    p_stripe_subscription_id,
    p_stripe_invoice_id,
    'yearly',
    'annual_monthly_release',
    p_grant_period_key,
    p_period_start,
    p_period_end,
    p_period_index,
    p_total_periods,
    p_credits_granted,
    'granted',
    p_idempotency_key,
    v_transaction_id,
    COALESCE(p_grant_metadata, '{}'::JSONB),
    v_now,
    v_now
  )
  RETURNING id INTO v_grant_id;

  RETURN QUERY SELECT
    v_transaction_id,
    v_balance_before,
    v_balance_after,
    p_credits_granted,
    FALSE,
    TRUE,
    FALSE,
    v_grant_id,
    p_credits_granted;
END;
$function$;

-- Update only lifecycle facts; paid term/plan/grant authority belongs to invoice admission.
CREATE FUNCTION public.pay_common_sync_subscription(p_merchant_namespace text,p_payment_mode text,p_evidence jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE local_sub public.user_subscriptions; internal_id uuid; owner_id uuid; incoming_start timestamptz;
BEGIN
  SELECT s.id,s.user_id INTO internal_id,owner_id FROM user_subscriptions s JOIN payment_provider_refs r ON r.subscription_id=s.id
    WHERE r.channel='stripe' AND r.merchant_namespace=p_merchant_namespace AND r.mode=p_payment_mode
      AND r.object_type='subscription' AND r.external_id=p_evidence->>'id';
  IF NOT FOUND THEN RAISE EXCEPTION 'PAY_COMMON_SUBSCRIPTION_MAPPING_MISSING'; END IF;
  PERFORM 1 FROM profiles WHERE id=owner_id FOR UPDATE;
  SELECT * INTO local_sub FROM user_subscriptions WHERE id=internal_id FOR UPDATE;
  IF p_evidence->>'object' IS DISTINCT FROM 'subscription'
    OR p_evidence->>'livemode' IS DISTINCT FROM (p_payment_mode='live')::text
    OR p_evidence->>'user_id' IS DISTINCT FROM owner_id::text
    OR p_evidence->>'status' IS NULL OR p_evidence->>'status' NOT IN ('active','trialing','past_due','incomplete','incomplete_expired','unpaid','canceled','paused')
    OR p_evidence->>'cancel_at_period_end' NOT IN ('true','false')
    OR p_evidence->>'customer' IS DISTINCT FROM local_sub.stripe_customer_id THEN
    RAISE EXCEPTION 'PAY_COMMON_SUBSCRIPTION_RECEIPT_MISMATCH';
  END IF;
  incoming_start:=(p_evidence->>'period_start')::timestamptz;
  IF incoming_start IS NULL THEN RAISE EXCEPTION 'PAY_COMMON_SUBSCRIPTION_RECEIPT_MISMATCH'; END IF;
  IF local_sub.current_period_start IS NOT NULL AND incoming_start<local_sub.current_period_start THEN RETURN false; END IF;
  IF local_sub.status='canceled' AND p_evidence->>'status'<>'canceled' THEN RETURN false; END IF;
  UPDATE user_subscriptions SET status=p_evidence->>'status',cancel_at_period_end=p_evidence->>'cancel_at_period_end',
    updated_at=clock_timestamp() WHERE id=internal_id;
  IF p_evidence->>'status'='canceled' AND NOT EXISTS(SELECT 1 FROM user_subscriptions WHERE user_id=owner_id
    AND id<>internal_id AND status IN ('active','trialing','past_due','incomplete','unpaid')) THEN
    UPDATE profiles SET membership_level='free' WHERE id=owner_id;
  END IF;
  RETURN true;
END $fn$;
REVOKE ALL ON FUNCTION public.pay_common_sync_subscription(text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_common_sync_subscription(text,text,jsonb) TO service_role;

-- Upgrade attempts use the original order and mapped subscription, never a fabricated checkout ID.
ALTER TABLE payment_orders ADD COLUMN purchase_change_request jsonb;
CREATE TRIGGER pay_common_change_request_freeze BEFORE UPDATE ON payment_orders
  FOR EACH ROW EXECUTE FUNCTION pay_common_frozen_guard('purchase_change_request');
ALTER TABLE payment_orders DROP CONSTRAINT payment_orders_purchase_close_reason_check;
ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_purchase_close_reason_check CHECK(purchase_close_reason IN
  ('stripe_checkout_expired','stripe_checkout_never_created','stripe_upgrade_rejected','stripe_upgrade_not_applied'));
CREATE FUNCTION public.pay_common_prepare_change(p_user_id uuid,p_subscription_id uuid,p_plan_id uuid,p_cycle text,
  p_price_id text,p_request jsonb,p_metadata jsonb) RETURNS public.payment_orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE actor public.profiles; sub public.user_subscriptions; intent public.payment_orders; plan public.membership_plans;
  price public.payment_provider_refs; original public.payment_orders; sub_external text; amount integer; credits integer; bonus integer;
  snapshot jsonb; payload_hash text;
BEGIN
  SELECT * INTO actor FROM profiles WHERE id=p_user_id FOR UPDATE;
  IF NOT FOUND OR actor.membership_level NOT IN ('pro','gold') OR actor.status IS DISTINCT FROM 'active'
    OR actor.is_deleted IS DISTINCT FROM 'false' OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=p_user_id) THEN
    RAISE EXCEPTION 'PAY_COMMON_PURCHASE_ACTOR_DENIED';
  END IF;
  SELECT * INTO intent FROM payment_orders WHERE user_id=p_user_id AND subscription_id=p_subscription_id
    AND purchase_action='subscription_change' AND fulfilled_at IS NULL AND purchase_closed_at IS NULL FOR UPDATE;
  IF FOUND THEN RAISE EXCEPTION 'PAY_COMMON_PURCHASE_PENDING'; END IF;
  -- The profile lock serializes financial writers. Read the current paid term before
  -- locking its order, then lock the mirror: profile -> order -> subscription.
  -- Arrival time is not contract time: a late old invoice must never become the upgrade source.
  SELECT o.* INTO original FROM payment_orders o JOIN user_subscriptions s ON s.id=o.subscription_id
    WHERE o.user_id=p_user_id AND s.id=p_subscription_id AND o.fulfilled_at IS NOT NULL
      AND o.item_id=s.membership_plan_id AND o.billing_cycle=s.billing_cycle
      AND EXISTS(SELECT 1 FROM subscription_credit_grants g WHERE g.source_order_id=o.id
        AND g.subscription_id=s.id AND g.status='granted' AND g.period_start=s.current_period_start
        AND (g.billing_cycle='monthly' OR g.period_index=1))
    ORDER BY o.created_at DESC,o.id LIMIT 1 FOR UPDATE OF o;
  SELECT * INTO sub FROM user_subscriptions WHERE id=p_subscription_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR sub.payment_channel IS DISTINCT FROM 'stripe' OR sub.status IS DISTINCT FROM 'active'
    OR sub.cancel_at_period_end IS DISTINCT FROM 'false' OR sub.credit_release_terminated_at IS NOT NULL
    OR original.id IS NULL OR original.purchase_membership_level IS DISTINCT FROM actor.membership_level
    OR original.status IN ('refunded','partially_refunded') OR original.payment_status IS DISTINCT FROM 'paid' THEN
    RAISE EXCEPTION 'PAY_COMMON_MEMBERSHIP_FACTS_UNKNOWN';
  END IF;
  SELECT external_id INTO sub_external FROM payment_provider_refs WHERE subscription_id=sub.id AND object_type='subscription'
    AND channel=sub.payment_channel AND merchant_namespace=sub.merchant_namespace AND mode=sub.payment_mode;
  IF sub_external IS NULL THEN RAISE EXCEPTION 'PAY_COMMON_SUBSCRIPTION_MAPPING_MISSING'; END IF;
  SELECT * INTO plan FROM membership_plans WHERE id=p_plan_id AND level IN ('pro','gold') AND is_active='true' FOR SHARE;
  IF NOT FOUND OR p_cycle NOT IN ('monthly','yearly') THEN RAISE EXCEPTION 'PAY_COMMON_PRODUCT_UNAVAILABLE'; END IF;
  IF (original.billing_cycle='yearly' AND p_cycle<>'yearly')
    OR (original.purchase_membership_level='gold' AND plan.level<>'gold')
    OR (original.purchase_membership_level=plan.level AND original.billing_cycle=p_cycle)
    OR original.billing_cycle NOT IN ('monthly','yearly')
    OR (SELECT count(*) FROM user_subscriptions WHERE user_id=p_user_id
      AND status IN ('active','trialing','past_due','incomplete','unpaid'))<>1 THEN
    RAISE EXCEPTION 'PAY_COMMON_UPGRADE_NOT_ALLOWED';
  END IF;
  SELECT * INTO price FROM payment_provider_refs WHERE membership_plan_id=plan.id AND billing_cycle=p_cycle
    AND channel=sub.payment_channel AND merchant_namespace=sub.merchant_namespace AND mode=sub.payment_mode
    AND object_type='price' AND external_id=p_price_id AND is_current FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAY_COMMON_PRICE_MAPPING_MISSING'; END IF;
  amount:=CASE p_cycle WHEN 'monthly' THEN plan.monthly_price ELSE plan.yearly_price END;
  credits:=CASE p_cycle WHEN 'monthly' THEN plan.monthly_credits ELSE plan.yearly_credits END;
  bonus:=CASE p_cycle WHEN 'monthly' THEN coalesce(plan.monthly_bonus_credits,0) ELSE 0 END;
  IF p_request->'quote'->>'amountDue' IS DISTINCT FROM amount::text OR p_request->'quote'->>'currency' IS DISTINCT FROM 'usd'
    OR p_request->>'originalPrice' IS DISTINCT FROM (SELECT external_id FROM payment_provider_refs WHERE id=original.price_ref_id)
    OR p_request->'stripeMetadata'->>'userId' IS DISTINCT FROM p_user_id::text
    OR p_request->'stripeMetadata'->>'itemId' IS DISTINCT FROM plan.id::text
    OR p_request->'stripeMetadata'->>'priceId' IS DISTINCT FROM price.external_id
    OR p_request->'stripeMetadata'->>'billingCycle' IS DISTINCT FROM p_cycle
    OR jsonb_typeof(p_request) IS DISTINCT FROM 'object' OR octet_length(p_request::text)>8000 THEN
    RAISE EXCEPTION 'PAY_COMMON_UPGRADE_REQUEST_MISMATCH';
  END IF;
  snapshot:=jsonb_build_object('version',1,'item_type','membership_plan','item_id',plan.id,
    'item_updated_at',to_char(plan.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'billing_cycle',p_cycle,'currency','usd','unit','major','price',(amount::numeric/100)::numeric(18,2)::text,
    'discount','0.00','tax_behavior','unspecified','credits',credits,'bonus_credits',bonus);
  payload_hash:=encode(extensions.digest(concat_ws(':','subscription_change',sub.id,plan.id,p_cycle),'sha256'),'hex');
  INSERT INTO payment_orders(user_id,item_type,item_id,billing_cycle,amount_total,currency,mode,status,payment_status,
    payment_channel,merchant_namespace,payment_mode,purchase_request_id,purchase_payload_hash,purchase_snapshot,
    price_ref_id,purchase_action,purchase_membership_level,subscription_id,source_order_id,purchase_change_request,
    stripe_subscription_id,stripe_price_id,stripe_customer_id,metadata)
  VALUES(p_user_id,'membership_plan',plan.id,p_cycle,amount,'usd','subscription','pending','unpaid',
    sub.payment_channel,sub.merchant_namespace,sub.payment_mode,gen_random_uuid(),payload_hash,snapshot,
    price.id,'subscription_change',plan.level,sub.id,original.id,p_request,sub_external,price.external_id,sub.stripe_customer_id,
    p_metadata||jsonb_build_object('source','changeSubscriptionPlan','previousMembershipPlanId',sub.membership_plan_id,
      'previousBillingCycle',sub.billing_cycle,'productName',plan.name)) RETURNING * INTO intent;
  RETURN intent;
END $fn$;
REVOKE ALL ON FUNCTION public.pay_common_prepare_change(uuid,uuid,uuid,text,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_common_prepare_change(uuid,uuid,uuid,text,text,jsonb,jsonb) TO service_role;

-- Closure requires the adapter's verified explicit rejection or a fresh original-subscription inquiry.
CREATE FUNCTION public.pay_common_finish_change(p_order_id uuid,p_previous jsonb,p_next jsonb,p_outcome text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE intent public.payment_orders; owner_id uuid;
BEGIN
  SELECT user_id INTO owner_id FROM payment_orders WHERE id=p_order_id;
  PERFORM 1 FROM profiles WHERE id=owner_id FOR UPDATE;
  SELECT * INTO intent FROM payment_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND OR intent.purchase_action IS DISTINCT FROM 'subscription_change'
    OR intent.fulfilled_at IS NOT NULL OR intent.purchase_closed_at IS NOT NULL THEN RETURN false; END IF;
  IF intent.metadata IS DISTINCT FROM p_previous THEN RETURN false; END IF;
  IF p_outcome NOT IN ('release','stripe_upgrade_rejected','stripe_upgrade_not_applied') THEN
    RAISE EXCEPTION 'PAY_COMMON_UPGRADE_CLOSE_INVALID';
  END IF;
  UPDATE payment_orders SET metadata=p_next,
    purchase_closed_at=CASE WHEN p_outcome<>'release' THEN clock_timestamp() END,
    purchase_close_reason=CASE WHEN p_outcome<>'release' THEN p_outcome END,
    purchase_close_ref=CASE WHEN p_outcome<>'release' THEN (SELECT external_id FROM payment_provider_refs
      WHERE subscription_id=intent.subscription_id AND object_type='subscription' AND channel=intent.payment_channel
        AND merchant_namespace=intent.merchant_namespace AND mode=intent.payment_mode) END,
    status=CASE WHEN p_outcome<>'release' THEN 'failed' ELSE status END,updated_at=clock_timestamp()
    WHERE id=intent.id;
  RETURN true;
END $fn$;
REVOKE ALL ON FUNCTION public.pay_common_finish_change(uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_common_finish_change(uuid,jsonb,jsonb,text) TO service_role;

-- An unpaid invoice is a financial observation, never permission to release the purchase identity.
CREATE FUNCTION public.pay_common_record_failed_invoice(p_source_order_id uuid,p_merchant_namespace text,p_payment_mode text,p_evidence jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE source public.payment_orders; target public.payment_orders; owner_id uuid; price_id text; invoice_id text:=p_evidence->>'id';
BEGIN
  SELECT user_id INTO owner_id FROM payment_orders WHERE id=p_source_order_id;
  PERFORM 1 FROM profiles WHERE id=owner_id FOR UPDATE;
  SELECT * INTO source FROM payment_orders WHERE id=p_source_order_id FOR UPDATE;
  SELECT external_id INTO price_id FROM payment_provider_refs WHERE id=source.price_ref_id AND object_type='price'
    AND channel='stripe' AND merchant_namespace=p_merchant_namespace AND mode=p_payment_mode;
  IF source.id IS NULL OR source.payment_channel IS DISTINCT FROM 'stripe'
    OR source.merchant_namespace IS DISTINCT FROM p_merchant_namespace OR source.payment_mode IS DISTINCT FROM p_payment_mode
    OR invoice_id IS NULL OR invoice_id !~ '^in_[A-Za-z0-9_]+$' OR price_id IS NULL
    OR p_evidence->>'object' IS DISTINCT FROM 'invoice' OR p_evidence->>'user_id' IS DISTINCT FROM source.user_id::text
    OR p_evidence->>'livemode' IS DISTINCT FROM (p_payment_mode='live')::text
    OR p_evidence->>'price_id' IS DISTINCT FROM price_id OR p_evidence->>'currency' IS DISTINCT FROM source.currency
    OR p_evidence->>'amount_due' IS DISTINCT FROM source.amount_total::text
    OR p_evidence->>'status' IS NULL OR p_evidence->>'status' NOT IN ('open','void','uncollectible') THEN
    RAISE EXCEPTION 'PAY_COMMON_INVOICE_RECEIPT_MISMATCH';
  END IF;
  IF source.subscription_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payment_provider_refs
    WHERE subscription_id=source.subscription_id AND object_type='subscription' AND external_id=p_evidence->>'subscription_id'
      AND channel='stripe' AND merchant_namespace=p_merchant_namespace AND mode=p_payment_mode) THEN
    RAISE EXCEPTION 'PAY_COMMON_SUBSCRIPTION_MAPPING_MISSING';
  END IF;
  SELECT o.* INTO target FROM payment_orders o JOIN payment_provider_refs r ON r.order_id=o.id
    WHERE r.channel='stripe' AND r.merchant_namespace=p_merchant_namespace AND r.mode=p_payment_mode
      AND r.object_type='invoice' AND r.external_id=invoice_id FOR UPDATE OF o;
  IF FOUND THEN
    IF target.user_id IS DISTINCT FROM source.user_id OR target.purchase_snapshot IS DISTINCT FROM source.purchase_snapshot THEN
      RAISE EXCEPTION 'PAY_COMMON_INVOICE_SOURCE_MISMATCH';
    END IF;
    IF target.fulfilled_at IS NOT NULL OR target.payment_status IN ('paid','refunded','partially_refunded') THEN RETURN target.id; END IF;
  ELSE
    IF source.fulfilled_at IS NULL AND source.purchase_action IN ('checkout','subscription_change') THEN target:=source;
    ELSE
      INSERT INTO payment_orders(user_id,item_type,item_id,billing_cycle,amount_total,currency,mode,status,payment_status,
        payment_channel,merchant_namespace,payment_mode,purchase_request_id,purchase_payload_hash,purchase_snapshot,
        price_ref_id,purchase_action,purchase_membership_level,source_order_id,subscription_id)
      VALUES(source.user_id,source.item_type,source.item_id,source.billing_cycle,source.amount_total,source.currency,source.mode,'failed',
        p_evidence->>'status','stripe',p_merchant_namespace,p_payment_mode,gen_random_uuid(),
        encode(extensions.digest('invoice:'||invoice_id,'sha256'),'hex'),source.purchase_snapshot,
        source.price_ref_id,'renewal',source.purchase_membership_level,source.id,source.subscription_id) RETURNING * INTO target;
    END IF;
    IF EXISTS(SELECT 1 FROM payment_provider_refs WHERE order_id=target.id AND object_type='invoice' AND external_id<>invoice_id) THEN
      RAISE EXCEPTION 'PAY_COMMON_INVOICE_SOURCE_MISMATCH';
    END IF;
    INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
      VALUES('stripe',p_merchant_namespace,p_payment_mode,'invoice',invoice_id,target.id);
  END IF;
  UPDATE payment_orders SET stripe_invoice_id=invoice_id,stripe_price_id=price_id,
    stripe_subscription_id=CASE WHEN target.subscription_id IS NOT NULL THEN (SELECT external_id FROM payment_provider_refs
      WHERE subscription_id=target.subscription_id AND object_type='subscription' AND channel='stripe'
        AND merchant_namespace=p_merchant_namespace AND mode=p_payment_mode) END,
    status='failed',payment_status=p_evidence->>'status',
    metadata=metadata||jsonb_build_object('invoiceFailure',jsonb_build_object('invoiceId',invoice_id,'status',p_evidence->>'status')),
    updated_at=clock_timestamp() WHERE id=target.id;
  RETURN target.id;
END $fn$;
REVOKE ALL ON FUNCTION public.pay_common_record_failed_invoice(uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_common_record_failed_invoice(uuid,text,text,jsonb) TO service_role;

-- Compatibility IDs are outputs of owner-executed financial/catalog transactions.
-- A service client may not independently assign them through ordinary table writes.
CREATE FUNCTION public.pay_common_derived_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
DECLARE key text; previous jsonb:=CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
BEGIN
  IF current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID)) THEN RETURN NEW; END IF;
  FOREACH key IN ARRAY TG_ARGV LOOP
    IF coalesce(to_jsonb(NEW)->key,'null'::jsonb) IS DISTINCT FROM coalesce(previous->key,'null'::jsonb) THEN
      RAISE EXCEPTION 'PAY_COMMON_DERIVED_COLUMN_WRITE_DENIED' USING ERRCODE='42501';
    END IF;
  END LOOP;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.pay_common_derived_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER pay_common_order_derived BEFORE INSERT OR UPDATE ON payment_orders FOR EACH ROW
  EXECUTE FUNCTION pay_common_derived_guard('stripe_checkout_session_id','stripe_invoice_id','stripe_subscription_id','stripe_price_id','stripe_customer_id');
CREATE TRIGGER pay_common_subscription_derived BEFORE INSERT OR UPDATE ON user_subscriptions FOR EACH ROW
  EXECUTE FUNCTION pay_common_derived_guard('stripe_subscription_id','stripe_price_id','stripe_customer_id');
CREATE TRIGGER pay_common_grant_derived BEFORE INSERT OR UPDATE ON subscription_credit_grants FOR EACH ROW
  EXECUTE FUNCTION pay_common_derived_guard('stripe_subscription_id','stripe_invoice_id');
CREATE TRIGGER pay_common_package_derived BEFORE INSERT OR UPDATE ON credit_packages FOR EACH ROW
  EXECUTE FUNCTION pay_common_derived_guard('stripe_price_id');
CREATE TRIGGER pay_common_plan_derived BEFORE INSERT OR UPDATE ON membership_plans FOR EACH ROW
  EXECUTE FUNCTION pay_common_derived_guard('stripe_monthly_price_id','stripe_yearly_price_id');

CREATE FUNCTION public.pay_common_conflict_append_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
DECLARE prior jsonb:=OLD.metadata->'paymentConflicts'; incoming jsonb:=NEW.metadata->'paymentConflicts';
BEGIN
  IF incoming IS NOT NULL AND (jsonb_typeof(incoming)<>'array' OR jsonb_array_length(incoming)>32) THEN
    RAISE EXCEPTION 'PAY_COMMON_CONFLICT_LIMIT';
  END IF;
  IF prior IS NOT NULL AND (incoming IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(prior) WITH ORDINALITY t(v,n)
    WHERE v IS DISTINCT FROM incoming->(n::integer-1))) THEN RAISE EXCEPTION 'PAY_COMMON_CONFLICT_APPEND_ONLY'; END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.pay_common_conflict_append_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER pay_common_conflict_append BEFORE UPDATE ON payment_orders FOR EACH ROW
  EXECUTE FUNCTION pay_common_conflict_append_guard();

END $migration$;
COMMIT;
