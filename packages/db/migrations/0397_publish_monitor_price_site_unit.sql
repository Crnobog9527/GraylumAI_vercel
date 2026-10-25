-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- MAINT-P6 (placeholder number 0397; the controller assigns the final one when merging).
-- Owner 2026-10-25: "发布监测的积分换算跟全站设置走". One-click publishing kept its own copy of q and m inside
-- system_settings.publish_monitor_publish_price; a site-wide change of billing_credits_per_usd / billing_token_price_multiplier
-- would never reach it. After this migration the price row holds only {"usdPerTarget": ...}, and publish_monitor_publish_price()
-- reads q and m from the two site-wide rows (BILL-UNIT) and still returns the same {usdPerTarget, multiplier, creditsPerUsd}
-- object, so the job price stored at claim time, publish_monitor_publish_credits and every caller are unchanged.
--   * Fail closed: a missing or malformed site-wide row raises PUBLISH_MONITOR_PRICE_NOT_CONFIGURED, exactly as before for a bad price row.
--   * Jobs already claimed keep the price frozen in social_publish_jobs.price; nothing about them changes.
--   * The function stays STABLE and only reads (no row locks), so PostgREST's read-only transaction is fine.
-- Compatibility: older application code reads the price row expecting all three keys and then shows no hold number on the
--   publish page (charging is decided in SQL and is unaffected); deploy the new code first, then apply this migration.
-- Repeatable: CREATE OR REPLACE plus an UPDATE that is a no-op once the row has only usdPerTarget.
-- Recovery: restore the 0274 body of publish_monitor_publish_price() and set the row back to
--   {"usdPerTarget":"0.01","multiplier":"6","creditsPerUsd":"100"}.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.publish_monitor_publish_price() RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE p jsonb;q text;m text;d text:='^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$';
 qd text:='^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$'; -- same format as the site-wide q (parseCreditsPerUsd)
BEGIN
 SELECT value INTO p FROM system_settings WHERE key='publish_monitor_publish_price';
 SELECT value #>> '{}' INTO q FROM system_settings WHERE key='billing_credits_per_usd';
 SELECT value #>> '{}' INTO m FROM system_settings WHERE key='billing_token_price_multiplier';
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p-ARRAY['usdPerTarget']<>'{}'::jsonb
  OR coalesce(p->>'usdPerTarget','') !~ d OR coalesce(m,'') !~ d OR coalesce(q,'') !~ qd
  OR (p->>'usdPerTarget')::numeric<=0 OR m::numeric<=0 OR q::numeric<=0 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_PRICE_NOT_CONFIGURED' USING ERRCODE='22023';
 END IF;
 RETURN jsonb_build_object('usdPerTarget',p->>'usdPerTarget','multiplier',m,'creditsPerUsd',q);
END $$;

UPDATE public.system_settings SET value=jsonb_build_object('usdPerTarget',value->'usdPerTarget')
 WHERE key='publish_monitor_publish_price' AND jsonb_typeof(value)='object' AND value ? 'usdPerTarget'
  AND value-ARRAY['usdPerTarget']<>'{}'::jsonb;

COMMIT;
