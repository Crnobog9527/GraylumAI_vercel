-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- B02 rollback ONLY to staging catalog 2026-09-29 08:51:37 UTC.
-- Restores broken own-row access and dangerous client Dxt/MAINTAIN permissions.
-- Separately authorize remote use. Restore the compatible code alongside it.
-- Does not undo ticket data created while the migration was active.
BEGIN;
REVOKE ALL PRIVILEGES ON TABLE public.tickets, public.ticket_replies
  FROM PUBLIC, anon, authenticated;
DO $$
DECLARE table_name text; columns_sql text;
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
GRANT MAINTAIN ON TABLE public.tickets TO anon, authenticated;
GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON TABLE public.ticket_replies TO anon, authenticated;
REVOKE SELECT ON TABLE public.ticket_replies FROM service_role;
REVOKE INSERT (ticket_id, user_id, content, is_admin)
  ON TABLE public.ticket_replies FROM service_role;
REVOKE UPDATE (status, updated_at) ON TABLE public.tickets FROM service_role;
DROP POLICY IF EXISTS tickets_select_own ON public.tickets;
DROP POLICY IF EXISTS tickets_insert_own ON public.tickets;
DROP POLICY IF EXISTS tickets_update_own ON public.tickets;
DROP POLICY IF EXISTS tickets_select_admin ON public.tickets;
DROP POLICY IF EXISTS ticket_replies_select_own ON public.ticket_replies;
DROP POLICY IF EXISTS ticket_replies_insert_own ON public.ticket_replies;
DROP POLICY IF EXISTS ticket_replies_select_admin ON public.ticket_replies;
CREATE POLICY tickets_select_admin ON tickets FOR SELECT TO authenticated
  USING (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text) AND (p.status = 'active'::text))))
;
CREATE POLICY ticket_replies_insert_own ON ticket_replies FOR INSERT TO authenticated
  WITH CHECK (EXISTS ( SELECT 1
   FROM tickets t
  WHERE ((t.id = ticket_replies.ticket_id) AND (t.user_id = auth.uid()))))
;
CREATE POLICY ticket_replies_select_admin ON ticket_replies FOR SELECT TO authenticated
  USING (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text) AND (p.status = 'active'::text))))
;
COMMIT;
