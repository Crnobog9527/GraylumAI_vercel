-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Recovery for 0226: first deploy application code that no longer calls log_retention_cleanup
-- (otherwise the daily cron counts a failure), then drop the function. Deleted rows were logs past
-- the E7 30-day limit and are not restored. No other object or data changes.
BEGIN;
DROP FUNCTION IF EXISTS public.log_retention_cleanup(integer);
COMMIT;
