-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Admin procedures authenticate active admins before using the server-only writer.
-- No client-role DML grants; no data changes. Safe to apply repeatedly.
BEGIN;
GRANT INSERT, UPDATE ON TABLE public.ai_models TO service_role;
GRANT DELETE ON TABLE public.modules TO service_role;
COMMIT;
-- Recovery: revoke these same grants to restore the prior read-only model posture.
