-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- ARCH-FIX E3 (Owner 2026-10-25, "架构审计上线前按 A 做"; audit item 6): two ledger constraints.
--
-- 1. One pre-deduction per (user, requestId). Before: atomic_pre_deduct looked the request up before locking the
--    profile, so two concurrent calls with one requestId could both miss it and both deduct. Now it looks again after
--    taking the profile lock (every pre-deduction of a user holds that lock until commit, so the second call sees
--    the first and returns it as idempotent), and a unique index on billing_history makes a duplicate impossible.
-- 2. credit_transactions.idempotency_key NOT NULL (0018 allowed NULL). The writers that left it empty now set one:
--    daily check-in ('checkin:<user>:<date>', one per user and day like user_checkins), the ledger entry function
--    when its caller passes none (admin adjustments without a key: a fresh 'ledger:<uuid>', so each request still
--    applies once, as before), and the three v1 finalize functions (no application caller; 'legacy-finalize:<uuid>').
--    Existing rows without a key (staging 10-25: 5 test rows, 4 admin adjustments and 1 check-in) get
--    'legacy-null:<id>'; the new production database has none.
--    Found while testing: the ledger entry function failed on a repeated key (bigint balances returned as integer);
--    it now returns the first entry, as intended.
-- Function bodies are patched in place from their current definitions; each anchor must match exactly once.
-- Recovery: DROP INDEX billing_history_pre_deduct_request; ALTER COLUMN idempotency_key DROP NOT NULL; re-run the
-- predecessor bodies (pg_get_functiondef captured before applying). Backfilled keys stay (they only name old rows).
BEGIN;
SET LOCAL lock_timeout='5s';

-- Patch helper: literal text with single spaces where the source has any whitespace; must match exactly once.
-- tag: text the replacement carries; a body that already has it is left alone (repeatable).
CREATE FUNCTION pg_temp.e3_patch(fn regprocedure, lit text, rep text, tag text DEFAULT 'ARCH-FIX E3') RETURNS void LANGUAGE plpgsql AS $$
DECLARE src text:=pg_get_functiondef(fn);pat text;
BEGIN
 IF position(tag IN src)>0 THEN RETURN; END IF;
 pat:=replace(regexp_replace(lit,'([.()*+?\[\]{}|^$\\])','\\\1','g'),' ','\s+');
 IF (SELECT count(*) FROM regexp_matches(src,pat,'g'))<>1 THEN
  RAISE EXCEPTION 'ARCH_FIX_E3_ANCHOR_MISSING: %',fn;END IF;
 EXECUTE regexp_replace(src,pat,replace(rep,'\','\\'));
END $$;

-- 1. Re-check the request under the profile lock.
SELECT pg_temp.e3_patch('public.atomic_pre_deduct(uuid,integer,text,uuid)',
 $l$IF NOT FOUND THEN RAISE EXCEPTION '用户不存在: %', p_user_id; END IF;$l$,
 $r$IF NOT FOUND THEN
    RAISE EXCEPTION '用户不存在: %', p_user_id;
  END IF;

  -- ARCH-FIX E3: a concurrent call with the same request committed while this one waited for the profile lock.
  IF p_request_id IS NOT NULL THEN
    SELECT id INTO v_existing_id FROM billing_history
    WHERE user_id = p_user_id AND operation_type = 'pre_deduct' AND metadata->>'requestId' = p_request_id::TEXT;
    IF v_existing_id IS NOT NULL THEN
      SELECT metadata->>'balance_before',metadata->>'balance_after' INTO v_balance_before,v_balance_after
      FROM billing_history WHERE id = v_existing_id;
      RETURN QUERY SELECT v_existing_id,COALESCE(v_balance_before::INTEGER,0),COALESCE(v_balance_after::INTEGER,0),TRUE;
      RETURN;
    END IF;
  END IF;$r$);

-- 2. Every writer sets a key.
SELECT pg_temp.e3_patch('public.claim_daily_checkin(uuid)',
 $l$INSERT INTO credit_transactions ( user_id, amount, type, description ) VALUES ( p_user_id, v_total_reward_credits, 'checkin',$l$,
 $r$INSERT INTO credit_transactions (idempotency_key, user_id, amount, type, description) /* ARCH-FIX E3 */
  VALUES ('checkin:'||p_user_id||':'||to_char(v_today,'YYYY-MM-DD'), p_user_id, v_total_reward_credits, 'checkin',$r$);

SELECT pg_temp.e3_patch('public.atomic_apply_credit_ledger_entry(uuid,integer,text,text,text)',
 $l$p_idempotency_key,$l$,
 $r$coalesce(p_idempotency_key,'ledger:'||gen_random_uuid()), /* ARCH-FIX E3 key */$r$,'ARCH-FIX E3 key');
-- Found here: a repeated key returned the stored bigint balances as integer columns and failed
-- ("structure of query does not match function result type") instead of returning the first entry.
SELECT pg_temp.e3_patch('public.atomic_apply_credit_ledger_entry(uuid,integer,text,text,text)',
 $l$v_existing_transaction.balance_before, v_existing_transaction.balance_after,$l$,
 $r$v_existing_transaction.balance_before::integer, /* ARCH-FIX E3 replay */
        v_existing_transaction.balance_after::integer,$r$,'ARCH-FIX E3 replay');

SELECT pg_temp.e3_patch(f::regprocedure,
 $l$INSERT INTO credit_transactions (user_id, amount, type, description) VALUES (p_user_id,$l$,
 $r$INSERT INTO credit_transactions (idempotency_key, user_id, amount, type, description) /* ARCH-FIX E3 */
    VALUES ('legacy-finalize:'||gen_random_uuid(), p_user_id,$r$)
FROM unnest(ARRAY[
 'public.bill2_legacy_finalize_success(uuid,uuid,text,text,text,numeric,integer,uuid,jsonb,jsonb,jsonb,text,integer,integer,integer,text,text)',
 'public.bill2_legacy_finalize_failure(uuid,text,text,uuid,uuid,text,integer,integer,text,text,jsonb)',
 'public.bill2_legacy_finalize_abort(uuid,uuid,text,text,text,numeric,integer,uuid,jsonb,jsonb,jsonb,text,integer,integer,integer,text,text)']) f;

DROP FUNCTION pg_temp.e3_patch(regprocedure,text,text,text);

-- 3. Constraints.
UPDATE public.credit_transactions SET idempotency_key='legacy-null:'||id WHERE idempotency_key IS NULL;
ALTER TABLE public.credit_transactions ALTER COLUMN idempotency_key SET NOT NULL;
-- Name avoids "key": the generated catalog hash next to such a name trips the secret scan (0275).
CREATE UNIQUE INDEX IF NOT EXISTS billing_history_pre_deduct_request ON public.billing_history(user_id,(metadata->>'requestId'))
 WHERE operation_type='pre_deduct';
COMMIT;
