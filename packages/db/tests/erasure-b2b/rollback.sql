-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Local-only structural rollback; projection facts require forward repair.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM bill2_receipts WHERE financial_projection_version IS NOT NULL) THEN
    RAISE EXCEPTION 'ERASURE_RECEIPT_ROLLBACK_REQUIRES_FORWARD_FIX';
  END IF;
END $$;
DROP FUNCTION public.account_erasure_scrub_receipts(uuid, uuid, integer);
CREATE OR REPLACE FUNCTION public.bill2_evidence_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'BILL2_IMMUTABLE_EVIDENCE';END $$;
DROP FUNCTION public.bill2_erasure_receipt_projection(jsonb, public.bill2_calls);
COMMIT;
