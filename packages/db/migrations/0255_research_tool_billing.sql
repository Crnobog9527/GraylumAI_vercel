-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- RESEARCH-TOOLS RT-2: third-party search / social-data calls on the BILL-PAYG v2 path
-- (docs/launch/implementation/RESEARCH_TOOLS_PLAN.md §3).
--
-- A tool call is an ordinary bill2_calls row on the same run as the model calls, so the run still
-- rounds once over models + tools. It is marked by protocol 'research-tool-v1' and carries a frozen
-- price (toolPricing) instead of a token quote:
--   * claim: bill2_payg_validate_tool_quote replaces the token quote check for these calls only;
--     U = maxUnitsPerCall × frozen price (rounded up), hold H = min(ceil(U·q·m), available) as before.
--     The start threshold L keeps its existing lookup (model = route id, purpose = phase).
--   * record: bill2_record_tool validates the single host result for the call and stores a
--     content-free projection; user settlement and supplier cost are kept apart:
--       delivered + official usage → user pays usage × frozen price; supplier cost confirmed;
--       delivered without usage, unknown (timeout) → user pays 0, hold released, settled at once;
--         supplier cost stays pending with the per-call bound recorded (Owner 2026-10-13 decision 9.2 A);
--       failed and documented as free → 0 / 0; failed but chargeable (HTTP 200 wrapping an upstream
--         error) → user 0, the platform records and absorbs the frozen cost.
--   * finalize: tool calls settle from that result; a dispatched call with no result waits until its
--     recovery deadline (or account erasure) and then settles as unknown. Zero-charge tool outcomes
--     take the existing refund path, so they write no consumption row.
--   * bill2_tool_cost_reconcile: an admin records the confirmed supplier cost of a pending call later.
-- Model calls are unchanged: every patch branches on the tool protocol and leaves the model path as is.
--
-- Compatibility: no existing call uses the new protocol; old code never sends it. Every function patch
-- is anchored, marked and skipped when already applied, so the migration can run twice.
-- Recovery: no data rewrite. To roll back, stop issuing tool calls, settle or reconcile pending ones,
-- then restore the previous function bodies from 0180 / 0234–0236 / 0166 via pg_get_functiondef history.
BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE public.bill2_calls ADD COLUMN IF NOT EXISTS call_kind text NOT NULL DEFAULT 'model';
ALTER TABLE public.bill2_calls ADD COLUMN IF NOT EXISTS supplier_cost_state text;
ALTER TABLE public.bill2_calls ADD COLUMN IF NOT EXISTS supplier_cost_bound_usd numeric;
ALTER TABLE public.bill2_calls ADD COLUMN IF NOT EXISTS supplier_cost_reconciled_at timestamptz;
ALTER TABLE public.bill2_calls ADD COLUMN IF NOT EXISTS supplier_cost_reconciled_by uuid;
-- The frozen price entry hash, kept outside the payload: erasure strips toolPricing from the payload, but a
-- metering review of a blocked route still needs it (bill2_payg_metering_review_snapshot / review_metering).
ALTER TABLE public.bill2_calls ADD COLUMN IF NOT EXISTS tool_price_entry_hash text;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='bill2_calls_tool_cost_check') THEN
    ALTER TABLE public.bill2_calls ADD CONSTRAINT bill2_calls_tool_cost_check CHECK (
      call_kind IN ('model','tool')
      AND (supplier_cost_state IS NULL OR (call_kind='tool' AND supplier_cost_state IN ('pending','confirmed')))
      AND (supplier_cost_state IS DISTINCT FROM 'pending' OR (selected_cost_usd IS NULL AND supplier_cost_bound_usd>0))
      AND (supplier_cost_state IS DISTINCT FROM 'confirmed' OR selected_cost_usd>=0)
      AND ((supplier_cost_reconciled_at IS NULL)=(supplier_cost_reconciled_by IS NULL))
      AND ((call_kind='tool')=(tool_price_entry_hash IS NOT NULL))
      AND (tool_price_entry_hash IS NULL OR tool_price_entry_hash ~ '^[a-f0-9]{64}$'));
  END IF;
END $$;

-- The kind and the price entry hash follow the frozen payload at insert and never change (erasure rewrites the
-- payload later).
CREATE OR REPLACE FUNCTION public.bill2_calls_kind_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.call_kind:=CASE WHEN NEW.payload->>'protocol'='research-tool-v1' THEN 'tool' ELSE 'model' END;
    NEW.tool_price_entry_hash:=CASE WHEN NEW.call_kind='tool' THEN NEW.payload#>>'{toolPricing,entryHash}' END;
  ELSIF NEW.call_kind IS DISTINCT FROM OLD.call_kind OR NEW.tool_price_entry_hash IS DISTINCT FROM OLD.tool_price_entry_hash THEN
    RAISE EXCEPTION 'BILL2_CALL_KIND_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bill2_calls_kind_guard ON public.bill2_calls;
CREATE TRIGGER bill2_calls_kind_guard BEFORE INSERT OR UPDATE OF call_kind,tool_price_entry_hash ON public.bill2_calls
  FOR EACH ROW EXECUTE FUNCTION public.bill2_calls_kind_guard();

