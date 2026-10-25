-- RESEARCH price refresh (#1294 follow-up): the daily refresh re-reads TikHub's prices, and on staging the test window's
-- frozen TikHub tool policies must carry the same price, expiry and entry hash or every research call is refused once the
-- old expiry passes. The job read and wrote runtime_test_windows directly, but service_role has no grant on that table,
-- so the window step always failed (2026-10-25 04:00 UTC: window "failed", policies left at the 10-30 expiry).
-- This function is the only new entry point. It touches one test window's TikHub research-tool policies and nothing
-- else, and takes no price from the caller: price, units, currency, expiry and the entry hash come from
-- billing_provider_prices as stored (the hash is providerEntryHash: sha256 of JSON.stringify of the entry's [key, value]
-- pairs in key order; the price schema is strict, so the stored keys are exactly the hashed ones), and upperUsd is
-- bill2_tool_cost of that price, as toolCallPolicy computes it. A route without exactly one chargeable, unexpired,
-- per-call exact entry, or with its own price multiplier, is left as it is and reported.
-- Only adds a function; no table, data or table grant changes. Repeatable (CREATE OR REPLACE).
-- Rollback: DROP FUNCTION IF EXISTS public.research_test_window_sync_prices(uuid); and deploy the code before this PR
-- (the window step then fails as before; windows are refreshed by hand, ~/.graylum/controller-tools/window-refresh-1025).
CREATE OR REPLACE FUNCTION public.research_test_window_sync_prices(p_window uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE old jsonb; raw jsonb; prices jsonb; next jsonb:='[]'::jsonb; policy jsonb; entry jsonb; pricing jsonb;
  route text; matches int; valid_until text; upper numeric; synced int:=0; skipped jsonb:='[]'::jsonb;
BEGIN
  SELECT call_policies INTO old FROM runtime_test_windows WHERE id=p_window FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','not_found','synced',0,'skipped','[]'::jsonb); END IF;
  SELECT value INTO raw FROM system_settings WHERE key='billing_provider_prices';
  IF jsonb_typeof(raw) IS DISTINCT FROM 'string' OR jsonb_typeof(old) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('status','invalid','synced',0,'skipped','[]'::jsonb);
  END IF;
  prices:=(raw #>> '{}')::jsonb;
  IF jsonb_typeof(prices->'entries') IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('status','invalid','synced',0,'skipped','[]'::jsonb);
  END IF;
  FOR policy IN SELECT p FROM jsonb_array_elements(old) WITH ORDINALITY AS t(p, i) ORDER BY i LOOP
    IF policy->>'provider'='tikhub' AND policy->>'protocol'='research-tool-v1' AND left(policy->>'model',7)='tikhub:'
     AND jsonb_typeof(policy->'toolPricing')='object' THEN
      route:=substr(policy->>'model',8);
      SELECT count(*), (array_agg(e))[1] INTO matches, entry FROM jsonb_array_elements(prices->'entries') e
        WHERE e->>'provider'='tikhub' AND e->>'route'=route;
      valid_until:=CASE WHEN entry->>'fxValidUntil' IS NOT NULL
        AND (entry->>'fxValidUntil')::timestamptz<(entry->>'validUntil')::timestamptz
        THEN entry->>'fxValidUntil' ELSE entry->>'validUntil' END;
      IF matches<>1 THEN skipped:=skipped||jsonb_build_object('route',route,'reason','PRICE_UNKNOWN');
      ELSIF entry->'includedInReceipt'<>'false'::jsonb OR entry->>'usageUnit' IS DISTINCT FROM 'call' THEN
        skipped:=skipped||jsonb_build_object('route',route,'reason','PRICE_NOT_CHARGEABLE');
      ELSIF entry->>'priceMultiplier' IS NOT NULL THEN
        skipped:=skipped||jsonb_build_object('route',route,'reason','PRICE_MULTIPLIER');
      ELSIF valid_until IS NULL OR valid_until::timestamptz<=clock_timestamp()
       OR (entry->>'verifiedAt')::timestamptz>clock_timestamp() THEN
        skipped:=skipped||jsonb_build_object('route',route,'reason','PRICE_EXPIRED');
      ELSE
        pricing:=policy->'toolPricing'||jsonb_build_object('unit','call','currency',entry->'currency','price',entry->'price',
          'unitsPerPrice',entry->'unitsPerPrice','usdPerCurrency',entry->'usdPerCurrency','validUntil',valid_until,
          'entryHash',(SELECT encode(sha256(convert_to('['||string_agg(format('[%s,%s]',to_jsonb(k)::text,v::text),','
            ORDER BY k COLLATE "C")||']','UTF8')),'hex') FROM jsonb_each(entry) AS kv(k, v)));
        upper:=bill2_tool_cost(pricing,pricing->>'maxUnitsPerCall',true);
        IF upper IS NULL OR upper<=0 THEN skipped:=skipped||jsonb_build_object('route',route,'reason','PRICE_BOUND_INVALID');
        ELSE
          policy:=policy||jsonb_build_object('toolPricing',pricing,'upperUsd',trim_scale(upper)::text);
          synced:=synced+1;
        END IF;
      END IF;
    END IF;
    next:=next||jsonb_build_array(policy);
  END LOOP;
  IF next=old THEN RETURN jsonb_build_object('status','unchanged','synced',synced,'skipped',skipped); END IF;
  UPDATE runtime_test_windows SET call_policies=next WHERE id=p_window;
  RETURN jsonb_build_object('status','updated','synced',synced,'skipped',skipped);
END $$;
REVOKE ALL ON FUNCTION public.research_test_window_sync_prices(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.research_test_window_sync_prices(uuid) TO service_role;
