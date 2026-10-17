-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Rollback for 0281: remove the request functions only. Existing 'consult' tickets are kept as
-- ordinary tickets (still visible to the user and the admin ticket view, still erased with the
-- account); nothing new can create one afterwards.
BEGIN;
DROP FUNCTION IF EXISTS public.expert_consult_request(uuid,text,text,text);
DROP FUNCTION IF EXISTS public.expert_consult_state(uuid);
DROP FUNCTION IF EXISTS public.expert_consult_pending(uuid);
COMMIT;
