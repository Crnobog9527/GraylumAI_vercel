-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- REPORT-GEN: settle the fixed report price in the transaction ending the execution.
-- Number 0397 assigned by the controller, 2026-10-26 (PR #1453).
-- A TypeScript stop hook cannot cover SQL-owned failure, recovery and deletion transitions.
-- Reuse 0295 unchanged: profile -> report_fees lock order, idempotency, complete-report charging,
-- and REPORT_FEE_CONSERVATION. Runtime failures use cancelled (there is no failed state).
-- No existing function is patched; this new trigger function is defined in full below.
-- Compatibility: old/new callers use the same RPCs. report.status and daily reconciliation remain
-- safe, idempotent fallbacks. Old terminal held rows are not swept by this migration.
-- Repeatable: CREATE OR REPLACE function plus DROP/CREATE trigger; no balance/data backfill.
-- Recovery: DROP TRIGGER report_fee_terminal_settlement ON public.runtime_executions, then
-- DROP FUNCTION public.report_fee_terminal_settlement(). Keep all report_fees and ledger entries;
-- the prior status/daily settlement paths continue working. Do not reverse already settled money.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.report_fee_terminal_settlement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  -- Plain reads only before the existing settlement takes profile then fee locks. Ordinary
  -- executions and already settled fees never acquire those locks through this trigger.
  IF EXISTS(SELECT 1 FROM report_fees WHERE execution_id=NEW.id AND state='held') THEN
    PERFORM report_fee_settle_internal(NEW.id,false);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.report_fee_terminal_settlement() FROM PUBLIC,anon,authenticated,service_role;

DROP TRIGGER IF EXISTS report_fee_terminal_settlement ON public.runtime_executions;
CREATE TRIGGER report_fee_terminal_settlement
  AFTER UPDATE OF state,result ON public.runtime_executions
  FOR EACH ROW WHEN (NEW.state IN ('completed','cancelled','cost_pending'))
  EXECUTE FUNCTION public.report_fee_terminal_settlement();
COMMIT;
