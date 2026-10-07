-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- OUTPUT-CAP-RAISE: retain full 32768-unit responses and their replay projection.
-- No existing rows, frozen contracts, result limits or permissions change.
BEGIN;
ALTER TABLE public.bill2_receipts DROP CONSTRAINT IF EXISTS bill2_receipts_payload_check;
ALTER TABLE public.bill2_receipts ADD CONSTRAINT bill2_receipts_payload_check
 CHECK (octet_length(payload::text) <= 4194304);
COMMIT;
