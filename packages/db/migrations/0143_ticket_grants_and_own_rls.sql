-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- B02: restore ticket capabilities without permitting identity/status forgery.
-- Requires the explicit ticket projections shipped with this migration.
-- No table/data/default/Storage changes. Apply remotely only with Owner approval.
BEGIN;

-- Fail closed on unexpected policy drift rather than retain an OR-based bypass.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename IN ('tickets', 'ticket_replies')
      AND policyname NOT IN (
        'tickets_select_own', 'tickets_insert_own', 'tickets_update_own',
        'tickets_select_admin', 'tickets_admin_all',
        'ticket_replies_select_own', 'ticket_replies_insert_own',
        'ticket_replies_select_admin', 'ticket_replies_admin_all'
      )
  ) THEN
    RAISE EXCEPTION 'B02: unexpected ticket policy; inspect before applying';
  END IF;
  IF (SELECT count(*) FROM pg_class WHERE oid IN (
      'public.tickets'::regclass, 'public.ticket_replies'::regclass
    ) AND relrowsecurity) <> 2 THEN
    RAISE EXCEPTION 'B02: both ticket tables must already have RLS enabled';
  END IF;
END $$;

REVOKE ALL PRIVILEGES ON TABLE public.tickets, public.ticket_replies
  FROM PUBLIC, anon, authenticated;
-- Table REVOKE does not clear old column ACLs (including PUBLIC inheritance).
DO $$
DECLARE
  table_name text;
  columns_sql text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['tickets', 'ticket_replies'] LOOP
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO columns_sql
    FROM pg_attribute WHERE attrelid = format('public.%I', table_name)::regclass
      AND attnum > 0 AND NOT attisdropped;
    EXECUTE format(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s)'
      ' ON TABLE public.%2$I FROM PUBLIC, anon, authenticated', columns_sql, table_name
    );
  END LOOP;
END $$;

GRANT SELECT (id, user_id, title, description, category, priority, attachments,
  status, is_deleted, created_at, updated_at) ON TABLE public.tickets TO authenticated;
GRANT INSERT (user_id, title, description, category, attachments)
  ON TABLE public.tickets TO authenticated;
GRANT UPDATE (status) ON TABLE public.tickets TO authenticated;
GRANT SELECT (id, ticket_id, user_id, content, is_admin, attachments, created_at)
  ON TABLE public.ticket_replies TO authenticated;
GRANT INSERT (ticket_id, user_id, content) ON TABLE public.ticket_replies TO authenticated;

-- adminProcedure uses service_role, not an authenticated admin-policy bypass.
DROP POLICY IF EXISTS tickets_select_admin ON public.tickets;
DROP POLICY IF EXISTS tickets_admin_all ON public.tickets;
DROP POLICY IF EXISTS tickets_select_own ON public.tickets;
DROP POLICY IF EXISTS tickets_insert_own ON public.tickets;
DROP POLICY IF EXISTS tickets_update_own ON public.tickets;
CREATE POLICY tickets_select_own ON public.tickets FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND is_deleted = 'false');
CREATE POLICY tickets_insert_own ON public.tickets FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()) AND is_deleted = 'false' AND status = 'open');
CREATE POLICY tickets_update_own ON public.tickets FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()) AND is_deleted = 'false')
  WITH CHECK (user_id = (SELECT auth.uid()) AND is_deleted = 'false' AND status = 'closed');

DROP POLICY IF EXISTS ticket_replies_select_admin ON public.ticket_replies;
DROP POLICY IF EXISTS ticket_replies_admin_all ON public.ticket_replies;
DROP POLICY IF EXISTS ticket_replies_select_own ON public.ticket_replies;
DROP POLICY IF EXISTS ticket_replies_insert_own ON public.ticket_replies;
CREATE POLICY ticket_replies_select_own ON public.ticket_replies FOR SELECT TO authenticated
  USING (is_deleted = 'false' AND EXISTS (
    SELECT 1 FROM public.tickets t
    WHERE t.id = ticket_replies.ticket_id AND t.user_id = (SELECT auth.uid())
      AND t.is_deleted = 'false'
  ));
CREATE POLICY ticket_replies_insert_own ON public.ticket_replies FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()) AND is_admin = 'false' AND is_deleted = 'false'
    AND EXISTS (
      SELECT 1 FROM public.tickets t
      WHERE t.id = ticket_replies.ticket_id AND t.user_id = (SELECT auth.uid())
        AND t.is_deleted = 'false'
    )
  );

-- Only capabilities missing from the observed staging ACLs are added.
GRANT SELECT ON TABLE public.ticket_replies TO service_role;
GRANT INSERT (ticket_id, user_id, content, is_admin)
  ON TABLE public.ticket_replies TO service_role;
GRANT UPDATE (status, updated_at) ON TABLE public.tickets TO service_role;
COMMIT;
