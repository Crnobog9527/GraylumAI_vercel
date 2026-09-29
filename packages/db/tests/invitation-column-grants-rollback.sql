-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- C4b local regression rollback for the explicitly declared broad-SELECT fixture.
-- NOT a remote recovery authorization. Check the actual pre-migration ACL first.
BEGIN;
REVOKE SELECT (id, created_at, invitee_email, inviter_reward, status, inviter_id)
  ON TABLE public.invitation_records FROM authenticated;
GRANT SELECT ON TABLE public.invitation_records TO anon, authenticated;
DROP POLICY IF EXISTS invitation_records_select_own ON public.invitation_records;
CREATE POLICY invitation_records_select_own
  ON public.invitation_records FOR SELECT
  USING (auth.uid() = inviter_id OR auth.uid() = invitee_id);
DROP POLICY IF EXISTS invitation_records_select_admin ON public.invitation_records;
CREATE POLICY invitation_records_select_admin
  ON public.invitation_records FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.role = 'admin' AND p.status = 'active'
  ));
COMMIT;
