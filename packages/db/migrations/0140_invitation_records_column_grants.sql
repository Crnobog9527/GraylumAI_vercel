-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- C4b: user clients may read only their own inviter-facing display columns.
-- Requires the explicit projections introduced by C4. No data/structure changes.
BEGIN;

REVOKE SELECT ON TABLE public.invitation_records FROM PUBLIC, anon, authenticated;

-- A table-level REVOKE does not remove earlier column grants. Clear every
-- existing column, including any additional internal columns, before allowlisting.
DO $$
DECLARE
  columns_sql text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum)
  INTO columns_sql
  FROM pg_attribute
  WHERE attrelid = 'public.invitation_records'::regclass
    AND attnum > 0 AND NOT attisdropped;
  EXECUTE format(
    'REVOKE SELECT (%s) ON TABLE public.invitation_records FROM PUBLIC, anon, authenticated',
    columns_sql
  );
END $$;

-- inviter_id is needed by the existing WHERE clause, not returned by the API.
GRANT SELECT (id, created_at, invitee_email, inviter_reward, status, inviter_id)
  ON TABLE public.invitation_records TO authenticated;

DROP POLICY IF EXISTS invitation_records_select_own ON public.invitation_records;
CREATE POLICY invitation_records_select_own
  ON public.invitation_records FOR SELECT TO authenticated
  USING (auth.uid() = inviter_id);

-- adminProcedure uses service_role. Its BYPASSRLS and grants are unchanged.
-- A permissive authenticated admin policy would otherwise expose other rows.
DROP POLICY IF EXISTS invitation_records_select_admin ON public.invitation_records;

COMMIT;
