-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-NOTIFY PR-N2. 0312 is provisional; controller confirms before applying.
-- Reuses payment_notices and the existing daily cron; orders/subscriptions/founder facts stay authoritative.
-- No checkout/refund/renewal mutation. Helpers and scan are service-only, never exposed to clients.
-- Rollback: stop calling payment_notice_scan and restore 0270's claim body; drop the three new functions
-- only after reverting its caller. Keep payment_notices (including sent/unknown tombstones); never replay
-- deliveries on rollback. Retention stays 29-day daily cutoff (at most 30 days), erasure is unchanged.
BEGIN;
SET LOCAL lock_timeout='5s';

-- Candidate windows double as send-time eligibility. A missed daily run can catch up while the
-- message is still useful, but never after the term has renewed/ended. Dates/keys use UTC throughout.
CREATE OR REPLACE FUNCTION public.payment_notice_candidates(p_user uuid DEFAULT NULL)
RETURNS TABLE(user_id uuid,kind text,source_ref text,due_key text,params jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH orders AS MATERIALIZED (
  SELECT o.* FROM payment_orders o JOIN profiles p ON p.id=o.user_id
  WHERE (p_user IS NULL OR o.user_id=p_user) AND p.status='active' AND p.is_deleted::text='false'
   AND NOT EXISTS(SELECT 1 FROM account_erasure_requests e WHERE e.profile_id=p.id)
   AND o.item_type='membership_plan' AND o.fulfilled_at IS NOT NULL
 ), paid AS MATERIALIZED (
  SELECT o.* FROM orders o WHERE o.status='completed' AND o.payment_status='paid'
   AND o.qualification_state='sold' AND o.method_review_reason IS NULL
   AND coalesce(o.refund_approval->>'status','') NOT IN ('dispatching','pending','succeeded','review_required')
   AND NOT pay_founder_order_frozen(o.id)
 ), wallet AS (
  SELECT o.*,pay_waffo_founder_deadline(o.id) deadline FROM paid o
  WHERE o.payment_method IN ('wechat_pay','alipay') AND NOT o.auto_renew AND o.entitlement_term='year'
   AND NOT EXISTS(SELECT 1 FROM paid n WHERE n.user_id=o.user_id AND n.id<>o.id
    AND n.entitlement_end>o.entitlement_end AND n.entitlement_start<=o.entitlement_end+interval '7 days')
   AND (o.offer_kind NOT IN ('founder','founder_renewal')
    OR pay_founder_status(o.user_id)->>'state' IN ('active','grace'))
 ), card AS (
  SELECT DISTINCT ON(s.id) o.user_id,s.id,s.current_period_end,o.purchase_snapshot,
   o.payment_method,o.purchase_membership_level
  FROM paid o JOIN user_subscriptions s ON s.id=o.subscription_id AND s.user_id=o.user_id
  WHERE o.payment_method IN ('card','card_cn') AND o.auto_renew AND s.billing_cycle='yearly'
   AND s.status='active' AND s.cancel_at_period_end='false' AND s.method_cancel_requested_at IS NULL
   AND s.credit_release_terminated_at IS NULL AND o.entitlement_end=s.current_period_end
   AND s.current_period_end>now() AND s.current_period_end<=now()+interval '7 days'
  ORDER BY s.id,o.entitlement_start DESC,o.id
 ), restored AS (
  -- No invented restoration flag: an actually refunded upgrade, linked original Pro order, stopped
  -- renewal, and authoritative current Pro entitlement are all required. Upstream must restore Pro.
  SELECT u.id,u.user_id,p.entitlement_end FROM orders u JOIN paid p ON p.id=u.source_order_id
   JOIN user_subscriptions s ON s.id=p.subscription_id AND s.user_id=p.user_id
  WHERE u.method_transition='upgrade' AND u.status='refunded' AND p.purchase_membership_level='pro'
   AND u.payment_status IN ('refunded','partially_refunded') AND s.cancel_at_period_end='true'
   AND p.entitlement_end>now() AND p.entitlement_end<=now()+interval '7 days'
   AND pay_common_membership_facts(u.user_id)->'internal_membership'->>'membership_level'='pro'
   AND pay_common_membership_facts(u.user_id)->'internal_membership'->>'id'=s.id::text
 ), ended AS (
  SELECT DISTINCT o.user_id,pay_founder_status(o.user_id) st FROM orders o
   WHERE o.offer_kind IN ('founder','founder_renewal')
 )
 SELECT c.user_id,'card_renewal_upcoming',c.id::text,
  to_char(c.current_period_end AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||':-7d',
  jsonb_build_object('endDate',c.current_period_end,'amount',c.purchase_snapshot->>'price',
   'plan',c.purchase_membership_level,'managed',c.payment_method='card') FROM card c
 UNION ALL
 SELECT w.user_id,CASE WHEN w.offer_kind IN ('founder','founder_renewal') THEN 'wallet_founder_expiry'
   ELSE 'wallet_plan_expiry' END,w.id::text,
  to_char(w.entitlement_end AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||':'||t.stage,
  jsonb_build_object('endDate',w.entitlement_end,'deadline',w.deadline,'plan',w.purchase_membership_level,'stage',t.stage)
 FROM wallet w CROSS JOIN LATERAL (
  VALUES ('-7d',w.entitlement_end-interval '7 days',w.entitlement_end),
   ('0d',w.entitlement_end,w.entitlement_end+interval '5 days'),
   ('+5d',w.deadline-interval '2 days',w.deadline)
 ) t(stage,start_at,end_at)
 WHERE now()>=t.start_at AND now()<t.end_at
  AND (t.stage='-7d' OR w.offer_kind IN ('founder','founder_renewal'))
 UNION ALL
 SELECT r.user_id,'restore_pro_expiry',r.id::text,
  to_char(r.entitlement_end AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||':-7d',
  jsonb_build_object('endDate',r.entitlement_end) FROM restored r
 UNION ALL
 SELECT e.user_id,'founder_ended',e.st->>'orderId',
  to_char((e.st->>'endedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||':ended',
  jsonb_build_object('endDate',e.st->>'endedAt') FROM ended e
 WHERE e.st->>'state'='ended' AND (e.st->>'endedAt')::timestamptz<=now()
  AND (e.st->>'endedAt')::timestamptz>now()-interval '24 hours'
$$;

CREATE OR REPLACE FUNCTION public.payment_notice_eligible(n payment_notices) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM profiles p WHERE p.id=n.user_id AND p.status='active' AND p.is_deleted::text='false'
  AND NOT EXISTS(SELECT 1 FROM account_erasure_requests e WHERE e.profile_id=p.id))
 AND CASE WHEN n.kind='dispute_won_resubscribe' THEN
  -- CHARGEBACK calls the server function only after confirming won + unfreeze; N2 has no trigger.
  EXISTS(SELECT 1 FROM payment_orders o JOIN user_subscriptions s ON s.id=o.subscription_id AND s.user_id=o.user_id
   WHERE o.id::text=n.source_ref AND o.user_id=n.user_id AND o.item_type='membership_plan'
   AND o.fulfilled_at IS NOT NULL AND NOT pay_founder_order_frozen(o.id)
   AND (s.status='canceled' OR s.cancel_at_period_end='true'))
 ELSE EXISTS(SELECT 1 FROM payment_notice_candidates(n.user_id) c
  WHERE c.kind=n.kind AND c.source_ref=n.source_ref AND c.due_key=n.due_key AND c.params=n.template_params) END
$$;

-- Scan/enqueue in SQL (one unique key shared by concurrent jobs), then send a bounded batch in TS.
-- Successful/manual/exhausted records never take up a slot. Expired sending leases are included so
-- a process killed after provider dispatch cannot leave an unknown delivery hidden forever.
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
  SELECT id FROM payment_notices WHERE kind<>'dispute_won_resubscribe' AND (state='pending' OR state='failed' AND attempts<3
   OR state='unknown' OR state='sending' AND lease_expires_at<=now())
  ORDER BY updated_at,id LIMIT p_limit
 ) x;
 RETURN ids;
END $$;

-- Every claim (initial, retry, admin) rechecks live facts. Existing N1 rows/claims remain compatible.
DO $$ DECLARE source text; anchor text:=' uncertain:=n.state='; patch text;
BEGIN
 source:=pg_get_functiondef('public.payment_notice_claim(uuid,text,text,uuid)'::regprocedure);
 IF position('-- PAY-NOTIFY N2 live eligibility' IN source)=0 THEN
  IF (length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 THEN
   RAISE EXCEPTION 'PAYMENT_NOTICE_CLAIM_PATCH_MISSING'; END IF;
  patch:=E' -- PAY-NOTIFY N2 live eligibility\n'
   ||E' IF n.state NOT IN (''sent'',''skipped'') AND NOT payment_notice_eligible(n) THEN\n'
   ||E'  UPDATE payment_notices SET state=''skipped'',manual_reason=NULL,lease_expires_at=NULL,\n'
   ||E'   last_error_code=''PAYMENT_NOTICE_SUPERSEDED'',updated_at=now() WHERE id=n.id;\n'
   ||E'  RETURN jsonb_build_object(''decision'',''skip'');\n END IF;\n';
  EXECUTE replace(source,anchor,patch||anchor);
 END IF;
END $$;

-- N6: integrate into existing log cleanup; no new timer. Keep its other retention work unchanged.
DO $$ DECLARE source text; anchor text:=' RETURN jsonb_build_object('; patch text;
BEGIN
 source:=pg_get_functiondef('public.log_retention_cleanup(integer)'::regprocedure);
 IF position('-- PAY-NOTIFY N2 retention' IN source)=0 THEN
  IF (length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 THEN
   RAISE EXCEPTION 'PAYMENT_NOTICE_RETENTION_PATCH_MISSING'; END IF;
  patch:=E' -- PAY-NOTIFY N2 retention\n'
   ||E' DELETE FROM payment_notices WHERE id IN (SELECT id FROM payment_notices\n'
   ||E'  WHERE created_at<cutoff ORDER BY created_at LIMIT p_limit);\n';
  patch:=patch||E' GET DIAGNOSTICS n_notices=ROW_COUNT;\n';
  source:=replace(source,'n_jobs bigint;', 'n_jobs bigint; n_notices bigint;');
  source:=replace(source,'''more'',n_app=p_limit', '''paymentNotices'',n_notices,''more'',n_notices=p_limit OR n_app=p_limit');
  EXECUTE replace(source,anchor,patch||anchor);
 END IF;
END $$;

REVOKE ALL ON FUNCTION public.payment_notice_candidates(uuid),public.payment_notice_eligible(payment_notices),
 public.payment_notice_scan(integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.payment_notice_scan(integer) TO service_role;
COMMIT;
