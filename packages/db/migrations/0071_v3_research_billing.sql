/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Reuse the canonical credit RPCs and research operation identity. No activation.
BEGIN;
ALTER TABLE public.research_operations ADD COLUMN IF NOT EXISTS pre_deduct_id uuid;
ALTER TABLE public.research_operations ADD COLUMN IF NOT EXISTS user_quote_credits integer CHECK(user_quote_credits>=0);
ALTER TABLE public.research_operations ADD COLUMN IF NOT EXISTS charged_credits integer CHECK(charged_credits>=0);
ALTER TABLE public.research_operations ADD COLUMN IF NOT EXISTS charged_at timestamptz;
CREATE INDEX IF NOT EXISTS research_charged_at ON public.research_operations(charged_at) WHERE charged_at IS NOT NULL;
CREATE OR REPLACE FUNCTION public.research_user_charge(p_actor_id uuid,p_plan_id uuid,p_operation_id uuid,p_action text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p public.research_plans%ROWTYPE; o public.research_operations%ROWTYPE;
 price integer; pre uuid; spend uuid; setting jsonb;
BEGIN
 SELECT * INTO p FROM research_plans WHERE id=p_plan_id FOR UPDATE;
 IF NOT FOUND OR p.actor_id IS DISTINCT FROM p_actor_id OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'research denied' USING ERRCODE='42501'; END IF;
 IF p_action='refund' AND p_operation_id IS NULL THEN
  FOR o IN SELECT * FROM research_operations WHERE plan_id=p.id AND state='cancelled' AND pre_deduct_id IS NOT NULL AND charged_credits IS NULL LOOP
   PERFORM research_user_charge(p_actor_id,p.id,o.id,'refund');
  END LOOP;
  RETURN;
 END IF;
 SELECT * INTO o FROM research_operations WHERE id=p_operation_id AND plan_id=p.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'research operation missing'; END IF;
 IF p_action='reserve' THEN
  IF o.pre_deduct_id IS NOT NULL THEN RETURN; END IF;
  IF o.state<>'prepared' OR p.cancelled THEN RAISE EXCEPTION 'research not reservable'; END IF;
  SELECT value INTO setting FROM system_settings WHERE key='search_surcharge_credits';
  IF setting IS NULL OR (setting#>>'{}') !~ '^[1-9][0-9]{0,5}$' THEN RAISE EXCEPTION 'research price not configured'; END IF;
  price:=(setting#>>'{}')::integer;
  SELECT pre_deduct_id INTO pre FROM atomic_pre_deduct(p_actor_id,price,'Workbench web search',gen_random_uuid());
  UPDATE research_operations SET pre_deduct_id=pre,user_quote_credits=price WHERE id=o.id;
 ELSIF p_action='admit' THEN
  IF o.pre_deduct_id IS NULL OR o.state<>'prepared' OR p.cancelled THEN RAISE EXCEPTION 'research charge not reserved'; END IF;
 ELSIF p_action='settle' THEN
  IF o.charged_credits IS NOT NULL THEN RETURN; END IF;
  IF o.pre_deduct_id IS NULL OR o.state<>'succeeded' THEN RAISE EXCEPTION 'research result not billable'; END IF;
  PERFORM atomic_settle(p_actor_id,o.pre_deduct_id,o.user_quote_credits,
   jsonb_build_object('researchOperationId',o.id,'agentKeyCost',o.result->'cost'),jsonb_build_object('researchOperationId',o.id));
  IF o.user_quote_credits>0 THEN
   INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,counts_as_spend,source_type,source_id,idempotency_key,metadata)
   VALUES(p_actor_id,-o.user_quote_credits,'deduction','Workbench web search','spend','ai_task_spend',true,'ai_task',o.id::text,
    'workbench_research:'||o.id::text,jsonb_build_object('researchOperationId',o.id)) RETURNING id INTO spend;
   UPDATE billing_history SET transaction_id=spend WHERE user_id=p_actor_id AND operation_type='settle' AND metadata->>'preDeductId'=o.pre_deduct_id::text;
  END IF;
  UPDATE research_operations SET charged_credits=o.user_quote_credits,charged_at=now() WHERE id=o.id;
 ELSIF p_action='refund' THEN
  IF o.state NOT IN ('cancelled','failed') THEN RAISE EXCEPTION 'research unresolved dispatch cannot be refunded automatically'; END IF;
  IF o.pre_deduct_id IS NOT NULL AND o.charged_credits IS NULL THEN
   PERFORM atomic_refund(p_actor_id,o.pre_deduct_id,CASE WHEN o.state='failed' THEN 'Research provider returned a terminal error' ELSE 'Research cancelled before dispatch' END);
   UPDATE research_operations SET charged_credits=0 WHERE id=o.id;
  END IF;
 ELSE RAISE EXCEPTION 'research charge action denied'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.research_user_charge(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.research_user_charge(uuid,uuid,uuid,text) TO service_role;
-- Read-only aggregate for the existing daily reconciliation, without exposing
-- private query/result bodies or inventing AI token usage for a search.
CREATE OR REPLACE FUNCTION public.research_billing_summary(p_start timestamptz,p_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_end<p_start OR p_end-p_start>interval '31 days' THEN RAISE EXCEPTION 'invalid reconciliation window'; END IF;
 RETURN (SELECT jsonb_build_object('count',count(*),'credits',coalesce(sum(charged_credits),0)) FROM research_operations
  WHERE state='succeeded' AND charged_at>=p_start AND charged_at<p_end);
END $$;
REVOKE ALL ON FUNCTION public.research_billing_summary(timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.research_billing_summary(timestamptz,timestamptz) TO service_role;
-- Report cancellation under the same plan lock, including an intent with no
-- operation yet. A dispatched operation can never be reported as unsent.
CREATE OR REPLACE FUNCTION public.research_cancel(p_actor_id uuid,p_plan_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM research_transition('cancel',p_plan_id,p_actor_id,NULL,'{}');
 PERFORM research_user_charge(p_actor_id,p_plan_id,NULL,'refund');
 RETURN NOT EXISTS(SELECT 1 FROM research_operations WHERE plan_id=p_plan_id AND state<>'cancelled');
END $$;
REVOKE ALL ON FUNCTION public.research_cancel(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.research_cancel(uuid,uuid) TO service_role;
-- Non-creating lookup allows recovery before new-execution rate admission.
CREATE OR REPLACE FUNCTION public.research_lookup(p_actor_id uuid,p_plan_id uuid,p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'research denied' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM research_plans WHERE id=p_plan_id) THEN RETURN NULL; END IF;
 RETURN research_transition('get',p_plan_id,p_actor_id,p_operation_id,'{}');
END $$;
REVOKE ALL ON FUNCTION public.research_lookup(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.research_lookup(uuid,uuid,uuid) TO service_role;
COMMIT;
