-- Migration: Allow anonymous reads of the maintenance mode toggle
-- Description: Middleware runs before authentication for public visitors, so it must be
-- able to read the maintenance switch without requiring auth. Keep all other system
-- settings gated behind authenticated access.

DROP POLICY IF EXISTS "system_settings_select_all" ON system_settings;

CREATE POLICY "system_settings_select_public_maintenance"
  ON system_settings FOR SELECT
  USING (
    key = 'maintenance_mode'
    OR auth.uid() IS NOT NULL
  );

COMMENT ON POLICY "system_settings_select_public_maintenance" ON system_settings IS '匿名用户仅可读取 maintenance_mode，其他设置仍要求认证用户访问';
