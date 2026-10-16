-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-DISPUTE-GUARD PR-D0: every credit pack becomes a traceable credit source, and the part of a
-- charge that the current subscription period does not cover is recorded against specific sources.
-- Ledger attribution only: no balance, charge, price or refund-eligibility result changes, and no
-- new charge type. Consumption order (current period first is unchanged): unattributed credits
-- (opening grant, admin and other untracked balance) -> paid sources (credit packs and
-- non-current subscription periods), oldest first. Restorations reverse a reservation's own
-- attribution, last taken first.
-- New tables: no existing table records which pack a credit came from (subscription periods have
-- consumed_amount; packs only add to the balance). Financial records: internal ids, amounts and
-- times only, kept like payment_orders on erasure.
-- Repeatable: tables IF NOT EXISTS, functions CREATE OR REPLACE, source edits guarded by a marker,
-- backfill only on the first run. Recovery: restore the predecessor function definitions
-- (0061 atomic_pre_deduct, 0057 bill2_legacy_*, 0162 bill2_payg_compensate); the new tables are
-- then unused and kept (never drop financial records).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TEMP TABLE pr_d0_first_run ON COMMIT DROP AS
 SELECT to_regclass('public.credit_package_sources') IS NULL AS first_run;

CREATE TABLE IF NOT EXISTS public.credit_package_sources(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 -- Constraint names avoid "key": the generated catalog hash next to such a name trips the secret scan.
 user_id uuid NOT NULL CONSTRAINT credit_package_sources_owner_ref REFERENCES public.profiles(id) ON DELETE RESTRICT,
 order_id uuid NOT NULL CONSTRAINT credit_package_sources_order_unique UNIQUE
  CONSTRAINT credit_package_sources_order_ref REFERENCES public.payment_orders(id) ON DELETE RESTRICT,
 credit_transaction_id uuid NOT NULL CONSTRAINT credit_package_sources_transaction_unique UNIQUE
  CONSTRAINT credit_package_sources_transaction_ref REFERENCES public.credit_transactions(id) ON DELETE RESTRICT,
 credits_granted integer NOT NULL CHECK(credits_granted>0),
 consumed_amount integer NOT NULL DEFAULT 0 CHECK(consumed_amount>=0 AND consumed_amount<=credits_granted),
 status text NOT NULL DEFAULT 'granted' CHECK(status IN ('granted','reversed')),
 granted_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS credit_package_sources_user ON public.credit_package_sources(user_id,granted_at,id);

-- Each movement between a reservation and a source; restorations mirror the original source.
-- applied=false: the source was no longer usable (reversed, quarantined or held), so the credits
-- stayed in or returned to the unattributed balance instead.
CREATE TABLE IF NOT EXISTS public.credit_source_entries(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id uuid NOT NULL CONSTRAINT credit_source_entries_owner_ref REFERENCES public.profiles(id) ON DELETE RESTRICT,
 pre_deduct_id uuid,
 source_kind text NOT NULL CHECK(source_kind IN ('subscription_grant','credit_package','unattributed')),
 source_id uuid,
 amount integer NOT NULL CHECK(amount<>0),
 applied boolean NOT NULL DEFAULT true,
 reason text NOT NULL CHECK(reason IN ('reserve','settle','refund','abort','compensate')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT credit_source_entries_identity CHECK((source_kind='unattributed')=(source_id IS NULL))
);
CREATE INDEX IF NOT EXISTS credit_source_entries_pre_deduct ON public.credit_source_entries(pre_deduct_id)
 WHERE pre_deduct_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS credit_source_entries_source ON public.credit_source_entries(source_kind,source_id)
 WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS credit_source_entries_user ON public.credit_source_entries(user_id,created_at);

-- Existing sources whose remaining credits cannot be proven ("source unknown"). They are never
-- consumed as a source and stay inside the unattributed balance; a dispute on them only alerts.
CREATE TABLE IF NOT EXISTS public.credit_source_reviews(
 source_kind text NOT NULL CHECK(source_kind IN ('subscription_grant','credit_package')),
 source_id uuid NOT NULL,
 reason text NOT NULL CHECK(reason IN ('pre_attribution_consumption')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(source_kind,source_id)
);

ALTER TABLE public.credit_package_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_source_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_source_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.credit_package_sources,public.credit_source_entries,public.credit_source_reviews
 FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.credit_package_sources,public.credit_source_entries,public.credit_source_reviews TO service_role;

-- Sources the allocator may consume (usable) or must leave inside the balance (held back).
-- Callers hold the profile lock; this locks the user's source rows in id order.
CREATE OR REPLACE FUNCTION public.credit_source_rows(p_user uuid)
RETURNS TABLE(kind text,id uuid,remaining integer,since timestamptz,current_period boolean,usable boolean,held boolean)
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM subscription_credit_grants g WHERE g.user_id=p_user ORDER BY g.id FOR UPDATE;
 PERFORM 1 FROM credit_package_sources s WHERE s.user_id=p_user ORDER BY s.id FOR UPDATE;
 RETURN QUERY
 WITH grants AS (
  SELECT g.id,g.credits_granted-g.consumed_amount AS left_,g.period_start,
   g.period_start<=clock_timestamp() AND g.period_end>clock_timestamp() AS covering,
   EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=g.user_id
    AND (s.id=g.subscription_id OR s.stripe_subscription_id=g.stripe_subscription_id)
    AND s.credit_release_terminated_at IS NOT NULL)
   OR (g.subscription_id IS NOT NULL AND EXISTS(SELECT 1 FROM payment_orders o WHERE o.subscription_id=g.subscription_id
    AND o.refund_approval->>'kind'='monthly_first_purchase' AND o.refund_approval->>'hold' IN ('held','terminated'))) AS blocked,
   EXISTS(SELECT 1 FROM credit_source_reviews r WHERE r.source_kind='subscription_grant' AND r.source_id=g.id) AS unknown
  FROM subscription_credit_grants g
  WHERE g.user_id=p_user AND g.status='granted' AND g.accounting_state='trusted' AND g.credits_granted>g.consumed_amount)
 SELECT 'subscription_grant',x.id,x.left_,x.period_start,x.covering,NOT x.blocked AND NOT x.unknown,x.blocked FROM grants x
 UNION ALL
 SELECT 'credit_package',s.id,s.credits_granted-s.consumed_amount,s.granted_at,false,
  NOT EXISTS(SELECT 1 FROM credit_source_reviews r WHERE r.source_kind='credit_package' AND r.source_id=s.id),false
 FROM credit_package_sources s WHERE s.user_id=p_user AND s.status='granted' AND s.credits_granted>s.consumed_amount;
END $$;

-- p_n>0: p_n credits have just left the balance outside the current period; record where from.
-- p_n<0: -p_n credits have just come back to the balance; reverse this reservation's attribution.
-- Never raises for an accounting shortfall: what cannot be attributed is recorded as unattributed.
CREATE OR REPLACE FUNCTION public.credit_source_apply(p_user uuid,p_pre uuid,p_n integer,p_reason text)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE balance integer;pool bigint;need integer;x integer;src record;ok boolean;
BEGIN
 IF coalesce(p_n,0)=0 THEN RETURN;END IF;
 SELECT credits INTO balance FROM profiles WHERE id=p_user FOR UPDATE;
 IF p_n>0 THEN
  -- Unattributed balance before this movement: everything not held by a usable or held-back source.
  SELECT balance::bigint+p_n-coalesce(sum(r.remaining) FILTER (WHERE r.usable OR r.held),0) INTO pool
  FROM credit_source_rows(p_user) r;
  need:=p_n;
  -- A current period the caller did not charge (periods identified only by internal subscription id)
  -- still comes first; then unattributed credits; then paid sources, oldest first.
  FOR src IN SELECT r.*,0 AS phase FROM credit_source_rows(p_user) r WHERE r.usable AND r.current_period
   UNION ALL SELECT NULL,NULL,greatest(pool,0)::integer,NULL,false,true,false,1
   UNION ALL SELECT r.*,2 FROM credit_source_rows(p_user) r WHERE r.usable AND NOT r.current_period
   ORDER BY phase,since,kind,id LOOP
   EXIT WHEN need=0;
   CONTINUE WHEN src.remaining<=0;
   IF src.phase=1 THEN
    x:=least(need,src.remaining);
    INSERT INTO credit_source_entries(user_id,pre_deduct_id,source_kind,source_id,amount,reason)
    VALUES(p_user,p_pre,'unattributed',NULL,x,p_reason);
    need:=need-x;
    CONTINUE;
   END IF;
   x:=least(need,src.remaining);
   IF src.kind='subscription_grant' THEN
    UPDATE subscription_credit_grants SET consumed_amount=consumed_amount+x,updated_at=now() WHERE id=src.id;
   ELSE
    UPDATE credit_package_sources SET consumed_amount=consumed_amount+x,updated_at=clock_timestamp() WHERE id=src.id;
   END IF;
   INSERT INTO credit_source_entries(user_id,pre_deduct_id,source_kind,source_id,amount,reason)
   VALUES(p_user,p_pre,src.kind,src.id,x,p_reason);
   need:=need-x;
  END LOOP;
  -- More than the sources hold (an existing inconsistency): record it, never block the charge.
  IF need>0 THEN
   INSERT INTO credit_source_entries(user_id,pre_deduct_id,source_kind,source_id,amount,applied,reason)
   VALUES(p_user,p_pre,'unattributed',NULL,need,false,p_reason);
  END IF;
  RETURN;
 END IF;
 PERFORM 1 FROM subscription_credit_grants g WHERE g.user_id=p_user ORDER BY g.id FOR UPDATE;
 PERFORM 1 FROM credit_package_sources s WHERE s.user_id=p_user ORDER BY s.id FOR UPDATE;
 need:=-p_n;
 FOR src IN SELECT e.source_kind,e.source_id,sum(e.amount)::integer AS net FROM credit_source_entries e
  WHERE p_pre IS NOT NULL AND e.pre_deduct_id=p_pre AND e.user_id=p_user
  GROUP BY e.source_kind,e.source_id HAVING sum(e.amount)>0 ORDER BY max(e.id) DESC LOOP
  EXIT WHEN need=0;
  x:=least(need,src.net);ok:=true;
  IF src.source_kind='subscription_grant' THEN
   -- Restore only to a grant that is still usable; otherwise the credits stay unattributed.
   UPDATE subscription_credit_grants g SET consumed_amount=consumed_amount-x,updated_at=now()
   WHERE g.id=src.source_id AND g.status='granted' AND g.accounting_state='trusted' AND g.consumed_amount>=x
    AND NOT EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=g.user_id
     AND (s.id=g.subscription_id OR s.stripe_subscription_id=g.stripe_subscription_id) AND s.credit_release_terminated_at IS NOT NULL)
    AND NOT (g.subscription_id IS NOT NULL AND EXISTS(SELECT 1 FROM payment_orders o WHERE o.subscription_id=g.subscription_id
     AND o.refund_approval->>'kind'='monthly_first_purchase' AND o.refund_approval->>'hold' IN ('held','terminated')));
   ok:=FOUND;
  ELSIF src.source_kind='credit_package' THEN
   UPDATE credit_package_sources SET consumed_amount=consumed_amount-x,updated_at=clock_timestamp()
   WHERE id=src.source_id AND status='granted' AND consumed_amount>=x;
   ok:=FOUND;
  END IF;
  INSERT INTO credit_source_entries(user_id,pre_deduct_id,source_kind,source_id,amount,applied,reason)
  VALUES(p_user,p_pre,src.source_kind,src.source_id,-x,ok,p_reason);
  need:=need-x;
 END LOOP;
 -- Restoring more than this reservation attributed (reservations made before PR-D0) adds to the
 -- unattributed balance; nothing else to move.
END $$;

-- Pack lifecycle follows the ledger rows every pack path already writes, so any grant path
-- (Stripe 0170, Stripe MP/Waffo 0211) and the shared pack refund (0185/0252) stay covered.
CREATE OR REPLACE FUNCTION public.credit_package_source_track() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.source_order_id IS NULL OR NEW.idempotency_key IS NULL THEN RETURN NULL;END IF;
 IF NEW.amount>0 AND (NEW.idempotency_key='pay-common:package:'||NEW.source_order_id::text
   OR NEW.idempotency_key='method-package:'||NEW.source_order_id::text) THEN
  INSERT INTO credit_package_sources(user_id,order_id,credit_transaction_id,credits_granted,granted_at)
  SELECT NEW.user_id,o.id,NEW.id,NEW.amount,NEW.created_at FROM payment_orders o
  WHERE o.id=NEW.source_order_id AND o.item_type='credit_package' AND o.user_id=NEW.user_id
  ON CONFLICT (order_id) DO NOTHING;
 ELSIF NEW.amount<0 AND NEW.idempotency_key LIKE 'pay-common:refund:%' AND NEW.ledger_type='refund_clawback' THEN
  UPDATE credit_package_sources SET status='reversed',updated_at=clock_timestamp()
  WHERE order_id=NEW.source_order_id AND user_id=NEW.user_id AND status='granted';
 ELSIF NEW.amount>0 AND NEW.idempotency_key LIKE 'pay-common:refund-restore:%' THEN
  UPDATE credit_package_sources SET status='granted',updated_at=clock_timestamp()
  WHERE order_id=NEW.source_order_id AND user_id=NEW.user_id AND status='reversed';
 END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS credit_package_source_track ON public.credit_transactions;
CREATE TRIGGER credit_package_source_track AFTER INSERT ON public.credit_transactions
 FOR EACH ROW EXECUTE FUNCTION public.credit_package_source_track();

REVOKE ALL ON FUNCTION public.credit_source_rows(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.credit_source_apply(uuid,uuid,integer,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.credit_package_source_track() FROM PUBLIC,anon,authenticated,service_role;

-- Hook the five functions that move credits for a reservation. Each edit inserts one call just
-- before the function's single success return; the marker makes a second run a no-op.
DO $$ DECLARE f record;src text;BEGIN
 FOR f IN SELECT * FROM (VALUES
  ('public.atomic_pre_deduct(uuid,integer,text,uuid)',
   'RETURN QUERY SELECT v_pre_deduct_id, v_balance_before, v_balance_after, FALSE;',
   'PERFORM credit_source_apply(p_user_id, v_pre_deduct_id, v_to_other, ''reserve''); -- PR-D0 credit sources'),
  ('public.bill2_legacy_settle(uuid,uuid,integer,jsonb,jsonb)',
   'RETURN QUERY SELECT p_actual_credits, v_balance_delta, v_balance_after;',
   'PERFORM credit_source_apply(p_user_id, p_pre_deduct_id, -v_balance_delta - v_period_delta, ''settle''); -- PR-D0 credit sources'),
  ('public.bill2_legacy_refund(uuid,uuid,text)',
   'RETURN QUERY SELECT GREATEST(v_balance_delta, 0), v_balance_after;',
   'PERFORM credit_source_apply(p_user_id, p_pre_deduct_id, -v_balance_delta - v_period_delta, ''refund''); -- PR-D0 credit sources'),
  ('public.bill2_legacy_abort_settle(uuid,uuid,integer,jsonb,text,text)',
   'RETURN QUERY SELECT p_consumed_credits, GREATEST(v_balance_delta, 0), v_balance_after;',
   'PERFORM credit_source_apply(p_user_id, p_pre_deduct_id, -v_balance_delta - v_period_delta, ''abort''); -- PR-D0 credit sources'),
  ('public.bill2_payg_compensate(bill2_runs,bill2_calls)',
   ' UPDATE profiles SET credits=credits+restored WHERE id=r.actor_id;',
   ' PERFORM credit_source_apply(r.actor_id,c.pre_deduct_id,-other_part,''compensate''); -- PR-D0 credit sources')
 ) v(sig,anchor,call) LOOP
  src:=pg_get_functiondef(f.sig::regprocedure);
  IF position('-- PR-D0 credit sources' IN src)>0 THEN CONTINUE;END IF;
  IF array_length(string_to_array(src,f.anchor),1)<>2 THEN
   RAISE EXCEPTION 'PR_D0_SOURCE_MISMATCH: %',f.sig;
  END IF;
  -- Compensation already restored the balance, so the call goes after that update; the others
  -- run after the balance and period updates and before the return.
  IF f.sig LIKE 'public.bill2_payg_compensate%' THEN
   EXECUTE replace(src,f.anchor,f.anchor||E'\n'||f.call);
  ELSE
   EXECUTE replace(src,f.anchor,f.call||E'\n  '||f.anchor);
  END IF;
 END LOOP;
END $$;

-- First run only: create sources for existing packs and mark existing sources whose remaining
-- cannot be proven. A source is proven when nothing could have spent outside the current period
-- since it started counting: no reservation or settlement charged "other" credits, and no other
-- deduction, at or after that time.
DO $$ BEGIN
 IF NOT (SELECT first_run FROM pr_d0_first_run) THEN RETURN;END IF;
 INSERT INTO credit_package_sources(user_id,order_id,credit_transaction_id,credits_granted,status,granted_at)
 SELECT t.user_id,o.id,t.id,t.amount,
  CASE WHEN (SELECT count(*) FROM credit_transactions c WHERE c.source_order_id=o.id AND c.amount<0
    AND c.idempotency_key LIKE 'pay-common:refund:%' AND c.ledger_type='refund_clawback')
   >(SELECT count(*) FROM credit_transactions c WHERE c.source_order_id=o.id AND c.amount>0
    AND c.idempotency_key LIKE 'pay-common:refund-restore:%') THEN 'reversed' ELSE 'granted' END,
  t.created_at
 FROM credit_transactions t JOIN payment_orders o ON o.id=t.source_order_id AND o.user_id=t.user_id
 WHERE o.item_type='credit_package' AND t.amount>0
  AND t.idempotency_key IN ('pay-common:package:'||o.id::text,'method-package:'||o.id::text)
 ON CONFLICT (order_id) DO NOTHING;

 CREATE TEMP TABLE pr_d0_starts ON COMMIT DROP AS
 SELECT 'credit_package'::text AS kind,s.id,s.user_id,s.granted_at AS since FROM credit_package_sources s
 UNION ALL
 SELECT 'subscription_grant',g.id,g.user_id,
  CASE WHEN g.stripe_subscription_id IS NOT NULL THEN least(g.period_end,clock_timestamp()) ELSE g.created_at END
 FROM subscription_credit_grants g WHERE g.status='granted' AND g.accounting_state='trusted';

 INSERT INTO credit_source_reviews(source_kind,source_id,reason)
 SELECT x.kind,x.id,'pre_attribution_consumption' FROM pr_d0_starts x
 WHERE EXISTS(SELECT 1 FROM billing_history h WHERE h.user_id=x.user_id AND h.created_at>=x.since AND (
   h.operation_type='pre_deduct' AND coalesce(nullif(h.metadata->>'amountToOther','')::integer,abs(h.amount))>0
   OR h.operation_type IN ('settle','abort_settle') AND coalesce(nullif(h.metadata->>'difference','')::integer,0)<0))
  OR EXISTS(SELECT 1 FROM credit_transactions c WHERE c.user_id=x.user_id AND c.created_at>=x.since AND c.amount<0
   AND coalesce(c.reason_code,'') NOT IN ('bill2_reserve','bill2_spend')
   AND NOT (x.kind='credit_package' AND c.source_order_id=(SELECT order_id FROM credit_package_sources WHERE id=x.id)))
 ON CONFLICT DO NOTHING;
END $$;

COMMIT;
