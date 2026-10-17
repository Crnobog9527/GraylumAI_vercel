-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Rollback for 0281, run before reverting the application code. Removes the request functions and
-- keeps every request: 'consult' tickets become 'question' tickets (shown as "咨询" by builds without
-- 0281), keeping their title "专家诊断预约", need and contact details, so an older admin ticket view can
-- still list and answer them, and they are still erased with the account.
-- A ticket of a closed or closing account cannot be updated (0191 guard): finish that account's erasure
-- cleanup first, which deletes the ticket, then run this again.
BEGIN;
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.tickets t LEFT JOIN public.profiles p ON p.id=t.user_id
  WHERE t.category='consult' AND t.user_id IS NOT NULL
   AND (p.id IS NULL OR p.status='deleted' OR p.is_deleted::text='true'
    OR EXISTS(SELECT 1 FROM public.account_erasure_requests e WHERE e.profile_id=t.user_id))) THEN
  RAISE EXCEPTION 'EXPERT_CONSULT_ROLLBACK_ERASURE_PENDING';
 END IF;
END $$;
UPDATE public.tickets SET category='question' WHERE category='consult';
DROP FUNCTION IF EXISTS public.expert_consult_request(uuid,text,text,text);
DROP FUNCTION IF EXISTS public.expert_consult_state(uuid);
DROP FUNCTION IF EXISTS public.expert_consult_pending(uuid);
COMMIT;
