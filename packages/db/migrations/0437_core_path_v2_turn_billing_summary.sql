-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2: the daily reconciliation counts what turns settle. A turn writes one billing_history settle row and no token_stats
-- or per-operation charge, so research_billing_summary now also splits each settled turn by its receipts:
--   count             the old path's charged operations, plus the supplier subcalls the user paid for: returned data
--                     (tools/meter.ts), in a turn whose settlement charged its tools. A fully refunded turn counts none: the platform bore them.
--   credits           the old path's charged credits, plus the tool part of each turn's settlement: ceil(q x sum(n x m)) over the tool
--                     receipts turn_close charged, at most what was settled. The two paths cannot overlap: only the old path sets
--                     research_operations.charged_at; research_turn_apply writes operations without a charge.
--   turnOtherCredits  the rest of each settlement (model calls, fixed prices, carried credits), so settled credits add up.
-- Read only.
CREATE OR REPLACE FUNCTION public.research_billing_summary(p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_end<p_start OR p_end-p_start>interval '31 days' THEN RAISE EXCEPTION 'invalid reconciliation window'; END IF;
 RETURN (
  WITH old AS (SELECT count(*) n,coalesce(sum(charged_credits),0) credits FROM research_operations
   WHERE state='succeeded' AND charged_at>=p_start AND charged_at<p_end),
  settled AS (SELECT -b.amount credits,(b.metadata->>'turnId')::bigint turn_id FROM billing_history b
   WHERE b.operation_type='settle' AND b.created_at>=p_start AND b.created_at<p_end AND b.metadata->>'turnId' ~ '^[0-9]{1,18}$'),
  split AS (SELECT s.credits,least(s.credits,coalesce(r.credits,0)) tool,CASE WHEN least(s.credits,coalesce(r.credits,0))>0 THEN r.n ELSE 0 END n FROM settled s
   LEFT JOIN turns t ON t.id=s.turn_id
   -- As turn_close: a tool receipt that arrived after the close is not the user's.
   LEFT JOIN LATERAL (SELECT ceil((t.policy->>'q')::numeric*sum(k.nominal_usd*k.multiplier))::integer credits,
     sum((SELECT count(*) FROM jsonb_array_elements(coalesce(k.usage->'results','[]')) x WHERE x->>'outcome' IN ('ok','partial') AND (x->>'items')::integer>0))::integer n
    FROM turn_calls k WHERE k.turn_id=t.id AND k.call_kind='tool' AND k.status='ok' AND k.settled_at<=t.closed_at) r ON true)
  SELECT jsonb_build_object('count',o.n+coalesce(sum(p.n),0),'credits',o.credits+coalesce(sum(p.tool),0),
    'turnOtherCredits',coalesce(sum(p.credits-p.tool),0))
  FROM old o LEFT JOIN split p ON true GROUP BY o.n,o.credits);
END $function$;
