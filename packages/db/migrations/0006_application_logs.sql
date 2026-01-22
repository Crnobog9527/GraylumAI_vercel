-- ============================================
-- 0006_application_logs.sql
-- 应用日志表 - 存储关键业务日志
-- ============================================

-- 创建应用日志表
CREATE TABLE IF NOT EXISTS application_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  level text NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  category text NOT NULL CHECK (category IN ('auth', 'billing', 'ai', 'database', 'security', 'system', 'api')),
  message text NOT NULL,
  context jsonb DEFAULT '{}',
  user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  request_id text,
  created_at timestamptz DEFAULT now() NOT NULL
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_application_logs_user_id ON application_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_application_logs_created_at ON application_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_application_logs_category ON application_logs(category);
CREATE INDEX IF NOT EXISTS idx_application_logs_level ON application_logs(level);
CREATE INDEX IF NOT EXISTS idx_application_logs_request_id ON application_logs(request_id);

-- 复合索引: 按用户和时间查询
CREATE INDEX IF NOT EXISTS idx_application_logs_user_created ON application_logs(user_id, created_at DESC);

-- 复合索引: 按级别和时间查询 (用于告警)
CREATE INDEX IF NOT EXISTS idx_application_logs_level_created ON application_logs(level, created_at DESC);

-- 启用 RLS
ALTER TABLE application_logs ENABLE ROW LEVEL SECURITY;

-- RLS 策略: 只有管理员可以查看所有日志
CREATE POLICY "Admin can view all logs" ON application_logs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

-- RLS 策略: 用户只能查看自己的日志
CREATE POLICY "Users can view own logs" ON application_logs
  FOR SELECT
  USING (user_id = auth.uid());

-- RLS 策略: 服务端可以插入日志 (通过 service_role)
CREATE POLICY "Service can insert logs" ON application_logs
  FOR INSERT
  WITH CHECK (true);

-- ============================================
-- 日志清理函数 (保留 30 天)
-- ============================================
CREATE OR REPLACE FUNCTION cleanup_old_logs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM application_logs
  WHERE created_at < now() - interval '30 days';

  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  RETURN deleted_count;
END;
$$;

-- ============================================
-- 日志统计函数
-- ============================================
CREATE OR REPLACE FUNCTION get_log_stats(
  p_start_time timestamptz DEFAULT now() - interval '24 hours',
  p_end_time timestamptz DEFAULT now()
)
RETURNS TABLE (
  category text,
  level text,
  count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    al.category,
    al.level,
    count(*)::bigint
  FROM application_logs al
  WHERE al.created_at BETWEEN p_start_time AND p_end_time
  GROUP BY al.category, al.level
  ORDER BY count(*) DESC;
END;
$$;

-- ============================================
-- 获取错误日志摘要
-- ============================================
CREATE OR REPLACE FUNCTION get_error_summary(
  p_hours integer DEFAULT 24
)
RETURNS TABLE (
  category text,
  message text,
  count bigint,
  first_seen timestamptz,
  last_seen timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    al.category,
    al.message,
    count(*)::bigint,
    min(al.created_at) as first_seen,
    max(al.created_at) as last_seen
  FROM application_logs al
  WHERE al.level IN ('warn', 'error')
    AND al.created_at > now() - (p_hours || ' hours')::interval
  GROUP BY al.category, al.message
  ORDER BY count(*) DESC
  LIMIT 50;
END;
$$;

-- 添加注释
COMMENT ON TABLE application_logs IS '应用日志表 - 存储关键业务日志，用于问题排查和审计';
COMMENT ON FUNCTION cleanup_old_logs() IS '清理 30 天前的旧日志';
COMMENT ON FUNCTION get_log_stats(timestamptz, timestamptz) IS '获取指定时间范围内的日志统计';
COMMENT ON FUNCTION get_error_summary(integer) IS '获取最近 N 小时内的错误日志摘要';
