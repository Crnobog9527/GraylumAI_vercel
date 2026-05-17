-- Migration: validate invitation code helper posture
-- Related issue: #148
--
-- Purpose:
--   Codify the public invitation validation helper and its execute posture.
--
-- Scope:
--   - public.validate_invitation_code(text) only.
--   - Does not change admin helper functions.
--   - Does not change RLS policies.
--   - Does not change table grants.
--   - Does not seed data.
--   - Does not configure secrets or environment values.
--   - Do not apply to production without explicit owner approval.

CREATE OR REPLACE FUNCTION public.validate_invitation_code(input_code text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM public.invitations
    WHERE code = input_code
      AND status = 'active'
  );
END;
$$;

ALTER FUNCTION public.validate_invitation_code(text)
  SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.validate_invitation_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_invitation_code(text) TO anon;
GRANT EXECUTE ON FUNCTION public.validate_invitation_code(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_invitation_code(text) TO service_role;
