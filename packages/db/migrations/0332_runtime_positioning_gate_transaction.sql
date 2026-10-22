/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
-- MODEL-IDENTITY-GUARD: free-chat admission must be able to check a confirmed
-- positioning whose evidence includes Runtime results. That check retains the
-- existing runtime_history_available -> runtime_billing_allowed shared locks.
-- PostgREST starts STABLE RPCs in READ ONLY transactions, which rejects those
-- locks with 25006 before any model call. Only the transaction mode changes;
-- the function body, ownership, ACLs and every source/billing check stay intact.
-- Number 0332 assigned by controller/Owner on 2026-10-22; staging apply stays with controller.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER FUNCTION public.runtime_positioning_gate(uuid) VOLATILE;
COMMIT;