-- USD for `units` of a frozen price, in the BILL2 12-decimal unit; the same exact arithmetic as
-- providerUsageCostUsd (billingProviderPrices.ts): rounded up for the bound, down for actual cost.
CREATE OR REPLACE FUNCTION public.bill2_tool_cost(pricing jsonb, units text, up boolean) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE d text:='^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$';s numeric:=1000000000000;num numeric;den numeric;q numeric;
BEGIN
  IF units IS NULL OR units !~ d OR jsonb_typeof(pricing->'price') IS DISTINCT FROM 'string' OR pricing->>'price' !~ d
   OR jsonb_typeof(pricing->'unitsPerPrice') IS DISTINCT FROM 'string' OR pricing->>'unitsPerPrice' !~ '^[1-9][0-9]{0,8}$'
   OR jsonb_typeof(pricing->'currency') IS DISTINCT FROM 'string' OR pricing->>'currency' !~ '^[A-Z]{3}$'
   OR (pricing->>'currency'='USD') IS DISTINCT FROM (jsonb_typeof(pricing->'usdPerCurrency')='null')
   OR (pricing->>'currency'<>'USD' AND (jsonb_typeof(pricing->'usdPerCurrency') IS DISTINCT FROM 'string'
     OR pricing->>'usdPerCurrency' !~ d OR pricing->>'usdPerCurrency' !~ '[1-9]'))
  THEN RAISE EXCEPTION 'BILL2_TOOL_PRICE_INVALID';END IF;
  num:=(units::numeric*s)*((pricing->>'price')::numeric*s)
    *CASE WHEN pricing->>'currency'='USD' THEN s ELSE (pricing->>'usdPerCurrency')::numeric*s END;
  den:=s*s*(pricing->>'unitsPerPrice')::numeric;
  q:=div(num+CASE WHEN up THEN den-1 ELSE 0 END,den);
  IF q>=s*s THEN RAISE EXCEPTION 'BILL2_TOOL_PRICE_INVALID';END IF;
  RETURN q/s;
END $$;

-- A tool route is not an ai_models row, but every financial projection (erasure included) types
-- modelId as a UUID. A tool policy's modelId is therefore this fixed UUID of its route id.
CREATE OR REPLACE FUNCTION public.bill2_tool_model_id(route text) RETURNS uuid
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT md5('bill2-research-tool:'||route)::uuid
$$;

