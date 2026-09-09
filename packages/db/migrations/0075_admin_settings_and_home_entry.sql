-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Match the existing administrator model-write boundary: the API authenticates
-- an active administrator before using its server-only database client.
-- No existing rows, model choices, prices or credentials are changed.
BEGIN;
GRANT INSERT, UPDATE ON TABLE public.system_settings TO service_role;
-- This value is a public feature-card destination, never a private model setting.
DROP POLICY IF EXISTS system_settings_select_home_analysis ON public.system_settings;
CREATE POLICY system_settings_select_home_analysis ON public.system_settings
 FOR SELECT TO anon, authenticated USING (key='home_analysis_module_id');
COMMIT;
-- Recovery: REVOKE INSERT,UPDATE ON public.system_settings FROM service_role;
-- DROP POLICY system_settings_select_home_analysis ON public.system_settings;
-- Both operations preserve saved data and restore the previous access boundary.
