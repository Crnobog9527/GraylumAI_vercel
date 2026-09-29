-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- S1-FIX batch 1: own nickname update, public banner columns, admin user/announcement/audit grants.
-- Requires the explicit admin/profile projections shipped with this migration.
-- No table/data/default/Storage changes. Apply remotely only with Owner approval.
BEGIN;

-- Fail closed on unexpected policy drift rather than keep an unknown OR-based bypass.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('profiles', 'announcements', 'user_activity_logs')
      AND (tablename::text, policyname::text) NOT IN (VALUES
        ('profiles', 'profiles_select_own'), ('profiles', 'profiles_update_own'),
        ('announcements', 'announcements_select_active_public'),
        ('announcements', 'announcements_select_admin'),
        ('user_activity_logs', 'user_activity_logs_select_admin'))
  ) OR EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND policyname <> 'profiles_update_own' AND cmd <> 'SELECT'
      AND tablename IN ('profiles', 'announcements', 'user_activity_logs')
  ) THEN
    RAISE EXCEPTION 'S1-FIX-1: unexpected profile/announcement/activity policy; inspect before applying';
  END IF;
  IF (SELECT count(*) FROM pg_class WHERE oid IN (
      'public.profiles'::regclass, 'public.announcements'::regclass,
      'public.user_activity_logs'::regclass
    ) AND relrowsecurity) <> 3 THEN
    RAISE EXCEPTION 'S1-FIX-1: profiles, announcements and user_activity_logs must have RLS enabled';
  END IF;
END $$;

-- Client roles: keep only own-row profile reads, then add back the minimum.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON TABLE public.profiles FROM PUBLIC, anon, authenticated;
REVOKE SELECT ON TABLE public.profiles FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.announcements, public.user_activity_logs
  FROM PUBLIC, anon, authenticated;
-- Table REVOKE does not clear old column ACLs (including PUBLIC inheritance).
DO $$
DECLARE
  table_name text;
  columns_sql text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['profiles', 'announcements', 'user_activity_logs'] LOOP
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO columns_sql
    FROM pg_attribute WHERE attrelid = format('public.%I', table_name)::regclass
      AND attnum > 0 AND NOT attisdropped;
    EXECUTE format(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s)'
      ' ON TABLE public.%2$I FROM PUBLIC, anon', columns_sql, table_name
    );
    -- authenticated keeps its table-level own-row profile SELECT.
    EXECUTE format(
      'REVOKE %1$s ON TABLE public.%2$I FROM authenticated',
      CASE WHEN table_name = 'profiles'
        THEN format('INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s)', columns_sql)
        ELSE format('SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s)', columns_sql)
      END, table_name
    );
  END LOOP;
END $$;

-- A-01: users edit only their own nickname; role, credits, membership and email stay server-owned.
GRANT UPDATE (nickname) ON TABLE public.profiles TO authenticated;
DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
CREATE POLICY profiles_update_own ON public.profiles FOR UPDATE TO authenticated
  USING (id = (SELECT auth.uid()) AND is_deleted = 'false')
  WITH CHECK (id = (SELECT auth.uid()) AND is_deleted = 'false'
    AND char_length(btrim(nickname)) BETWEEN 1 AND 80);

-- A-02: columns the public banner query projects, filters and orders by; rows stay governed by
-- the existing announcements_select_active_public policy.
GRANT SELECT (id, title, content, type, announcement_type, banner_style, banner_link, tag,
  priority, active, start_date, end_date) ON TABLE public.announcements TO anon, authenticated;

-- Only capabilities missing from the observed staging ACLs are added for service_role.
-- A-04: avatar display plus the email sync and role/status management writes.
GRANT SELECT (avatar_url) ON TABLE public.profiles TO service_role;
GRANT UPDATE (email, role, status) ON TABLE public.profiles TO service_role;
-- A-02: admin banner create, edit and delete.
GRANT INSERT (title, content, type, announcement_type, banner_style, banner_link, icon, icon_color,
  tag, tag_color, priority, active, start_date, end_date, created_by)
  ON TABLE public.announcements TO service_role;
GRANT UPDATE (title, content, type, announcement_type, banner_style, banner_link, icon, icon_color,
  tag, tag_color, priority, active, start_date, end_date, updated_at)
  ON TABLE public.announcements TO service_role;
GRANT DELETE ON TABLE public.announcements TO service_role;
-- A-10: admin audit history reads and best-effort audit writes.
GRANT SELECT (id, user_id, admin_id, action, action_type, details, created_at)
  ON TABLE public.user_activity_logs TO service_role;
GRANT INSERT (user_id, admin_id, action, action_type, details)
  ON TABLE public.user_activity_logs TO service_role;
COMMIT;
