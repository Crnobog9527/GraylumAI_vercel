-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Read only; the caller must first verify the linked staging project.
BEGIN READ ONLY;
SELECT value FROM public.system_settings WHERE key = 'maintenance_mode';
COMMIT;
