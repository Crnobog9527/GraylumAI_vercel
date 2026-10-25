-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- DB-PERF PR-1 (Owner 2026-10-25, Master Plan 2.1): billing no longer runs every user through one queue.
--
-- Before: every v2 claim, dispatch, record, finalize and close took an exclusive advisory lock per model
-- (bill2_payg_lock_models, 0162), and every claim, dispatch and settlement took the exclusive stop-loss lock
-- (201,1; 0202). All users share one model, so all billing steps of all users ran one at a time; the 10-25
-- load test hit statement timeouts at 30 concurrent users.
--
-- After: one key, (201,1), in two modes.
--   * Shared: new calls (runtime_stop_loss_assert, reached from the bill2_calls insert and dispatch triggers).
--     A claim re-checks the model's metering block while holding it, after every row lock it takes.
--   * Exclusive (unchanged or new): reservation releases (settled cost, 0202 trigger), stop-loss and rate-limit
--     setting writes (0208), and every write that makes a model metering-blocked (new trigger below, and the
--     tool pending-result guard, which counts across runs before it flags).
-- What each guarantee relied on is kept: a committed stop switch, setting change or settled cost is seen by
-- every later claim; a committed metering block is seen by every later claim; a claim that committed first
-- may still settle (unchanged: frozen calls may settle above caps, 0202). Only claims, dispatches and
-- non-flagging records/finalizes no longer wait for each other.
-- One key for both checks gives one lock order; a transaction holding the shared lock takes no row lock
-- another billing writer could hold afterwards (claim takes it after all of its row locks).
BEGIN;
SET LOCAL lock_timeout='5s';

-- 1. The per-model exclusive lock is retired. Callers keep calling it (their bodies are unchanged).
CREATE OR REPLACE FUNCTION public.bill2_payg_lock_models(r bill2_runs) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 -- DB-PERF 0362: model monitoring is ordered by the stop-loss key (201,1) instead; see bill2_payg_block_lock.
 RETURN;
END $$;

-- 2. New-call checks take the stop-loss key shared. Writers of the same key stay exclusive.
DO $$ DECLARE src text;fn regprocedure:='public.runtime_stop_loss_assert(uuid,boolean)'::regprocedure; BEGIN
 src:=pg_get_functiondef(fn);
 IF position('-- DB-PERF 0362 shared' IN src)=0 THEN
  IF (length(src)-length(replace(src,'PERFORM pg_advisory_xact_lock(201,1);','')))/length('PERFORM pg_advisory_xact_lock(201,1);')<>1 THEN
   RAISE EXCEPTION 'DB_PERF_0362_ANCHOR_MISSING: runtime_stop_loss_assert';END IF;
  src:=replace(src,'PERFORM pg_advisory_xact_lock(201,1);',
   '-- DB-PERF 0362 shared: new calls do not order each other; settlements and setting writes stay exclusive.'
   ||E'\n PERFORM pg_advisory_xact_lock_shared(201,1);');
  EXECUTE src;
 END IF;
END $$;

-- 3. A claim re-checks the model's metering block under the shared key, after all of its row locks
--    (the insert trigger has taken the key by then; taking it again here is explicit and reentrant).
DO $$ DECLARE src text;anchor text;fn regprocedure:='public.bill2_payg_claim(uuid,uuid,integer,jsonb)'::regprocedure; BEGIN
 src:=pg_get_functiondef(fn);
 IF position('-- DB-PERF 0362 late metering check' IN src)=0 THEN
  anchor:=E'VALUES(rid,seq,p,p->>''provider'',p->>''account'',p->>''model'',u) RETURNING * INTO c;';
  IF (length(src)-length(replace(src,anchor,'')))/length(anchor)<>1 THEN
   RAISE EXCEPTION 'DB_PERF_0362_ANCHOR_MISSING: bill2_payg_claim';END IF;
  src:=replace(src,anchor,anchor||E'\n  -- DB-PERF 0362 late metering check: a block committed by a writer holding (201,1) exclusively'
   ||E'\n  -- is visible here; a writer that comes later waits for this claim to commit.'
   ||E'\n  PERFORM pg_advisory_xact_lock_shared(201,1);'
   ||E'\n  IF EXISTS(SELECT 1 FROM bill2_calls x WHERE x.model=p->>''model'' AND x.id<>c.id'
   ||E'\n   AND (x.budget_conflict OR x.metering_missing OR x.metering_exit) AND x.metering_review_audit_id IS NULL)'
   ||E'\n  THEN RAISE EXCEPTION ''BILL2_PAYG_METERING_BLOCKED'';END IF;');
  EXECUTE src;
 END IF;
