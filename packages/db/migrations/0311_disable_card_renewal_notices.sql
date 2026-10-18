-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-NOTIFY follow-up: Stripe/Link owns card_renewal_upcoming delivery.
-- Rollback: restore payment_notice_candidates, payment_notice_eligible, payment_notice_claim, and
-- payment_notice_scan from
-- the migration immediately before this one. Keep all payment_notices rows and unique keys; never
-- delete history or replay a delivery as part of rollback.
BEGIN;
SET LOCAL lock_timeout='5s';

-- Keep the persisted type/template and history. Remove only the card candidate production path.
DO $$ DECLARE
 source text; start_marker text:=', card AS ('; end_marker text:= '), restored AS (';
 start_at integer; end_at integer; marker text:= '/* PAY-NOTIFY card renewal disabled */';
 card_select text:=E' SELECT c.user_id,''card_renewal_upcoming''';
 next_select text:=E' UNION ALL\n SELECT w.user_id';
 select_at integer; next_at integer;
BEGIN
 source:=pg_get_functiondef('public.payment_notice_candidates(uuid)'::regprocedure);
 IF position(marker IN source)=0 THEN
  IF (length(source)-length(replace(source,start_marker,'')))/length(start_marker)<>1
   OR (length(source)-length(replace(source,end_marker,'')))/length(end_marker)<>1
   OR (length(source)-length(replace(source,card_select,'')))/length(card_select)<>1
   OR (length(source)-length(replace(source,next_select,'')))/length(next_select)<>1 THEN
   RAISE EXCEPTION 'PAYMENT_NOTICE_CARD_CANDIDATE_PATCH_MISSING';
  END IF;
  start_at:=position(start_marker IN source); end_at:=position(end_marker IN source);
  source:=substring(source FROM 1 FOR start_at-1)||substring(source FROM end_at+1);
  select_at:=position(card_select IN source); next_at:=position(next_select IN source);
  source:=substring(source FROM 1 FOR select_at-1)||substring(source FROM next_at+length(E' UNION ALL\n'));
  source:=replace(source,' WITH orders AS MATERIALIZED (',' WITH orders AS MATERIALIZED ('||E'\n '||marker);
  EXECUTE source;
 END IF;
END $$;

-- A retained, unresolved card row can still be listed and manually resent while its subscription
-- is still live. The daily sender below excludes it. This branch preserves the old live-fact checks.
CREATE OR REPLACE FUNCTION public.payment_notice_eligible(n payment_notices) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM profiles p WHERE p.id=n.user_id AND p.status='active' AND p.is_deleted::text='false'
  AND NOT EXISTS(SELECT 1 FROM account_erasure_requests e WHERE e.profile_id=p.id))
 AND CASE
 WHEN n.kind='dispute_won_resubscribe' THEN
  EXISTS(SELECT 1 FROM payment_orders o JOIN user_subscriptions s ON s.id=o.subscription_id AND s.user_id=o.user_id
   WHERE o.id::text=n.source_ref AND o.user_id=n.user_id AND o.item_type='membership_plan'
   AND o.fulfilled_at IS NOT NULL AND NOT pay_founder_order_frozen(o.id)
   AND (s.status='canceled' OR s.cancel_at_period_end='true'))
 WHEN n.kind='card_renewal_upcoming' THEN
  EXISTS(SELECT 1 FROM user_subscriptions s JOIN LATERAL (
    SELECT o.* FROM payment_orders o WHERE o.subscription_id=s.id AND o.user_id=s.user_id
     AND o.item_type='membership_plan' AND o.fulfilled_at IS NOT NULL AND o.status='completed'
     AND o.payment_status='paid' AND o.qualification_state='sold' AND o.method_review_reason IS NULL
     AND coalesce(o.refund_approval->>'status','') NOT IN ('dispatching','pending','succeeded','review_required')
     AND o.payment_method IN ('card','card_cn') AND o.auto_renew AND o.entitlement_end=s.current_period_end
     AND NOT pay_founder_order_frozen(o.id)
    ORDER BY o.entitlement_start DESC,o.id LIMIT 1
   ) o ON true
   WHERE s.id::text=n.source_ref AND s.user_id=n.user_id AND s.billing_cycle='yearly'
    AND s.status='active' AND s.cancel_at_period_end='false' AND s.method_cancel_requested_at IS NULL
    AND s.credit_release_terminated_at IS NULL AND s.current_period_end>now()
    AND s.current_period_end<=now()+interval '7 days'
    AND n.due_key=to_char(s.current_period_end AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||':-7d'
    AND n.template_params=jsonb_build_object('endDate',s.current_period_end,'amount',o.purchase_snapshot->>'price',
     'plan',o.purchase_membership_level,'managed',o.payment_method='card'))
 ELSE EXISTS(SELECT 1 FROM payment_notice_candidates(n.user_id) c
  WHERE c.kind=n.kind AND c.source_ref=n.source_ref AND c.due_key=n.due_key AND c.params=n.template_params)
 END
$$;

-- A cron may have scanned an old card row immediately before this migration commits. The subsequent
-- system claim must not dispatch it; an explicit admin resend remains allowed for retained history.
DO $$ DECLARE source text; anchor text:=' uncertain:=n.state'; patch text;
 marker text:='-- PAY-NOTIFY card renewal system claim disabled';
BEGIN
 source:=pg_get_functiondef('public.payment_notice_claim(uuid,text,text,uuid)'::regprocedure);
 IF position(marker IN source)=0 THEN
  IF (length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 THEN
   RAISE EXCEPTION 'PAYMENT_NOTICE_CARD_CLAIM_PATCH_MISSING'; END IF;
  patch:=E' -- PAY-NOTIFY card renewal system claim disabled\n'
   ||E' IF n.kind=''card_renewal_upcoming'' AND p_actor IS NULL THEN\n'
   ||E'  RETURN jsonb_build_object(''decision'',''skip'',''reason'',''scheduled_card_notice_disabled'');\n END IF;\n';
  EXECUTE replace(source,anchor,patch||anchor);
 END IF;
END $$;

-- Old unresolved card rows remain visible, but no scheduled path dispatches them.
CREATE OR REPLACE FUNCTION public.payment_notice_scan(p_limit integer DEFAULT 100) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c record; ids jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'PAYMENT_NOTICE_LIMIT_INVALID'; END IF;
 FOR c IN SELECT x.* FROM payment_notice_candidates() x
  WHERE NOT EXISTS(SELECT 1 FROM payment_notices n WHERE (n.kind,n.source_ref,n.due_key)=(x.kind,x.source_ref,x.due_key))
  ORDER BY x.due_key,x.source_ref LIMIT p_limit LOOP
  PERFORM payment_notice_enqueue(c.user_id,c.kind,c.source_ref,c.due_key,c.params);
 END LOOP;
 SELECT coalesce(jsonb_agg(x.id),'[]'::jsonb) INTO ids FROM (
  SELECT id FROM payment_notices WHERE kind NOT IN ('dispute_won_resubscribe','card_renewal_upcoming')
   AND (state='pending' OR state='failed' AND attempts<3 OR state='unknown'
    OR state='sending' AND lease_expires_at<=now())
  ORDER BY updated_at,id LIMIT p_limit
 ) x;
 RETURN ids;
END $$;

REVOKE ALL ON FUNCTION public.payment_notice_candidates(uuid),public.payment_notice_eligible(payment_notices),
 public.payment_notice_scan(integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.payment_notice_scan(integer) TO service_role;
COMMIT;
