/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- FUSION-FIXED-PRICE. Number allocated by the controller. Owner 2026-10-17: "评审团固定价：暂定每次 1500 积分，
-- 只给 Gold，支持第 2 轮，失败全额退回，超出成本平台承担". Replaces per-call user charging of a review.
--
-- * Start: fusion_review_start holds the fixed price (system_settings fusion_settings.review.fixedPriceCredits,
--   default 1500) with the existing pre-deduction primitive, in the same transaction that creates the review.
--   The available balance must also cover the largest per-step temporary call hold the host computed
--   (config.fixedPrice.holdCredits), so a started review never waits for credits. Refused: FUSION_REVIEW_CREDITS.
-- * Calls: every model call keeps its own run, its own full hold and settlement (0234 unchanged), but a run of a
--   group marked with a fee review settles at zero user charge: its nominal cost, would-be charge
--   (theoretical_delta) and real provider cost stay recorded, the platform absorbs the would-be charge
--   (nominal_source 'fixed_fee'), and the hold is fully released.
-- * End: completed with a usable revision (outcome kind 'revised') charges the fixed price once; incomplete,
--   revision_failed and completed without a revision refund it in full; a user stop or end of a paused review pays
--   the would-be charge of its settled calls (the existing stop rule), capped at the fixed price, once every call of
--   the review has settled; deleting the review (draft/conversation deletion, account erasure) refunds it in full.
-- * The ledger uses the existing reservation reason codes (bill2_reserve / bill2_release / bill2_spend) with
--   source_id = review id, so refund evidence, reconciliation and the ledger sum treat it like any call hold.
-- New table reason: the fee must survive deletion of the review row (financial record), like bill2 runs do.
-- Compatibility: reviews started before this migration have no fee row and keep per-call billing; every new start
-- must carry the fixed price. Repeatable: each patch is anchored and skipped once applied.
-- Recovery: stop starting reviews (switch off), settle held fees (fusion_review_fee_settle_due), then restore the
-- previous function bodies from 0234–0236/0255/0256; fee rows and ledger rows stay as the record.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE IF NOT EXISTS public.fusion_review_fees (
  review_id uuid CONSTRAINT fusion_review_fees_pk PRIMARY KEY,
  actor_id uuid NOT NULL CONSTRAINT fusion_review_fees_actor_ref REFERENCES public.profiles(id),
  credits integer NOT NULL CHECK (credits > 0),
  pre_deduct_id uuid NOT NULL CONSTRAINT fusion_review_fees_pre_deduct_unique UNIQUE,
  state text NOT NULL CHECK (state IN ('held','charged','refunded')),
  charged_credits integer,
  settle_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT fusion_review_fees_settlement CHECK (
    (state='held' AND settled_at IS NULL AND charged_credits IS NULL AND settle_reason IS NULL)
    OR (state='charged' AND settled_at IS NOT NULL AND charged_credits BETWEEN 1 AND credits AND settle_reason IS NOT NULL)
    OR (state='refunded' AND settled_at IS NOT NULL AND charged_credits=0 AND settle_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS fusion_review_fees_held_idx ON public.fusion_review_fees(actor_id) WHERE state='held';
ALTER TABLE public.fusion_review_fees ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fusion_review_fees FROM PUBLIC, anon, authenticated, service_role;

-- "只给 Gold" (Owner 2026-10-17): the plan switch 0153 defaulted to every paid level; Pro is turned off here (staging
-- had it on). Administrators still manage the switch per plan afterwards; re-running this only re-applies the decision.
UPDATE public.membership_plans SET allow_fusion_review=false WHERE level='pro' AND allow_fusion_review;

ALTER TABLE public.fusion_billing_groups ADD COLUMN IF NOT EXISTS fee_review_id uuid;
CREATE INDEX IF NOT EXISTS fusion_billing_groups_fee_idx ON public.fusion_billing_groups(fee_review_id) WHERE fee_review_id IS NOT NULL;

-- The fee marker is set once, before any member run has a call, and never changes: finalize reads it.
CREATE OR REPLACE FUNCTION public.fusion_group_fee_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.fee_review_id IS DISTINCT FROM OLD.fee_review_id THEN
    IF OLD.fee_review_id IS NOT NULL OR EXISTS (SELECT 1 FROM bill2_runs r JOIN bill2_calls c ON c.run_id=r.id
      WHERE r.fusion_group_id=NEW.id) THEN RAISE EXCEPTION 'FUSION_GROUP_IMMUTABLE'; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.fusion_group_fee_guard() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS fusion_group_fee_guard ON public.fusion_billing_groups;
CREATE TRIGGER fusion_group_fee_guard BEFORE UPDATE OF fee_review_id ON public.fusion_billing_groups
  FOR EACH ROW EXECUTE FUNCTION public.fusion_group_fee_guard();

-- Balance usable for a new hold, as bill2_payg_claim computes it (the caller holds the profile row lock).
CREATE OR REPLACE FUNCTION public.fusion_review_available(a uuid, balance integer) RETURNS integer
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE quarantine bigint;
BEGIN
  PERFORM id FROM subscription_credit_grants WHERE user_id=a ORDER BY id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM subscription_credit_grants WHERE user_id=a AND accounting_state<>'trusted') THEN
    RAISE EXCEPTION 'PRE_DEDUCT_GRANT_ACCOUNTING_REVIEW_REQUIRED'; END IF;
  SELECT coalesce(sum(greatest(g.credits_granted-g.consumed_amount,0)),0) INTO quarantine
  FROM subscription_credit_grants g WHERE g.user_id=a AND g.status='granted' AND g.accounting_state='trusted'
  AND EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=a AND s.stripe_subscription_id=g.stripe_subscription_id
    AND s.credit_release_terminated_at IS NOT NULL);
  RETURN greatest(balance-quarantine,0)::int;
END $$;
REVOKE ALL ON FUNCTION public.fusion_review_available(uuid,integer) FROM PUBLIC, anon, authenticated, service_role;

-- Gold only (Owner 2026-10-17), independent of the per-plan switch (which also still applies).
CREATE OR REPLACE FUNCTION public.fusion_review_gold(a uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT coalesce((SELECT membership_level='gold' FROM profiles WHERE id=a),false);
$$;
REVOKE ALL ON FUNCTION public.fusion_review_gold(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Holds the fixed price of a review being created (called inside fusion_review_start, after the insert).
CREATE OR REPLACE FUNCTION public.fusion_review_fee_hold(rv fusion_reviews, v jsonb, cfg jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE price text:=coalesce(nullif(v#>>'{review,fixedPriceCredits}',''),'1500'); fee integer; hold integer;
  balance integer; q record;
BEGIN
  IF price!~'^[1-9][0-9]{0,5}$' THEN RAISE EXCEPTION 'FUSION_SETTINGS_INVALID'; END IF;
  fee:=price::int;
  IF jsonb_typeof(cfg->'fixedPrice') IS DISTINCT FROM 'object' OR coalesce(cfg#>>'{fixedPrice,credits}','')!~'^[1-9][0-9]{0,5}$'
    OR coalesce(cfg#>>'{fixedPrice,holdCredits}','')!~'^(0|[1-9][0-9]{0,7})$' THEN RAISE EXCEPTION 'FUSION_REVIEW_INVALID'; END IF;
  -- The user agreed to the price the page showed; a price changed meanwhile is refused, never charged silently.
  IF (cfg#>>'{fixedPrice,credits}')::int<>fee THEN RAISE EXCEPTION 'FUSION_REVIEW_PRICE_CHANGED'; END IF;
  hold:=(cfg#>>'{fixedPrice,holdCredits}')::int;
  SELECT credits INTO balance FROM profiles WHERE id=rv.actor_id AND status='active' AND is_deleted='false' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILL2_ACTOR_DENIED'; END IF;
  -- "只给 Gold" (Owner 2026-10-17) holds whatever the plan switches say: an administrator can re-enable the plan flag.
  IF fusion_review_gold(rv.actor_id) IS NOT TRUE THEN RAISE EXCEPTION 'FUSION_MEMBERSHIP_REQUIRED'; END IF;
  IF fusion_review_available(rv.actor_id,balance)<fee::bigint+hold THEN RAISE EXCEPTION 'FUSION_REVIEW_CREDITS'; END IF;
  SELECT * INTO q FROM atomic_pre_deduct(rv.actor_id,fee,'Expert review hold',rv.id);
  IF q.is_idempotent THEN RAISE EXCEPTION 'FUSION_REVIEW_CONFLICT'; END IF;
  INSERT INTO fusion_review_fees(review_id,actor_id,credits,pre_deduct_id,state) VALUES(rv.id,rv.actor_id,fee,q.pre_deduct_id,'held');
  INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,
    idempotency_key,balance_before,balance_after,metadata)
  VALUES(rv.actor_id,-fee,'adjustment','Expert review hold','adjustment','bill2_reserve','ai_task',rv.id::text,
    'fusion-review:'||rv.id||':reserve',q.balance_before,q.balance_after,
    -- Only keys the erasure ledger shape knows (erasure_ledger_metadata): L = fee plus the largest temporary call hold.
    jsonb_build_object('sourceType','fusion_review','sourceId',rv.id::text,'preDeductId',q.pre_deduct_id,'nominalReserved',fee,
      'L',fee::bigint+hold));
END $$;
REVOKE ALL ON FUNCTION public.fusion_review_fee_hold(fusion_reviews,jsonb,jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- The fee's view (null for a review without a fee).
CREATE OR REPLACE FUNCTION public.fusion_review_fee_view(p_review_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('credits',f.credits,'state',f.state,'chargedCredits',f.charged_credits,'reason',f.settle_reason,
    'settledAt',f.settled_at) FROM fusion_review_fees f WHERE f.review_id=p_review_id;
$$;
REVOKE ALL ON FUNCTION public.fusion_review_fee_view(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Settles a held fee once its review has ended (idempotent; a running review or a stop with calls still
-- unsettled leaves it held). Lock order: profile -> fee row, as content erasure (which already holds the profile)
-- reaches it (callers may already hold the review row).
CREATE OR REPLACE FUNCTION public.fusion_review_fee_settle_internal(p_review_id uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE f fusion_review_fees; rv fusion_reviews; charge integer; reason text; before_balance integer; restored integer;
  q record; meta jsonb;
BEGIN
  PERFORM 1 FROM profiles WHERE id=(SELECT actor_id FROM fusion_review_fees WHERE review_id=p_review_id) FOR UPDATE;
  SELECT * INTO f FROM fusion_review_fees WHERE review_id=p_review_id FOR UPDATE;
  IF f.review_id IS NULL THEN RETURN NULL; END IF;
  IF f.state<>'held' THEN RETURN fusion_review_fee_view(f.review_id); END IF;
  SELECT * INTO rv FROM fusion_reviews WHERE id=p_review_id;
  IF rv.id IS NULL THEN charge:=0; reason:='deleted';
  ELSIF rv.state IN ('running','paused') THEN RETURN fusion_review_fee_view(f.review_id);
  ELSIF rv.state='completed' AND rv.outcome->>'kind'='revised' THEN charge:=f.credits; reason:='revised';
  -- A summary judged usable means the revision was delivered: the full price, whatever ended the review afterwards.
  -- unjudged_saved is only the deadline's provisional verdict (the saved body was not checked): when the review then
  -- ended as revision_failed the revision was not delivered, so that case falls through to the refund below.
  ELSIF EXISTS(SELECT 1 FROM fusion_billing_groups g JOIN bill2_runs br ON br.fusion_group_id=g.id JOIN bill2_calls c ON c.run_id=br.id
    WHERE g.fee_review_id=f.review_id AND c.payload->>'phase'='fusion_summary'
      AND (c.fusion_verdict='usable' OR c.fusion_verdict='unjudged_saved' AND rv.state<>'revision_failed')) THEN
    charge:=f.credits; reason:='revised';
  ELSIF rv.state IN ('stopped','interrupted') THEN
    -- The existing stop rule: dispatched calls pay their known usage. Wait until every call has settled.
    IF EXISTS(SELECT 1 FROM fusion_billing_groups g JOIN bill2_runs br ON br.fusion_group_id=g.id JOIN bill2_calls c ON c.run_id=br.id
      WHERE g.fee_review_id=f.review_id AND c.settled_at IS NULL) THEN RETURN fusion_review_fee_view(f.review_id); END IF;
    SELECT least(f.credits,coalesce(sum(c.theoretical_delta),0))::int INTO charge
      FROM fusion_billing_groups g JOIN bill2_runs br ON br.fusion_group_id=g.id JOIN bill2_calls c ON c.run_id=br.id
      WHERE g.fee_review_id=f.review_id AND c.nominal_source='fixed_fee';
    reason:=rv.state;
  ELSE charge:=0; reason:=rv.state; END IF;
  SELECT credits INTO before_balance FROM profiles WHERE id=f.actor_id FOR UPDATE;
  -- Only keys the erasure ledger shape knows; the settlement stores its own copy under billing_history usage.
  meta:=jsonb_build_object('sourceType','fusion_review','sourceId',f.review_id::text,'preDeductId',f.pre_deduct_id,
    'nominalReserved',f.credits,'consumedCredits',charge,'refundedCredits',f.credits-charge,'outcome',reason);
  IF charge>0 THEN
    SELECT * INTO q FROM bill2_legacy_settle(f.actor_id,f.pre_deduct_id,charge,
      jsonb_build_object('preDeductId',f.pre_deduct_id,'credits',f.credits,'chargedDelta',charge),NULL);restored:=q.difference;
  ELSE
    SELECT * INTO q FROM bill2_legacy_refund(f.actor_id,f.pre_deduct_id,'Expert review hold release');restored:=q.refund_amount;
  END IF;
  IF restored<0 OR q.balance_after-before_balance<>restored OR restored+charge<>f.credits THEN
    RAISE EXCEPTION 'FUSION_FEE_CONSERVATION'; END IF;
  INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,
    idempotency_key,balance_before,balance_after,metadata)
  VALUES(f.actor_id,f.credits,'adjustment','Expert review hold release','adjustment','bill2_release','ai_task',f.review_id::text,
    'fusion-review:'||f.review_id||':release',before_balance,before_balance::bigint+f.credits,meta);
  IF charge>0 THEN
    INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,
      idempotency_key,balance_before,balance_after,metadata)
    VALUES(f.actor_id,-charge,'consumption','Expert review','spend','bill2_spend','ai_task',f.review_id::text,
      'fusion-review:'||f.review_id||':spend',before_balance::bigint+f.credits,q.balance_after,meta);
  END IF;
  UPDATE fusion_review_fees SET state=CASE WHEN charge>0 THEN 'charged' ELSE 'refunded' END,charged_credits=charge,
    settle_reason=reason,settled_at=clock_timestamp() WHERE review_id=f.review_id;
  RETURN fusion_review_fee_view(f.review_id);
END $$;
REVOKE ALL ON FUNCTION public.fusion_review_fee_settle_internal(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Host entry for one review of the user's own (page reads and stop retries).
CREATE OR REPLACE FUNCTION public.fusion_review_fee_settle(p_actor_id uuid, p_review_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM bill2_actor(p_actor_id);
  IF NOT EXISTS(SELECT 1 FROM fusion_review_fees WHERE review_id=p_review_id AND actor_id=p_actor_id) THEN RETURN NULL; END IF;
  RETURN fusion_review_fee_settle_internal(p_review_id);
END $$;

-- Daily recovery: held fees whose review has ended or is gone. Listed without locks: the settlement takes the
-- profile, then the fee row (the erasure order), and is idempotent.
CREATE OR REPLACE FUNCTION public.fusion_review_fee_settle_due(p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE due uuid; n integer:=0; v jsonb;
BEGIN
  FOR due IN SELECT f.review_id FROM fusion_review_fees f LEFT JOIN fusion_reviews rv ON rv.id=f.review_id
    WHERE f.state='held' AND (rv.id IS NULL OR rv.state NOT IN ('running','paused'))
    ORDER BY f.created_at LIMIT least(greatest(coalesce(p_limit,100),1),500) LOOP
    -- A fee whose profile is locked by a deletion that waits on a lock this transaction holds is skipped, not failed: the
    -- deletion goes first and the next run settles it (or the deletion already refunded it).
    BEGIN
      v:=fusion_review_fee_settle_internal(due);
      IF v->>'state'<>'held' THEN n:=n+1; END IF;
    EXCEPTION WHEN deadlock_detected OR lock_not_available THEN NULL;
    END;
  END LOOP;
  RETURN n;
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['fusion_review_fee_settle(uuid,uuid)','fusion_review_fee_settle_due(integer)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;

-- Start: hold the fee in the creating transaction (a refusal rolls the review back too).
DO $$ DECLARE src text; a text:=$x$  RETURNING * INTO rv;
  RETURN fusion_review_view(rv);$x$; BEGIN
  src:=pg_get_functiondef('public.fusion_review_start(uuid,uuid,uuid,uuid,jsonb)'::regprocedure);
  IF position('-- 0294 fixed price' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: fusion_review_start 0294'; END IF;
    EXECUTE replace(src,a,$x$  RETURNING * INTO rv;
  -- 0294 fixed price
  PERFORM fusion_review_fee_hold(rv,v,p_config);
  RETURN fusion_review_view(rv);$x$);
  END IF;
END $$;

-- Claim: a fee review marks each group before its first call; a group of another review, or a marked group in a
-- review without a fee, is refused.
DO $$ DECLARE src text; a text:=$x$  res:=fusion_group_claim(p_actor_id,p_group_id,k,1,p_items);$x$; BEGIN
  src:=pg_get_functiondef('public.fusion_review_claim(uuid,uuid,integer,text,integer,uuid,jsonb)'::regprocedure);
  IF position('-- 0294 fee marker' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: fusion_review_claim 0294'; END IF;
    EXECUTE replace(src,a,$x$  -- 0294 fee marker
  IF EXISTS(SELECT 1 FROM fusion_review_fees WHERE review_id=rv.id) THEN
    IF fusion_review_gold(p_actor_id) IS NOT TRUE THEN RAISE EXCEPTION 'FUSION_MEMBERSHIP_REQUIRED'; END IF;
    UPDATE fusion_billing_groups SET fee_review_id=rv.id WHERE id=g.id AND fee_review_id IS NULL;
    IF (SELECT fee_review_id FROM fusion_billing_groups WHERE id=g.id) IS DISTINCT FROM rv.id THEN RAISE EXCEPTION 'FUSION_GROUP_DENIED'; END IF;
  ELSIF (SELECT fee_review_id FROM fusion_billing_groups WHERE id=g.id) IS NOT NULL THEN RAISE EXCEPTION 'FUSION_GROUP_DENIED';
  END IF;
$x$||a);
  END IF;
END $$;

-- End states settle the fee in the same transaction.
DO $$ DECLARE src text; a text:=$x$      updated_at=clock_timestamp(),ended_at=clock_timestamp() WHERE id=rv.id RETURNING * INTO rv;
  ELSE RAISE EXCEPTION 'FUSION_REVIEW_INVALID'; END IF;$x$; BEGIN
  src:=pg_get_functiondef('public.fusion_review_advance(uuid,uuid,jsonb,jsonb)'::regprocedure);
  IF position('-- 0294 fee settle' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: fusion_review_advance 0294'; END IF;
    EXECUTE replace(src,a,$x$      updated_at=clock_timestamp(),ended_at=clock_timestamp() WHERE id=rv.id RETURNING * INTO rv;
    -- 0294 fee settle
    PERFORM fusion_review_fee_settle_internal(rv.id);
  ELSE RAISE EXCEPTION 'FUSION_REVIEW_INVALID'; END IF;$x$);
  END IF;
END $$;

-- Stop / end: settle after the runs are cancelled and finalized (or stay held until in-flight calls settle);
-- a repeated stop retries the settlement.
DO $$ DECLARE src text; a text:=$x$    IF rv.state=p_state THEN RETURN fusion_review_view(rv); END IF;$x$;
  b text:=$x$  END LOOP;
  RETURN fusion_review_view(rv);$x$; BEGIN
  src:=pg_get_functiondef('public.fusion_review_close(uuid,uuid,text)'::regprocedure);
  IF position('-- 0294 fee settle' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>2 OR array_length(string_to_array(src,b),1)<>2 THEN
      RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: fusion_review_close 0294'; END IF;
    src:=replace(src,a,$x$    -- 0294 fee settle
    IF rv.state=p_state THEN PERFORM fusion_review_fee_settle_internal(rv.id); RETURN fusion_review_view(rv); END IF;$x$);
    EXECUTE replace(src,b,$x$  END LOOP;
  PERFORM fusion_review_fee_settle_internal(rv.id);
  RETURN fusion_review_view(rv);$x$);
  END IF;
END $$;

-- Finalize: a call of a fee review's group settles at zero user charge; the would-be charge is platform-absorbed.
CREATE OR REPLACE FUNCTION public.bill2_payg_zero_source(source text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT coalesce(source IN ('confirmed_failure','tool_no_usage','tool_failed','tool_failed_charged','tool_unknown','fixed_fee'),false)
$$;
REVOKE ALL ON FUNCTION public.bill2_payg_zero_source(text) FROM PUBLIC, anon, authenticated, service_role;
DO $$ DECLARE src text; a text:=$x$debit:=least(delta,c.reserved_credits)::int;cap:=greatest(bounded-c.reserved_credits,0);bound:=delta-debit-cap;$x$; BEGIN
  src:=pg_get_functiondef('public.bill2_payg_finalize(uuid,uuid)'::regprocedure);
  IF position('-- 0294 fixed price' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: bill2_payg_finalize 0294'; END IF;
    EXECUTE replace(src,a,a||$x$
   -- 0294 fixed price: the review's fixed fee covers this call; the hold is released through the refund path.
   IF r.fusion_group_id IS NOT NULL AND EXISTS(SELECT 1 FROM fusion_billing_groups WHERE id=r.fusion_group_id
    AND fee_review_id IS NOT NULL) THEN debit:=0;cap:=0;bound:=delta;source:='fixed_fee';END IF;$x$);
  END IF;
END $$;

-- The erasure ledger shape accepts the new per-call nominal source (as 0255 added the tool sources).
DO $$ DECLARE src text; a text:=$x$"tool_usage", "tool_no_usage", "tool_failed", "tool_failed_charged", "tool_unknown"]$x$; BEGIN
  src:=pg_get_functiondef('public.erasure_ledger_metadata(jsonb)'::regprocedure);
  IF position('"fixed_fee"' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>3 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: erasure_ledger_metadata 0294'; END IF;
    EXECUTE replace(src,a,$x$"tool_usage", "tool_no_usage", "tool_failed", "tool_failed_charged", "tool_unknown", "fixed_fee"]$x$);
  END IF;
END $$;

-- Usage projections for a fixed-fee call: the settled-at-zero path skips token_stats / ai_usage_logs (the zero-charge
-- refund path writes none), but the real provider cost must reach the cost dashboards (#1098 review). Same rows as a
-- charged call, at zero credits. Shared marker: whichever of 0294 / 0295 applies first patches, the other skips.
DO $$ DECLARE src text; a text:=$x$  UPDATE bill2_calls SET nominal_cost_usd=n,nominal_source=source,theoretical_delta=delta,charged_delta=debit,$x$; BEGIN
  src:=pg_get_functiondef('public.bill2_payg_finalize(uuid,uuid)'::regprocedure);
  IF position('-- fixed_fee usage rows' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FIXED_FEE_SOURCE_MISMATCH: bill2_payg_finalize usage rows'; END IF;
    EXECUTE replace(src,a,$x$  -- fixed_fee usage rows
  IF source='fixed_fee' AND c.dispatched_at IS NOT NULL THEN
   INSERT INTO token_stats(bill2_run_id,bill2_call_id,user_id,model_used,input_tokens,output_tokens,cached_tokens,cache_creation_tokens,web_search_count,total_cost_usd,total_credits,metadata)
   VALUES(rid,c.id,a,c.model,(selected_usage->>'inputTokens')::int,(selected_usage->>'outputTokens')::int,NULL,NULL,NULL,c.selected_cost_usd,0,meta);
   INSERT INTO ai_usage_logs(bill2_run_id,bill2_call_id,user_id,request_id,model_id,status,metadata)
   VALUES(rid,c.id,a,c.id::text,c.model,'success',meta);
  END IF;
$x$||a);
  END IF;
END $$;

-- View: the fee next to the review.
CREATE OR REPLACE FUNCTION public.fusion_review_view(rv fusion_reviews) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('reviewId',rv.id,'state',rv.state,'round',rv.round,'phase',rv.phase,'attempt',rv.attempt,
    'draftId',rv.draft_id,'sourceVersionId',rv.source_version_id,'sourceSessionId',rv.source_session_id,
    'versionHash',rv.version_hash,'materials',rv.materials,'materialsHash',rv.materials_hash,'config',rv.config,
    'steps',rv.steps,'outcome',rv.outcome,'revisionId',rv.revision_id,'endedAt',rv.ended_at,'adoption',rv.adoption,
    'fee',fusion_review_fee_view(rv.id),
    -- Per call: its run, verdict and whether it settled, for continueReview.
    'calls',coalesce((SELECT jsonb_agg(jsonb_build_object('groupId',br.fusion_group_id,'runId',br.id,'callId',c.id,'modelId',br.payload->>'modelId',
      'phase',c.payload->>'phase','dispatched',c.dispatched_at IS NOT NULL,'verdict',c.fusion_verdict,
      'settled',c.settled_at IS NOT NULL,'state',c.state,'dispatchedAt',c.dispatched_at,'settledAt',c.settled_at) ORDER BY c.created_at,c.id)
      FROM bill2_runs br JOIN bill2_calls c ON c.run_id=br.id
      WHERE br.actor_id=rv.actor_id AND br.fusion_group_id IN (SELECT (x->>'groupId')::uuid FROM jsonb_array_elements(rv.steps) x)),'[]'));
$$;

-- Administrator look-back: credits charged include the fee (per-call charges stay for reviews without one).
CREATE OR REPLACE FUNCTION public.fusion_review_admin_list(p_limit integer, p_before_created timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT coalesce(jsonb_agg(x ORDER BY (x->>'createdAt')::timestamptz DESC, x->>'reviewId' DESC),'[]') FROM (
    SELECT jsonb_build_object('reviewId',rv.id,'actorId',rv.actor_id,'draftId',rv.draft_id,'state',rv.state,'outcome',rv.outcome,
      'round',rv.round,'createdAt',rv.created_at,'endedAt',rv.ended_at,'sourceVersionId',rv.source_version_id,
      'breakerCleared',CASE WHEN rv.breaker_cleared_at IS NULL THEN NULL ELSE jsonb_build_object('at',rv.breaker_cleared_at,
        'by',rv.breaker_cleared_by,'reason',rv.breaker_clear_reason,'batch',rv.breaker_clear_batch) END,'reviewers',rv.config->'reviewers','summary',rv.config->'summary',
      'costUsd',coalesce((SELECT sum(coalesce(c.selected_cost_usd,0)) FROM bill2_runs br JOIN bill2_calls c ON c.run_id=br.id
        WHERE br.actor_id=rv.actor_id AND br.fusion_group_id IN (SELECT (s->>'groupId')::uuid FROM jsonb_array_elements(rv.steps) s)),0),
      'chargedCredits',coalesce((SELECT sum(coalesce(br.charged,0)) FROM bill2_runs br
        WHERE br.actor_id=rv.actor_id AND br.fusion_group_id IN (SELECT (s->>'groupId')::uuid FROM jsonb_array_elements(rv.steps) s)),0)
        +coalesce((SELECT charged_credits FROM fusion_review_fees WHERE review_id=rv.id),0),
      'fee',fusion_review_fee_view(rv.id)) x
    FROM fusion_reviews rv
    WHERE p_before_created IS NULL OR (rv.created_at,rv.id)<(p_before_created,coalesce(p_before_id,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
    ORDER BY rv.created_at DESC, rv.id DESC LIMIT least(greatest(coalesce(p_limit,20),1),100)) q;
$$;

-- Breaker (§3.3): the call cost of a refunded review is platform-borne too.
CREATE OR REPLACE FUNCTION public.fusion_review_breaker_usage(a uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object(
    'noDeliveryCalls', count(*) FILTER (WHERE c.fusion_verdict='no_delivery'),
    'platformUsd', coalesce(sum(coalesce(c.selected_cost_usd,0)) FILTER (WHERE c.fusion_verdict IN
      ('no_delivery','format_invalid','revision_invalid','erased_before_verdict')
      OR EXISTS(SELECT 1 FROM fusion_review_fees fe WHERE fe.review_id=g.fee_review_id AND fe.state='refunded')),0))
  FROM bill2_calls c JOIN bill2_runs r ON r.id=c.run_id LEFT JOIN fusion_billing_groups g ON g.id=r.fusion_group_id
  WHERE r.actor_id=a AND r.fusion_group_id IS NOT NULL AND c.created_at>=clock_timestamp()-interval '7 days';
$$;

-- Deleting reviews (draft / conversation deletion, account erasure) refunds their held fees in the same transaction.
DO $$ DECLARE src text; a text:=$x$ DELETE FROM fusion_reviews fr WHERE fr.actor_id=a AND (fr.project_id=ANY(projects) OR fr.source_session_id=ANY(sessions)
  OR fr.source_version_id=ANY(versions));$x$; BEGIN
  src:=pg_get_functiondef('public.content_erasure_confirm(uuid,text,uuid,text)'::regprocedure);
  IF position('-- 0294 fee refund' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: content_erasure_confirm 0294'; END IF;
    EXECUTE replace(src,a,a||$x$
 -- 0294 fee refund
 PERFORM fusion_review_fee_settle_internal(held_fee.review_id) FROM fusion_review_fees held_fee
  WHERE held_fee.actor_id=a AND held_fee.state='held' AND NOT EXISTS(SELECT 1 FROM fusion_reviews WHERE id=held_fee.review_id);$x$);
  END IF;
  src:=pg_get_functiondef('public.account_erasure_scrub_content(uuid)'::regprocedure);
  a:=$x$  DELETE FROM fusion_reviews WHERE actor_id=p_profile_id;$x$;
  IF position('-- 0294 fee refund' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: account_erasure_scrub_content 0294'; END IF;
    EXECUTE replace(src,a,a||$x$
  -- 0294 fee refund
  PERFORM fusion_review_fee_settle_internal(held_fee.review_id) FROM fusion_review_fees held_fee
   WHERE held_fee.actor_id=p_profile_id AND held_fee.state='held';$x$);
  END IF;
  -- A held fee keeps account erasure financially pending until it settles.
  src:=pg_get_functiondef('public.account_erasure_financial_proof(uuid)'::regprocedure);
  a:=$x$ RETURN jsonb_build_object('financialPending',pending,'manualReview',manual);$x$;
  IF position('fusion_review_fees' IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: account_erasure_financial_proof 0294'; END IF;
    EXECUTE replace(src,a,$x$ SELECT count(*) INTO n FROM fusion_review_fees WHERE actor_id=p_profile_id AND state='held';
 pending:=pending+n;
$x$||a);
  END IF;
END $$;
COMMIT;
