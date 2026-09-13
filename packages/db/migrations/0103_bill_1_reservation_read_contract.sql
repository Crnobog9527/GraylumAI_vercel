/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- Expand-only diagnostic read contract. No data, write privilege, or RLS change.
-- Rollback the application first; keep these read grants and billing evidence.
GRANT SELECT (id, user_id, metadata) ON TABLE public.billing_history TO service_role;