CREATE OR REPLACE FUNCTION public.bill2_payg_zero_source(source text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT coalesce(source IN ('confirmed_failure','tool_no_usage','tool_failed','tool_failed_charged','tool_unknown'),false)
$$;

-- Claim-time check for a tool call; the frozen run policy must carry exactly this price.
CREATE OR REPLACE FUNCTION public.bill2_payg_validate_tool_quote(r bill2_runs, p jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE stable jsonb;pricing jsonb:=p->'toolPricing';u numeric;k text;
BEGIN
  IF p-ARRAY['provider','account','model','protocol','phase','requestHash','automaticRetry','hiddenTools',
    'lookupSupported','upperUsd','billingUnit','toolPricing','runtimeEpoch']<>'{}'::jsonb
   OR p->>'protocol' IS DISTINCT FROM 'research-tool-v1'
   OR coalesce(p->>'provider','') NOT IN ('tikhub','parallel','firecrawl')
   OR coalesce(length(p->>'account'),0) NOT BETWEEN 1 AND 120 OR coalesce(length(p->>'model'),0) NOT BETWEEN 1 AND 160
   OR coalesce(p->>'phase','')='' OR coalesce(p->>'requestHash','') !~ '^[a-f0-9]{64}$'
   OR p->'automaticRetry' IS DISTINCT FROM 'false'::jsonb OR p->'hiddenTools' IS DISTINCT FROM 'false'::jsonb
   OR p->'lookupSupported' IS DISTINCT FROM 'false'::jsonb
   OR jsonb_typeof(p->'billingUnit') IS DISTINCT FROM 'object' OR p->'billingUnit'->>'modelId' IS DISTINCT FROM bill2_tool_model_id(p->>'model')::text
   OR jsonb_typeof(pricing) IS DISTINCT FROM 'object'
   OR pricing-ARRAY['unit','currency','price','unitsPerPrice','usdPerCurrency','entryHash','validUntil','maxUnitsPerCall']<>'{}'::jsonb
  THEN RAISE EXCEPTION 'BILL2_TOOL_QUOTE_INVALID';END IF;
  FOREACH k IN ARRAY ARRAY['unit','currency','price','unitsPerPrice','usdPerCurrency','entryHash','validUntil','maxUnitsPerCall'] LOOP
    IF NOT pricing ? k THEN RAISE EXCEPTION 'BILL2_TOOL_QUOTE_INVALID';END IF;
  END LOOP;
  IF coalesce(pricing->>'unit','') NOT IN ('call','sku_search','credit')
   OR coalesce(pricing->>'entryHash','') !~ '^[a-f0-9]{64}$'
   OR coalesce(pricing->>'maxUnitsPerCall','') !~ '^[1-9][0-9]{0,5}$'
   OR jsonb_typeof(pricing->'validUntil') IS DISTINCT FROM 'string'
  THEN RAISE EXCEPTION 'BILL2_TOOL_QUOTE_INVALID';END IF;
  -- Plan §3.1: a search price must carry an expiry; an expired one cannot start a new charge.
  IF (pricing->>'validUntil')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'BILL2_TOOL_PRICE_EXPIRED';END IF;
  SELECT x INTO stable FROM jsonb_array_elements(r.payload->'callPolicy') x WHERE
    x->>'protocol'='research-tool-v1' AND x->>'provider'=p->>'provider' AND x->>'account'=p->>'account'
    AND x->>'model'=p->>'model' AND x->>'modelId'=p->'billingUnit'->>'modelId'
    AND x->'multiplier'=p->'billingUnit'->'multiplier' AND x->'lookupSupported'=p->'lookupSupported'
    AND x->'toolPricing'=pricing;
  IF stable IS NULL OR NOT coalesce(stable->'purposes' ? (p->>'phase'),false) THEN RAISE EXCEPTION 'BILL2_TOOL_QUOTE_INVALID';END IF;
  u:=bill2_tool_cost(pricing,pricing->>'maxUnitsPerCall',true);
  IF u<=0 OR u IS DISTINCT FROM bill2_decimal(p->'upperUsd') OR u>bill2_decimal(stable->'upperUsd')
   OR bill2_decimal(r.payload->'rules'->'billingUnit'->'creditsPerUsd') IS DISTINCT FROM r.credits_per_usd
   OR bill2_unit_multiplier(p->'billingUnit'->'multiplier')>r.multiplier THEN RAISE EXCEPTION 'BILL2_PAYG_BOUND_MISMATCH';END IF;
END $$;

-- Plan §3.3: a route that keeps returning results without official usage (or unknown results) is stopped.
-- After 5 pending-cost results on one route within an hour (counting only those after the
-- route's latest metering review), the call is flagged metering_missing: bill2_payg_claim then refuses new
-- calls on the route until an admin reviews it (bill2_payg_review_metering).
CREATE OR REPLACE FUNCTION public.bill2_tool_pending_guard(p_call_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE c bill2_calls;
BEGIN
  SELECT * INTO c FROM bill2_calls WHERE id=p_call_id;
  IF c.call_kind<>'tool' OR c.supplier_cost_state IS DISTINCT FROM 'pending' THEN RETURN;END IF;
  IF (SELECT count(*) FROM bill2_calls x WHERE x.call_kind='tool' AND x.model=c.model
      -- Counted by when the call became pending (its settlement; this call is not settled yet), not by when it
      -- was created: a call settled as unknown at its recovery deadline may be up to a day old.
      AND x.supplier_cost_state='pending' AND coalesce(x.settled_at,clock_timestamp())>clock_timestamp()-interval '1 hour'
      AND coalesce(x.settled_at,clock_timestamp())>coalesce((SELECT max(l.created_at) FROM user_activity_logs l
        WHERE l.action='bill2_metering_review' AND l.details->>'model'=c.model),'-infinity'::timestamptz))>=5
  THEN UPDATE bill2_calls SET metering_missing=true WHERE id=c.id;END IF;
END $$;

-- The host writes exactly one result per tool call. Called from bill2_record after its locks,
-- ownership, dispatch and duplicate checks; never callable directly.
CREATE OR REPLACE FUNCTION public.bill2_record_tool(r bill2_runs, c bill2_calls, e jsonb, h text, erasing boolean) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE pricing jsonb:=c.payload->'toolPricing';outcome text:=e->>'toolOutcome';units text;cost numeric;
 stored jsonb;cost_state text;
BEGIN
  IF jsonb_typeof(e->'usage') IS DISTINCT FROM 'object' OR jsonb_typeof(pricing) IS DISTINCT FROM 'object'
   OR e-ARRAY['provider','account','protocol','model','providerId','source','sourceHash','observedAt','coverage',
     'final','currency','cost','usage','evidenceKind','toolOutcome','httpStatus']<>'{}'::jsonb
   OR (e->'usage')-ARRAY['unit','units']<>'{}'::jsonb
   OR e->>'evidenceKind' IS DISTINCT FROM 'tool_result' OR e->>'providerId' IS DISTINCT FROM c.id::text
   OR e->>'model' IS DISTINCT FROM c.model OR e->>'source' IS DISTINCT FROM 'response'
   OR e->>'coverage' IS DISTINCT FROM 'request_total' OR e->'final' IS DISTINCT FROM 'true'::jsonb
   OR e->>'currency' IS DISTINCT FROM 'USD' OR e->'usage'->>'unit' IS DISTINCT FROM pricing->>'unit'
   OR coalesce(jsonb_typeof(e->'usage'->'units'),'missing') NOT IN ('string','null')
   OR coalesce(jsonb_typeof(e->'cost'),'missing') NOT IN ('string','null')
   OR (e ? 'httpStatus' AND (jsonb_typeof(e->'httpStatus') IS DISTINCT FROM 'number' OR e->>'httpStatus' !~ '^[1-5][0-9]{2}$'))
   OR coalesce(outcome,'') NOT IN ('delivered','failed_free','failed_charged','unknown')
  THEN RAISE EXCEPTION 'BILL2_UNTRUSTED_RECEIPT';END IF;
  PERFORM (e->>'observedAt')::timestamptz;
  -- One result per call. A call already reconciled by an admin keeps that confirmed cost: a result that
  -- arrives later is refused rather than overwriting it. A late result for a call settled as unknown (no
  -- reconciliation yet) may still confirm the supplier cost; the user settlement never changes.
  IF EXISTS(SELECT 1 FROM bill2_receipts WHERE call_id=c.id) OR c.supplier_cost_reconciled_at IS NOT NULL
  THEN RAISE EXCEPTION 'BILL2_TOOL_RECEIPT_CONFLICT';END IF;
  units:=e->'usage'->>'units';
  IF e->>'cost' IS NOT NULL THEN cost:=bill2_decimal(e->'cost');END IF;
  IF outcome='delivered' AND units IS NOT NULL THEN
    IF cost IS DISTINCT FROM bill2_tool_cost(pricing,units,false) THEN RAISE EXCEPTION 'BILL2_UNTRUSTED_RECEIPT';END IF;
    cost_state:='confirmed';
  ELSIF outcome='failed_free' THEN
    IF coalesce(units,'0')<>'0' OR cost IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'BILL2_UNTRUSTED_RECEIPT';END IF;
    cost_state:='confirmed';
  ELSIF outcome='failed_charged' THEN
    IF units IS NULL OR cost IS DISTINCT FROM bill2_tool_cost(pricing,units,false) THEN RAISE EXCEPTION 'BILL2_UNTRUSTED_RECEIPT';END IF;
    cost_state:='confirmed';
  ELSE -- delivered without official usage, or unknown: the supplier cost is not known.
    IF units IS NOT NULL OR cost IS NOT NULL THEN RAISE EXCEPTION 'BILL2_UNTRUSTED_RECEIPT';END IF;
    cost_state:='pending';
  END IF;
  stored:=jsonb_build_object('provider',c.provider,'account',c.account_namespace,'protocol','research-tool-v1',
    'model',c.model,'providerId',c.id::text,'source','response','sourceHash',e->>'sourceHash',
    'observedAt',(e->>'observedAt')::timestamptz,'coverage','request_total','final',true,'currency','USD',
    'cost',CASE WHEN cost IS NULL THEN NULL ELSE e->'cost' END,'usage',jsonb_build_object('unit',pricing->>'unit','units',units),
    'evidenceKind','tool_result','toolOutcome',outcome,'httpStatus',e->'httpStatus');
  IF coalesce(e->>'sourceHash','') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'BILL2_UNTRUSTED_RECEIPT';END IF;
  INSERT INTO bill2_receipts(call_id,payload,payload_hash,conflict,financial_projection_hash,financial_projection_version,financial_projected_at)
  VALUES(c.id,stored,h,false,encode(sha256(convert_to(stored::text,'utf8')),'hex'),1,clock_timestamp());
  INSERT INTO bill2_provider_ids VALUES(c.provider,c.account_namespace,c.id::text,c.id) ON CONFLICT DO NOTHING;
  -- Usage above the frozen bound is recorded as is and blocks the route until reviewed (plan §3.5).
  UPDATE bill2_calls SET provider_id=c.id::text,selected_cost_usd=cost,supplier_cost_state=cost_state,
    supplier_cost_bound_usd=CASE WHEN cost_state='pending' THEN c.upper_usd END,
    state=CASE WHEN cost_state='pending' THEN 'unknown' ELSE 'responded' END,
    -- Usage above the frozen unit limit fails the route closed even when rounding keeps the USD within the bound.
    budget_conflict=budget_conflict OR coalesce(cost>c.upper_usd,false)
      OR coalesce(units::numeric>(pricing->>'maxUnitsPerCall')::numeric,false)
  WHERE id=c.id;
  PERFORM bill2_tool_pending_guard(c.id);
  IF r.state IN ('settled','refunded') THEN
    UPDATE bill2_runs SET provider_cost_usd=(SELECT CASE WHEN count(*) FILTER(WHERE dispatched_at IS NOT NULL AND selected_cost_usd IS NULL)=0
      THEN coalesce(sum(selected_cost_usd),0) END FROM bill2_calls WHERE run_id=r.id),version=version+1 WHERE id=r.id;
  ELSE UPDATE bill2_runs SET state='cost_pending',version=version+1 WHERE id=r.id;END IF;
  PERFORM bill2_payg_finalize(r.actor_id,r.id);
  SELECT * INTO r FROM bill2_runs WHERE id=r.id;
  RETURN bill2_erasure_view(r,erasing);
END $$;

-- Finalize helper: {nominal, source} for a dispatched tool call, or NULL to keep waiting.
-- The user nominal equals the confirmed usage cost; every other outcome is 0 for the user.
CREATE OR REPLACE FUNCTION public.bill2_payg_tool_settlement(r bill2_runs, c bill2_calls, erasing boolean) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE e jsonb;
BEGIN
  IF r.conflict THEN RETURN NULL;END IF;
  SELECT payload INTO e FROM bill2_receipts WHERE call_id=c.id AND NOT conflict AND payload->>'evidenceKind'='tool_result'
    ORDER BY created_at,id LIMIT 1;
  IF e IS NULL THEN
    -- No host result (crash after dispatch): wait for it until the recovery deadline or account erasure,
    -- then settle as unknown so the user's hold is never kept beyond that.
    IF NOT erasing AND clock_timestamp()<coalesce(c.recovery_deadline,c.created_at+interval '24 hours') THEN RETURN NULL;END IF;
    UPDATE bill2_calls SET supplier_cost_state='pending',supplier_cost_bound_usd=upper_usd,state='unknown' WHERE id=c.id;
    PERFORM bill2_tool_pending_guard(c.id);
    RETURN jsonb_build_object('nominal','0','source','tool_unknown');
  END IF;
  RETURN CASE
    WHEN e->>'toolOutcome'='delivered' AND e->>'cost' IS NOT NULL THEN jsonb_build_object('nominal',e->>'cost','source','tool_usage')
    WHEN e->>'toolOutcome'='delivered' THEN jsonb_build_object('nominal','0','source','tool_no_usage')
    WHEN e->>'toolOutcome'='failed_free' THEN jsonb_build_object('nominal','0','source','tool_failed')
    WHEN e->>'toolOutcome'='failed_charged' THEN jsonb_build_object('nominal','0','source','tool_failed_charged')
    ELSE jsonb_build_object('nominal','0','source','tool_unknown') END;
END $$;

-- Confirmed supplier cost for a pending tool call, found later by reconciliation (plan §3.4). The user
-- settlement never changes; only the platform-side cost is filled in.
CREATE OR REPLACE FUNCTION public.bill2_tool_cost_reconcile(p_admin_id uuid, p_call_id uuid, p_cost text, p_evidence_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c bill2_calls;r bill2_runs;cost numeric;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_admin_id AND role='admin' AND status='active' AND is_deleted::text='false')
  THEN RAISE EXCEPTION 'BILL2_TOOL_RECONCILE_DENIED' USING ERRCODE='42501';END IF;
  IF coalesce(p_cost,'') !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$' OR coalesce(p_evidence_hash,'') !~ '^[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'BILL2_TOOL_RECONCILE_INVALID';END IF;
  SELECT * INTO c FROM bill2_calls WHERE id=p_call_id;
  IF c.id IS NULL OR c.call_kind<>'tool' THEN RAISE EXCEPTION 'BILL2_TOOL_RECONCILE_INVALID';END IF;
  SELECT * INTO r FROM bill2_runs WHERE id=c.run_id FOR UPDATE;
  -- Same order as claim/record/finalize: run, then the route locks, then the call. A concurrent claim on the
  -- route therefore sees the budget_conflict this may set instead of the old unflagged row.
  PERFORM bill2_payg_lock_models(r);
  SELECT * INTO c FROM bill2_calls WHERE id=p_call_id FOR UPDATE;
  cost:=p_cost::numeric;
  -- A replay must repeat both the amount and the evidence the audit row recorded.
  IF c.supplier_cost_state='confirmed' AND c.supplier_cost_reconciled_at IS NOT NULL AND c.selected_cost_usd=cost
   AND EXISTS(SELECT 1 FROM user_activity_logs l WHERE l.action='bill2_tool_cost_reconcile'
     AND l.details->>'callId'=c.id::text AND l.details->>'evidenceHash'=p_evidence_hash) THEN
    RETURN jsonb_build_object('callId',c.id,'costUsd',c.selected_cost_usd::text,'replayed',true);END IF;
  IF c.supplier_cost_state IS DISTINCT FROM 'pending' OR c.settled_at IS NULL THEN RAISE EXCEPTION 'BILL2_TOOL_RECONCILE_INVALID';END IF;
  -- A confirmed cost above the frozen bound fails the route closed until an admin review (plan §3.5),
  -- exactly like overuse reported at record time.
  UPDATE bill2_calls SET selected_cost_usd=cost,supplier_cost_state='confirmed',
    supplier_cost_reconciled_at=clock_timestamp(),supplier_cost_reconciled_by=p_admin_id,
    budget_conflict=budget_conflict OR cost>c.supplier_cost_bound_usd WHERE id=c.id;
  UPDATE bill2_runs SET provider_cost_usd=(SELECT CASE WHEN count(*) FILTER(WHERE dispatched_at IS NOT NULL AND selected_cost_usd IS NULL)=0
    THEN coalesce(sum(selected_cost_usd),0) END FROM bill2_calls WHERE run_id=r.id),version=version+1 WHERE id=r.id;
  INSERT INTO user_activity_logs(admin_id,action,action_type,details)
  VALUES(p_admin_id,'bill2_tool_cost_reconcile','admin',jsonb_build_object('callId',c.id,'runId',r.id,
    'provider',c.provider,'route',c.model,'costUsd',cost::text,'boundUsd',c.supplier_cost_bound_usd::text,
    'aboveBound',cost>c.supplier_cost_bound_usd,'evidenceHash',p_evidence_hash));
  RETURN jsonb_build_object('callId',c.id,'costUsd',cost::text,'replayed',false);
END $$;

-- Claim: tool calls use the tool quote check; model calls keep the token quote check.
DO $$ DECLARE src text;a text:=$x$ PERFORM bill2_payg_validate_quote(r,p);$x$; BEGIN
  src:=pg_get_functiondef('public.bill2_payg_claim(uuid,uuid,integer,jsonb)'::regprocedure);
  IF position('-- 0255 tool quote' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'RESEARCH_TOOL_BILLING_SOURCE_MISMATCH: bill2_payg_claim';END IF;
    EXECUTE replace(src,a,$x$ -- 0255 tool quote
 IF p->>'protocol'='research-tool-v1' THEN PERFORM bill2_payg_validate_tool_quote(r,p);
 ELSE PERFORM bill2_payg_validate_quote(r,p);END IF;$x$);
  END IF;
END $$;

-- Record: a tool result goes to bill2_record_tool after the shared locks and duplicate check.
DO $$ DECLARE src text;a text:=$x$ IF EXISTS(SELECT 1 FROM bill2_receipts WHERE call_id=c.id AND payload_hash=h) THEN RETURN bill2_erasure_view(r,erasing);END IF;$x$; BEGIN
  src:=pg_get_functiondef('public.bill2_record(uuid,uuid,uuid,jsonb)'::regprocedure);
  IF position('-- 0255 tool result' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'RESEARCH_TOOL_BILLING_SOURCE_MISMATCH: bill2_record';END IF;
    EXECUTE replace(src,a,a||$x$
 -- 0255 tool result
 IF c.payload->>'protocol'='research-tool-v1' THEN RETURN bill2_record_tool(r,c,p_evidence,h,erasing);END IF;$x$);
  END IF;
END $$;

-- Finalize: tool calls settle from their result; zero-charge tool outcomes take the refund path;
-- a charged tool call is described as a lookup, not a model call.
DO $$ DECLARE src text;d text;w text;z1 text;z2 text;t text;b text; BEGIN
  src:=pg_get_functiondef('public.bill2_payg_finalize(uuid,uuid)'::regprocedure);
  IF position('-- 0255 tool settlement' IN src)=0 THEN
    d:=$x$DECLARE r bill2_runs;c bill2_calls;$x$;
    w:=$x$   IF r.conflict OR c.selected_cost_usd IS NULL THEN EXIT;END IF;
   IF n IS NULL THEN
    IF c.recovery_attempts<3 AND clock_timestamp()<coalesce(c.recovery_deadline,c.created_at+interval '24 hours')
     AND c.payload->>'lookupSupported'='true' AND c.provider_id IS NOT NULL THEN EXIT;END IF;
    n:=least(c.selected_cost_usd,c.upper_usd);source:='actual_fallback';
    UPDATE bill2_calls SET metering_missing=true WHERE id=c.id;
   END IF;$x$;
    z1:=$x$  IF c.dispatched_at IS NULL OR source='confirmed_failure' THEN$x$;
    z2:=$x$  IF c.dispatched_at IS NOT NULL AND source<>'confirmed_failure' THEN$x$;
    t:=$x$'consumption','AI call consumption',$x$;
    b:=$x$budget_conflict=budget_conflict OR n>upper_usd OR selected_cost_usd>upper_usd$x$;
    IF array_length(string_to_array(src,d),1)<>2 OR array_length(string_to_array(src,w),1)<>2
     OR array_length(string_to_array(src,z1),1)<>2 OR array_length(string_to_array(src,z2),1)<>2
     OR array_length(string_to_array(src,t),1)<>2 OR array_length(string_to_array(src,b),1)<>2 THEN
      RAISE EXCEPTION 'RESEARCH_TOOL_BILLING_SOURCE_MISMATCH: bill2_payg_finalize';END IF;
    src:=replace(src,d,d||'tool jsonb;');
    src:=replace(src,w,$x$   -- 0255 tool settlement
   IF c.payload->>'protocol'='research-tool-v1' THEN
    tool:=bill2_payg_tool_settlement(r,c,erasing);
    IF tool IS NULL THEN EXIT;END IF;
    n:=bill2_decimal(tool->'nominal');source:=tool->>'source';
   ELSE
$x$||w||$x$
   END IF;$x$);
    src:=replace(src,z1,$x$  IF c.dispatched_at IS NULL OR bill2_payg_zero_source(source) THEN$x$);
    src:=replace(src,z2,$x$  IF c.dispatched_at IS NOT NULL AND NOT bill2_payg_zero_source(source) THEN$x$);
    src:=replace(src,t,$x$'consumption',CASE WHEN c.payload->>'protocol'='research-tool-v1'
     THEN 'Web search / social data lookup' ELSE 'AI call consumption' END,$x$);
    -- A tool call whose supplier cost is still pending has no selected cost to compare.
    src:=replace(src,b,$x$budget_conflict=budget_conflict OR n>upper_usd OR coalesce(selected_cost_usd>upper_usd,false)$x$);
    EXECUTE src;
  END IF;
END $$;

-- Metering review: a tool call has no token profile; its review names the tool protocol and the frozen
-- price entry hash, so a route stopped by overuse or repeated pending costs can be reviewed and reopened.
DO $$ DECLARE src text;a text:=$x$  OR c.payload#>>'{payg,profileVersion}' IS DISTINCT FROM p_review->>'profileVersion'
  OR c.payload#>>'{payg,evidenceVersion}' IS DISTINCT FROM p_review->>'evidenceVersion'$x$; BEGIN
  src:=pg_get_functiondef('public.bill2_payg_review_metering(uuid,uuid,uuid,jsonb)'::regprocedure);
  IF position('-- 0255 tool review' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'RESEARCH_TOOL_BILLING_SOURCE_MISMATCH: bill2_payg_review_metering';END IF;
    EXECUTE replace(src,a,$x$  -- 0255 tool review
  -- (Parenthesised: inside an IF condition PL/pgSQL would otherwise end the condition at CASE's THEN.)
  OR (CASE WHEN c.call_kind='tool' THEN 'research-tool-v1' ELSE c.payload#>>'{payg,profileVersion}' END) IS DISTINCT FROM p_review->>'profileVersion'
  OR (CASE WHEN c.call_kind='tool' THEN c.tool_price_entry_hash ELSE c.payload#>>'{payg,evidenceVersion}' END) IS DISTINCT FROM p_review->>'evidenceVersion'$x$);
  END IF;
END $$;

-- The admin page first reads this snapshot to get the evidence hash and versions; tool calls answer with the
-- same mapping as the review above (protocol name and frozen price entry hash).
DO $$ DECLARE src text;p text:=$x$c.payload#>>'{payg,profileVersion}'$x$;e text:=$x$c.payload#>>'{payg,evidenceVersion}'$x$; BEGIN
  src:=pg_get_functiondef('public.bill2_payg_metering_review_snapshot(uuid,uuid)'::regprocedure);
  IF position('-- 0255 tool snapshot' IN src)=0 THEN
    IF array_length(string_to_array(src,p),1)<>3 OR array_length(string_to_array(src,e),1)<>3 THEN
      RAISE EXCEPTION 'RESEARCH_TOOL_BILLING_SOURCE_MISMATCH: bill2_payg_metering_review_snapshot';END IF;
    src:=replace(src,p,$x$(CASE WHEN c.call_kind='tool' THEN 'research-tool-v1' ELSE c.payload#>>'{payg,profileVersion}' END)$x$);
    src:=replace(src,e,$x$(CASE WHEN c.call_kind='tool' THEN c.tool_price_entry_hash ELSE c.payload#>>'{payg,evidenceVersion}' END)$x$);
    EXECUTE replace(src,'DECLARE c bill2_calls;',E'DECLARE c bill2_calls; -- 0255 tool snapshot\n');
  END IF;
END $$;

-- Run creation: a tool route is not an ai_models row. Its frozen policy is checked for shape here;
-- price, bound and purpose are checked again on every claim (bill2_payg_validate_tool_quote).
DO $$ DECLARE src text;a text:=$x$  PERFORM id FROM ai_models WHERE id=(entry->>'modelId')::uuid AND model_id=entry->>'model'$x$; BEGIN
  src:=pg_get_functiondef('public.runtime_direct_billing_allowed_before_opc(uuid,jsonb,uuid)'::regprocedure);
  IF position('-- 0255 tool policies' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'RESEARCH_TOOL_BILLING_SOURCE_MISMATCH: runtime_direct_billing_allowed_before_opc';END IF;
    EXECUTE replace(src,a,$x$  -- 0255 tool policies
  IF entry->>'protocol'='research-tool-v1' THEN
   IF p->>'contractVersion' IS DISTINCT FROM 'bill2.v2'
    OR coalesce(entry->>'provider','') NOT IN ('tikhub','parallel','firecrawl') OR coalesce(length(entry->>'account'),0)=0
    OR coalesce(length(entry->>'model'),0)=0 OR entry->>'modelId' IS DISTINCT FROM bill2_tool_model_id(entry->>'model')::text
    OR bill2_decimal(entry->'upperUsd')<=0 OR entry->'lookupSupported' IS DISTINCT FROM 'false'::jsonb
    OR jsonb_typeof(entry->'toolPricing') IS DISTINCT FROM 'object' OR jsonb_typeof(entry->'purposes') IS DISTINCT FROM 'array'
    OR entry->>'modelId'=p->>'modelId' THEN RAISE EXCEPTION 'BILL2_CALL_POLICY_DENIED';END IF;
   CONTINUE;
  END IF;
$x$||a);
  END IF;
END $$;

-- Account erasure keeps ledger metadata by an exact shape; the settlement source names of tool calls
-- are part of it (both enum occurrences: call settlement and compensation).
DO $$ DECLARE src text;a text:=$x$"$enum": ["nominal", "not_dispatched", "confirmed_failure", "actual_fallback"]$x$; BEGIN
  src:=pg_get_functiondef('public.erasure_ledger_metadata(jsonb)'::regprocedure);
  IF position('"tool_usage"' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>3 THEN RAISE EXCEPTION 'RESEARCH_TOOL_BILLING_SOURCE_MISMATCH: erasure_ledger_metadata';END IF;
    EXECUTE replace(src,a,$x$"$enum": ["nominal", "not_dispatched", "confirmed_failure", "actual_fallback",
    "tool_usage", "tool_no_usage", "tool_failed", "tool_failed_charged", "tool_unknown"]$x$);
  END IF;
END $$;

-- staging test windows: an approved tool route may sit in the window's policy list like a model.
DO $$ DECLARE src text;a text:=$x$  IF entry->>'protocol' IS DISTINCT FROM 'openrouter-chat-v1' OR entry->>'provider' IS DISTINCT FROM 'openrouter'$x$; BEGIN
  src:=pg_get_functiondef('public.runtime_test_window_allowed(uuid,jsonb)'::regprocedure);
  IF position('-- 0255 tool routes' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'RESEARCH_TOOL_BILLING_SOURCE_MISMATCH: runtime_test_window_allowed';END IF;
    EXECUTE replace(src,a,$x$  -- 0255 tool routes
  IF NOT coalesce((entry->>'protocol'='openrouter-chat-v1' AND entry->>'provider'='openrouter')
    OR (entry->>'protocol'='research-tool-v1' AND entry->>'provider' IN ('tikhub','parallel','firecrawl')),false)$x$);
  END IF;
END $$;

-- Automatic recovery inventory: a tool call has no lookup, so a closed run whose dispatched tool call never
-- got a result was never listed (the closed branch waits for every cost). Once that call's recovery deadline
-- has passed, list the run so the recovery worker finishes it and the hold is released as tool_unknown.
DO $$ DECLARE src text;a text:=$x$ OR count(*)>0 OR (r.closed AND$x$; BEGIN
  src:=pg_get_functiondef('public.runtime_pending_financial_batch(uuid,integer)'::regprocedure);
  IF position('-- 0255 expired tool calls' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'RESEARCH_TOOL_BILLING_SOURCE_MISMATCH: runtime_pending_financial_batch';END IF;
    EXECUTE replace(src,a,$x$ OR count(*)>0 -- 0255 expired tool calls
    OR (r.closed AND r.contract_version='bill2.v2' AND (e.state IN ('cost_pending','cancelled') OR e.result IS NOT NULL)
     AND EXISTS(SELECT 1 FROM bill2_calls tool_call WHERE tool_call.run_id=r.id AND tool_call.call_kind='tool'
      AND tool_call.dispatched_at IS NOT NULL AND tool_call.settled_at IS NULL
      AND clock_timestamp()>=coalesce(tool_call.recovery_deadline,tool_call.created_at+interval '24 hours')))
    OR (r.closed AND$x$);
  END IF;
END $$;

-- Finance report: same rows and order as 0162, plus the call kind and the supplier cost state/bound so
-- pending tool costs are reported apart from confirmed ones (plan §3.4). A new return type needs DROP.
DROP FUNCTION IF EXISTS public.bill2_admin_call_report(timestamptz,timestamptz,integer);
CREATE FUNCTION public.bill2_admin_call_report(p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer)
 RETURNS TABLE(call_id uuid, run_id uuid, call_sequence integer, created_at timestamp with time zone, provider text, model text, call_state text, selected_cost_usd text, run_state text, run_outcome text, credits_per_usd text, run_multiplier text, run_charged integer, run_actual_restore integer, run_call_count integer, call_multiplier text, multiplier_source text, purpose text,contract_version text,settled_at timestamptz,nominal_cost_usd text,nominal_source text,charged_delta integer,theoretical_delta text,platform_absorbed_cap_credits text,platform_absorbed_bound_credits text,platform_absorbed_cap_usd text,platform_absorbed_bound_usd text,platform_margin_usd text,platform_margin_cache_read_usd text,platform_margin_cache_write_usd text,platform_margin_other_usd text,compensation_credits integer,compensated_at timestamptz,
  call_kind text,supplier_cost_state text,supplier_cost_bound_usd text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT c.id, c.run_id, c.sequence, c.created_at,
         c.provider, c.model, c.state, c.selected_cost_usd::text,
         r.state, r.outcome, r.credits_per_usd::text, r.multiplier::text,
         r.charged, r.actual_restore, (SELECT count(*)::integer FROM bill2_calls x WHERE x.run_id = r.id),
         c.payload #>> '{billingUnit,multiplier}', c.payload #>> '{billingUnit,source}',
         coalesce(c.payload->>'phase',r.payload #>> '{purposeBudget,purpose}'),r.contract_version,c.settled_at,c.nominal_cost_usd::text,c.nominal_source,c.charged_delta,c.theoretical_delta::text,c.platform_absorbed_cap_credits::text,c.platform_absorbed_bound_credits::text,CASE WHEN r.contract_version='bill2.v2' THEN (c.platform_absorbed_cap_credits/(r.credits_per_usd*bill2_unit_multiplier(c.payload->'billingUnit'->'multiplier')))::text END,CASE WHEN r.contract_version='bill2.v2' THEN (c.platform_absorbed_bound_credits/(r.credits_per_usd*bill2_unit_multiplier(c.payload->'billingUnit'->'multiplier')))::text END,(c.nominal_cost_usd-c.selected_cost_usd)::text,c.platform_margin_cache_read_usd::text,c.platform_margin_cache_write_usd::text,c.platform_margin_other_usd::text,c.compensation_credits,c.compensated_at,
         c.call_kind,c.supplier_cost_state,c.supplier_cost_bound_usd::text
  FROM bill2_calls c
  JOIN bill2_runs r ON r.id = c.run_id
  WHERE p_from IS NOT NULL AND p_to IS NOT NULL AND p_from < p_to
    AND c.created_at >= p_from AND c.created_at < p_to
  ORDER BY c.created_at, c.id
  LIMIT LEAST(GREATEST(coalesce(p_limit, 1), 1), 5000)
$function$;
REVOKE ALL ON FUNCTION public.bill2_admin_call_report(timestamptz,timestamptz,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bill2_admin_call_report(timestamptz,timestamptz,integer) TO service_role;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['bill2_calls_kind_guard()','bill2_tool_cost(jsonb,text,boolean)','bill2_tool_model_id(text)','bill2_payg_zero_source(text)',
    'bill2_payg_validate_tool_quote(bill2_runs,jsonb)','bill2_record_tool(bill2_runs,bill2_calls,jsonb,text,boolean)',
    'bill2_payg_tool_settlement(bill2_runs,bill2_calls,boolean)','bill2_tool_cost_reconcile(uuid,uuid,text,text)',
    'bill2_tool_pending_guard(uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role',f);
  END LOOP;
  GRANT EXECUTE ON FUNCTION public.bill2_tool_cost_reconcile(uuid,uuid,text,text) TO service_role;
END $$;
COMMIT;
