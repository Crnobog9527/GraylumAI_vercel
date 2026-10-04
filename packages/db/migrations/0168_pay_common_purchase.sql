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
SELECT md5(string_agg(k || '=' || coalesce(d, '<null>'), E'\n' ORDER BY k)) INTO actual FROM grouped WHERE g ~ '^[^:]+:(payment_orders|user_subscriptions|subscription_credit_grants|payment_provider_refs|credit_packages|membership_plans)$' OR g ~ '^fn(acl)?:pay_common_';

  IF actual = 'bc1a60ac4431e011b9cb817106b1831c' THEN RETURN; END IF;
  IF actual IS DISTINCT FROM 'fd9c49ffe937cc029cd083295efbdc1f' THEN
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
  ADD COLUMN IF NOT EXISTS price_ref_id uuid REFERENCES public.payment_provider_refs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS purchase_action text CHECK(purchase_action IN ('checkout','subscription_change','renewal')),
  ADD COLUMN IF NOT EXISTS purchase_closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS purchase_close_reason text CHECK(purchase_close_reason='stripe_checkout_expired'),
  ADD COLUMN IF NOT EXISTS purchase_close_ref text;
DROP TRIGGER IF EXISTS pay_common_purchase_freeze ON public.payment_orders;
CREATE TRIGGER pay_common_purchase_freeze BEFORE UPDATE ON public.payment_orders FOR EACH ROW
  EXECUTE FUNCTION public.pay_common_frozen_guard('price_ref_id','purchase_action',
    'purchase_closed_at','purchase_close_reason','purchase_close_ref');

-- New protected fields are written only by bounded SECURITY DEFINER payment operations.
-- Preserve service_role's pre-existing column permissions for all other order fields.
DO $acl$
DECLARE verb text; cols text;
BEGIN
  FOREACH verb IN ARRAY ARRAY['INSERT','UPDATE'] LOOP
    SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO cols
      FROM pg_attribute WHERE attrelid='public.payment_orders'::regclass AND attnum>0 AND NOT attisdropped
      AND attname NOT IN ('price_ref_id','purchase_action','purchase_closed_at','purchase_close_reason','purchase_close_ref');
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
    AND o.status NOT IN ('refunded','partially_refunded')) THEN
    RAISE EXCEPTION 'PAY_COMMON_LEGACY_ORDER_UNRESOLVED' USING ERRCODE='23514';
  END IF;
  request_hash:=encode(extensions.digest(
    concat_ws(':',p_item_type,p_item_id::text,p_billing_cycle),'sha256'),'hex');
  -- One unresolved action per subject. A browser cancellation or local timeout never retires it.
  SELECT * INTO intent FROM public.payment_orders o WHERE o.user_id=p_user_id
    AND o.payment_channel='stripe' AND o.item_type=p_item_type
    AND o.purchase_action='checkout'
    AND o.purchase_closed_at IS NULL
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
    purchase_request_id,purchase_payload_hash,purchase_snapshot,price_ref_id,purchase_action,metadata)
  VALUES(p_user_id,p_item_type,p_item_id,p_billing_cycle,final_cents,'usd',
    CASE p_item_type WHEN 'membership_plan' THEN 'subscription' ELSE 'payment' END,
    'pending','unpaid','stripe',p_merchant_namespace,p_payment_mode,
    gen_random_uuid(),request_hash,snapshot,mapped.id,'checkout',
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
DECLARE intent public.payment_orders;
BEGIN
  IF p_checkout_status IS DISTINCT FROM 'expired' OR p_payment_status IS DISTINCT FROM 'unpaid' THEN
    RAISE EXCEPTION 'PAY_COMMON_ATTEMPT_NOT_TERMINAL' USING ERRCODE='23514';
  END IF;
  -- Lock order shared with admission and fulfillment: profile before order.
  PERFORM 1 FROM public.profiles WHERE id=p_user_id FOR UPDATE;
  SELECT * INTO intent FROM public.payment_orders WHERE id=p_order_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR intent.payment_channel IS DISTINCT FROM 'stripe'
    OR intent.merchant_namespace IS DISTINCT FROM p_merchant_namespace
    OR intent.payment_mode IS DISTINCT FROM p_payment_mode OR intent.purchase_action IS DISTINCT FROM 'checkout'
    OR NOT EXISTS(SELECT 1 FROM public.payment_provider_refs r WHERE r.order_id=intent.id
      AND r.channel='stripe' AND r.merchant_namespace=p_merchant_namespace AND r.mode=p_payment_mode
      AND r.object_type='checkout' AND r.external_id=p_session_id) THEN
    RAISE EXCEPTION 'PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH' USING ERRCODE='23514';
  END IF;
  IF intent.fulfilled_at IS NOT NULL OR intent.payment_status IN ('paid','refunded','partially_refunded')
    OR intent.status IN ('completed','refunded','partially_refunded') THEN
    RAISE EXCEPTION 'PAY_COMMON_ATTEMPT_ALREADY_PAID' USING ERRCODE='23514';
  END IF;
  IF intent.purchase_closed_at IS NOT NULL THEN
    IF intent.purchase_close_ref IS DISTINCT FROM p_session_id THEN
      RAISE EXCEPTION 'PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH' USING ERRCODE='23514';
    END IF;
    RETURN false;
  END IF;
  UPDATE public.payment_orders SET purchase_closed_at=clock_timestamp(),
    purchase_close_reason='stripe_checkout_expired',purchase_close_ref=p_session_id,
    status='expired',updated_at=clock_timestamp() WHERE id=intent.id;
  RETURN true;
END $fn$;
REVOKE ALL ON FUNCTION public.pay_common_close_checkout(uuid,uuid,text,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pay_common_close_checkout(uuid,uuid,text,text,text,text,text) TO service_role;
END $migration$;
COMMIT;
