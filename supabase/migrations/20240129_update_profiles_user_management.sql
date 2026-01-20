-- 更新用户表添加账号管理相关字段
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active' NOT NULL;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS membership_level TEXT DEFAULT 'free' NOT NULL;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_ip TEXT;

-- 添加约束确保状态值有效
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_status_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_status_check CHECK (status IN ('active', 'disabled', 'banned'));

-- 添加约束确保会员等级有效
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_membership_level_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_membership_level_check CHECK (membership_level IN ('free', 'pro', 'gold'));

-- 创建用户活动日志表
CREATE TABLE IF NOT EXISTS user_activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  admin_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  action_type TEXT NOT NULL DEFAULT 'system',
  details JSONB DEFAULT '{}',
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 为活动日志添加索引
CREATE INDEX IF NOT EXISTS idx_user_activity_logs_user_id ON user_activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_user_activity_logs_admin_id ON user_activity_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_user_activity_logs_created_at ON user_activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_activity_logs_action_type ON user_activity_logs(action_type);

-- 为profiles表状态和会员等级添加索引
CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles(status);
CREATE INDEX IF NOT EXISTS idx_profiles_membership_level ON profiles(membership_level);

-- 启用用户活动日志的RLS
ALTER TABLE user_activity_logs ENABLE ROW LEVEL SECURITY;

-- 创建RLS策略
DROP POLICY IF EXISTS "Admin can read all activity logs" ON user_activity_logs;
CREATE POLICY "Admin can read all activity logs" ON user_activity_logs
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

DROP POLICY IF EXISTS "Admin can insert activity logs" ON user_activity_logs;
CREATE POLICY "Admin can insert activity logs" ON user_activity_logs
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

DROP POLICY IF EXISTS "System can insert activity logs" ON user_activity_logs;
CREATE POLICY "System can insert activity logs" ON user_activity_logs
  FOR INSERT WITH CHECK (true);

-- 更新现有用户的默认值
UPDATE profiles SET status = 'active' WHERE status IS NULL;
UPDATE profiles SET membership_level = 'free' WHERE membership_level IS NULL;
