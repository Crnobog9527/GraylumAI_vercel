/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Minimal research reservations, not user credit accounting. Separate deployment approval required.
CREATE TABLE IF NOT EXISTS public.research_plans (
 id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES public.profiles(id),
 budget_units bigint NOT NULL CHECK(budget_units BETWEEN 1 AND 1000000000),
 max_operations integer NOT NULL CHECK(max_operations BETWEEN 1 AND 20),
 operations jsonb NOT NULL CHECK(jsonb_typeof(operations)='array' AND jsonb_array_length(operations)=max_operations),
 reserved_units bigint NOT NULL DEFAULT 0 CHECK(reserved_units>=0 AND reserved_units<=budget_units),
 cancelled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.research_operations (
 id uuid PRIMARY KEY, plan_id uuid NOT NULL REFERENCES public.research_plans(id),
 identity_hash text NOT NULL CHECK(identity_hash ~ '^[a-f0-9]{64}$'),
 quote_units bigint NOT NULL CHECK(quote_units BETWEEN 0 AND 1000000000),
 dispatch_token uuid NOT NULL, state text NOT NULL CHECK(state IN ('prepared','dispatched','succeeded','failed','unknown','cancelled')),
 result jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(result IS NULL OR octet_length(result::text)<=1048576)
);
CREATE INDEX IF NOT EXISTS research_operations_plan_idx ON public.research_operations(plan_id);
ALTER TABLE public.research_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.research_plans,public.research_operations FROM PUBLIC,anon,authenticated,service_role;
-- All state transitions serialized by the parent plan lock; only this RPC writes.
CREATE OR REPLACE FUNCTION public.research_transition(p_action text,p_plan_id uuid,p_actor_id uuid,p_operation_id uuid DEFAULT NULL,p_payload jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p public.research_plans%ROWTYPE; o public.research_operations%ROWTYPE; token uuid:=gen_random_uuid();
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'research denied' USING ERRCODE='42501'; END IF;
 IF p_action='create' THEN
   INSERT INTO public.research_plans(id,actor_id,budget_units,max_operations,operations)
   VALUES(p_plan_id,p_actor_id,(p_payload->>'budgetUnits')::bigint,(p_payload->>'maxOperations')::integer,p_payload->'operations') ON CONFLICT DO NOTHING;
 END IF;
 SELECT * INTO p FROM public.research_plans WHERE id=p_plan_id FOR UPDATE;
 IF NOT FOUND OR p.actor_id<>p_actor_id THEN RAISE EXCEPTION 'research denied' USING ERRCODE='42501'; END IF;
 IF p_action='create' THEN
   IF p.operations IS DISTINCT FROM p_payload->'operations' OR p.budget_units<>(p_payload->>'budgetUnits')::bigint OR p.max_operations<>(p_payload->>'maxOperations')::integer THEN RAISE EXCEPTION 'plan conflict'; END IF;
   RETURN '{"created":true}';
 END IF;
 SELECT * INTO o FROM public.research_operations WHERE id=p_operation_id;
 IF FOUND AND o.plan_id<>p_plan_id THEN RAISE EXCEPTION 'operation conflict'; END IF;
 IF p_action IN ('reserve','get') AND o.id IS NOT NULL THEN
   IF p_action='reserve' AND (o.identity_hash IS DISTINCT FROM p_payload->>'identityHash' OR o.quote_units IS DISTINCT FROM (p_payload->>'quoteUnits')::bigint) THEN RAISE EXCEPTION 'operation conflict'; END IF;
   IF p_action='reserve' AND o.state='prepared' AND NOT p.cancelled THEN
     UPDATE public.research_operations SET dispatch_token=token WHERE id=o.id;
     RETURN jsonb_build_object('claimed',true,'token',token,'state','prepared');
   END IF;
   RETURN jsonb_build_object('claimed',false,'identityHash',o.identity_hash,'state',o.state,'result',o.result);
 END IF;
 IF p_action='get' THEN
   IF p.cancelled THEN RAISE EXCEPTION 'plan cancelled'; END IF;
   RETURN 'null'::jsonb;
 END IF;
 IF p_action='cancel' THEN
   UPDATE public.research_plans SET cancelled=true WHERE id=p.id;
   UPDATE public.research_operations SET state='cancelled' WHERE plan_id=p.id AND state='prepared';
   RETURN '{"cancelled":true}';
 END IF;
 IF p_action='reserve' THEN
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.operations) x WHERE x->>'operationId'=p_operation_id::text
     AND x->>'identityHash'=p_payload->>'identityHash' AND (x->>'maxQuoteUnits')::bigint >= (p_payload->>'quoteUnits')::bigint) THEN RAISE EXCEPTION 'unconfirmed operation'; END IF;
   IF p.cancelled OR (SELECT count(*) FROM public.research_operations WHERE plan_id=p.id)>=p.max_operations
      OR (p_payload->>'quoteUnits')::bigint<0 OR p.reserved_units+(p_payload->>'quoteUnits')::bigint>p.budget_units THEN RAISE EXCEPTION 'budget or plan unavailable'; END IF;
   INSERT INTO public.research_operations(id,plan_id,identity_hash,quote_units,dispatch_token,state)
     VALUES(p_operation_id,p.id,p_payload->>'identityHash',(p_payload->>'quoteUnits')::bigint,token,'prepared');
   UPDATE public.research_plans SET reserved_units=reserved_units+(p_payload->>'quoteUnits')::bigint WHERE id=p.id;
   RETURN jsonb_build_object('claimed',true,'token',token,'state','prepared');
 END IF;
 IF o.id IS NULL OR o.dispatch_token IS DISTINCT FROM (p_payload->>'token')::uuid THEN RAISE EXCEPTION 'operation unavailable'; END IF;
 IF p_action='dispatch' THEN
   IF p.cancelled OR o.state<>'prepared' OR EXISTS(SELECT 1 FROM public.research_operations WHERE plan_id=p.id AND state IN ('dispatched','unknown')) THEN RETURN '{"dispatch":false}'; END IF;
   UPDATE public.research_operations SET state='dispatched' WHERE id=o.id;
   RETURN '{"dispatch":true}';
 END IF;
 IF p_action='finish' THEN
   IF o.state<>'dispatched' OR p_payload->>'state' NOT IN ('succeeded','failed','unknown') THEN RAISE EXCEPTION 'invalid finish'; END IF;
   UPDATE public.research_operations SET state=p_payload->>'state',result=p_payload->'result' WHERE id=o.id;
   IF p_payload->>'state'='unknown' OR (p_payload#>>'{result,cost,actual}')::numeric*1000000 > o.quote_units THEN
     UPDATE public.research_plans SET cancelled=true WHERE id=p.id;
   END IF;
   RETURN '{"saved":true}';
 END IF;
 RAISE EXCEPTION 'unknown transition';
END $$;
REVOKE ALL ON FUNCTION public.research_transition(text,uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.research_transition(text,uuid,uuid,uuid,jsonb) TO service_role;
