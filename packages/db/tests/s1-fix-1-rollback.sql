-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- S1-FIX batch 1 (0144) rollback ONLY to staging catalog 2026-09-29 13:18:38 UTC.
-- Restores the broken nickname/banner/admin paths and client MAINTAIN/Dxt permissions.
-- Separately authorize remote use. Keep the compatible code deployed alongside it.
-- Does not undo profile, announcement or audit data written while the migration was active.
BEGIN;
DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
REVOKE UPDATE (nickname) ON TABLE public.profiles FROM authenticated;
REVOKE SELECT (avatar_url) ON TABLE public.profiles FROM service_role;
REVOKE UPDATE (email, role, status) ON TABLE public.profiles FROM service_role;
GRANT MAINTAIN ON TABLE public.profiles TO anon, authenticated;

REVOKE SELECT (id, title, content, type, announcement_type, banner_style, banner_link, tag,
  priority, active, start_date, end_date) ON TABLE public.announcements FROM anon, authenticated;
REVOKE INSERT (title, content, type, announcement_type, banner_style, banner_link, icon, icon_color,
  tag, tag_color, priority, active, start_date, end_date, created_by)
  ON TABLE public.announcements FROM service_role;
REVOKE UPDATE (title, content, type, announcement_type, banner_style, banner_link, icon, icon_color,
  tag, tag_color, priority, active, start_date, end_date, updated_at)
  ON TABLE public.announcements FROM service_role;
REVOKE DELETE ON TABLE public.announcements FROM service_role;
GRANT MAINTAIN ON TABLE public.announcements TO anon, authenticated;

REVOKE SELECT (id, user_id, admin_id, action, action_type, details, created_at)
  ON TABLE public.user_activity_logs FROM service_role;
REVOKE INSERT (user_id, admin_id, action, action_type, details)
  ON TABLE public.user_activity_logs FROM service_role;
GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.user_activity_logs TO anon, authenticated;
COMMIT;