END $$;

-- 4. Fusion group claims no longer pre-take the per-model locks; each member claim does the check above.
DO $$ DECLARE src text;fn regprocedure:='public.fusion_group_claim(uuid,uuid,text,integer,jsonb)'::regprocedure;
 pat text:='FOR k IN SELECT DISTINCT hashtextextended\(''bill2-payg:''\|\|\(x->>''model''\),0\)\s+FROM bill2_runs br, jsonb_array_elements\(br\.payload->''callPolicy''\) x\s+WHERE br\.id IN \(SELECT \(y->>''runId''\)::uuid FROM jsonb_array_elements\(p_items\) y\) ORDER BY 1 LOOP\s+PERFORM pg_advisory_xact_lock\(k\);\s+END LOOP;';
BEGIN
 src:=pg_get_functiondef(fn);
 IF position('-- DB-PERF 0362 member claims check' IN src)=0 THEN
  IF (SELECT count(*) FROM regexp_matches(src,pat,'g'))<>1 THEN
   RAISE EXCEPTION 'DB_PERF_0362_ANCHOR_MISSING: fusion_group_claim';END IF;
  src:=regexp_replace(src,pat,'-- DB-PERF 0362 member claims check the metering block under (201,1); no model locks here.');
  EXECUTE src;
 END IF;
END $$;

-- 5. Every write that makes a model metering-blocked takes the key exclusively, before the row changes.
--    Named to run after bill2_payg_review_call_changed, which may clear the review pointer on the same row.
CREATE OR REPLACE FUNCTION public.bill2_payg_block_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF (NEW.budget_conflict OR NEW.metering_missing OR NEW.metering_exit) AND NEW.metering_review_audit_id IS NULL
  AND (TG_OP='INSERT' OR NOT ((OLD.budget_conflict OR OLD.metering_missing OR OLD.metering_exit)
   AND OLD.metering_review_audit_id IS NULL)) THEN
  PERFORM pg_advisory_xact_lock(201,1);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.bill2_payg_block_lock() FROM PUBLIC;
DROP TRIGGER IF EXISTS bill2_payg_zz_block_lock ON public.bill2_calls;
CREATE TRIGGER bill2_payg_zz_block_lock BEFORE INSERT OR UPDATE ON public.bill2_calls
 FOR EACH ROW EXECUTE FUNCTION public.bill2_payg_block_lock();

-- 6. The tool pending-result guard counts pending results across runs before it flags; guards must not
--    count concurrently, which the per-model lock used to ensure.
DO $$ DECLARE src text;anchor text:=E'IF c.call_kind<>''tool'' OR c.supplier_cost_state IS DISTINCT FROM ''pending'' THEN RETURN;END IF;';
 fn regprocedure:='public.bill2_tool_pending_guard(uuid)'::regprocedure; BEGIN
 src:=pg_get_functiondef(fn);
 IF position('-- DB-PERF 0362 guard lock' IN src)=0 THEN
  IF position(anchor IN src)=0 THEN RAISE EXCEPTION 'DB_PERF_0362_ANCHOR_MISSING: bill2_tool_pending_guard';END IF;
  src:=replace(src,anchor,anchor||E'\n  -- DB-PERF 0362 guard lock: count and flag one guard at a time.'
   ||E'\n  PERFORM pg_advisory_xact_lock(201,1);');
  EXECUTE src;
 END IF;
END $$;

COMMIT;
