-- Migration: AI 对话计费相关表
-- Version: 0001
-- Date: 2026-01-21
-- Description: 添加 token_stats, billing_history, ai_usage_logs 表及 RLS 策略

-- ============================================
-- 1. 创建表
-- ============================================

-- Token 统计表
CREATE TABLE IF NOT EXISTS token_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  model_used TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  web_search_count INTEGER NOT NULL DEFAULT 0,
  total_cost_usd DECIMAL(12, 6) NOT NULL,
  total_credits INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 计费历史表
CREATE TABLE IF NOT EXISTS billing_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  transaction_id UUID REFERENCES credit_transactions(id) ON DELETE SET NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('pre_deduct', 'settle', 'refund')),
  amount INTEGER NOT NULL,
  reason TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- AI 使用日志表
CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  request_id TEXT,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'timeout', 'rate_limited', 'moderation_blocked')),
  error_message TEXT,
  input_length INTEGER,
  latency_ms INTEGER,
  ip_address TEXT,
  user_agent TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- 2. 创建索引
-- ============================================

-- token_stats 索引
CREATE INDEX IF NOT EXISTS idx_token_stats_user_id ON token_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_token_stats_conversation_id ON token_stats(conversation_id);
CREATE INDEX IF NOT EXISTS idx_token_stats_created_at ON token_stats(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_stats_user_created ON token_stats(user_id, created_at DESC);

-- billing_history 索引
CREATE INDEX IF NOT EXISTS idx_billing_history_user_id ON billing_history(user_id);
CREATE INDEX IF NOT EXISTS idx_billing_history_operation_type ON billing_history(operation_type);
CREATE INDEX IF NOT EXISTS idx_billing_history_created_at ON billing_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_history_user_operation ON billing_history(user_id, operation_type, created_at DESC);

-- ai_usage_logs 索引
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_user_id ON ai_usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_status ON ai_usage_logs(status);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_created_at ON ai_usage_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_user_status ON ai_usage_logs(user_id, status, created_at DESC);

-- ============================================
-- 3. 启用 RLS
-- ============================================

ALTER TABLE token_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_logs ENABLE ROW LEVEL SECURITY;

-- ============================================
-- 4. RLS 策略 - token_stats
-- ============================================

-- 用户只能查看自己的 Token 统计
CREATE POLICY "users_own_token_stats_select"
  ON token_stats
  FOR SELECT
  USING (auth.uid() = user_id);

-- 用户只能插入自己的记录
CREATE POLICY "users_own_token_stats_insert"
  ON token_stats
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 服务端角色可以执行所有操作 (通过 service_role key)
CREATE POLICY "service_role_all_token_stats"
  ON token_stats
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

-- ============================================
-- 5. RLS 策略 - billing_history
-- ============================================

-- 用户只能查看自己的计费历史
CREATE POLICY "users_own_billing_history_select"
  ON billing_history
  FOR SELECT
  USING (auth.uid() = user_id);

-- 用户只能插入自己的记录
CREATE POLICY "users_own_billing_history_insert"
  ON billing_history
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 管理员可以查看所有计费历史
CREATE POLICY "admin_all_billing_history"
  ON billing_history
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

-- ============================================
-- 6. RLS 策略 - ai_usage_logs
-- ============================================

-- 用户只能查看自己的使用日志
CREATE POLICY "users_own_ai_usage_logs_select"
  ON ai_usage_logs
  FOR SELECT
  USING (auth.uid() = user_id);

-- 用户只能插入自己的记录
CREATE POLICY "users_own_ai_usage_logs_insert"
  ON ai_usage_logs
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 管理员可以查看所有使用日志
CREATE POLICY "admin_all_ai_usage_logs"
  ON ai_usage_logs
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

-- ============================================
-- 7. 添加 CHECK 约束 (防止负余额)
-- ============================================

-- 确保 profiles.credits 不能为负
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_credits_non_negative'
  ) THEN
    ALTER TABLE profiles
    ADD CONSTRAINT profiles_credits_non_negative
    CHECK (credits >= 0);
  END IF;
END $$;

-- ============================================
-- 8. 辅助函数
-- ============================================

-- 检查用户是否是管理员的函数
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
    AND role = 'admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 获取用户当前积分余额的函数
CREATE OR REPLACE FUNCTION get_user_credits(p_user_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_credits INTEGER;
BEGIN
  SELECT credits INTO v_credits
  FROM profiles
  WHERE id = p_user_id;

  RETURN COALESCE(v_credits, 0);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 9. 注释
-- ============================================

COMMENT ON TABLE token_stats IS 'AI 对话 Token 使用统计表，记录每次对话的 Token 消耗和成本';
COMMENT ON TABLE billing_history IS '计费历史表，记录预扣、结算、退费等操作';
COMMENT ON TABLE ai_usage_logs IS 'AI 使用日志表，用于调试、安全审计和异常检测';

COMMENT ON COLUMN token_stats.model_used IS '实际使用的模型 ID (如 claude-sonnet-4-20250514)';
COMMENT ON COLUMN token_stats.cached_tokens IS '从缓存读取的 Token 数';
COMMENT ON COLUMN token_stats.cache_creation_tokens IS '写入缓存的 Token 数';
COMMENT ON COLUMN token_stats.total_cost_usd IS '美元成本 (精确到微美元)';
COMMENT ON COLUMN token_stats.total_credits IS '消耗的积分数';

COMMENT ON COLUMN billing_history.operation_type IS '操作类型: pre_deduct=预扣, settle=结算, refund=退费';
COMMENT ON COLUMN billing_history.amount IS '积分变动量 (预扣为负，退费为正)';
COMMENT ON COLUMN billing_history.metadata IS '额外元数据 (如 usage 信息、关联的预扣ID等)';

COMMENT ON COLUMN ai_usage_logs.status IS '请求状态: success, failed, timeout, rate_limited, moderation_blocked';
COMMENT ON COLUMN ai_usage_logs.latency_ms IS '请求延迟 (毫秒)';
