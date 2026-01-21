-- Migration: 为所有用户数据表启用 RLS 策略
-- Version: 0002
-- Date: 2026-01-21
-- Description: 修复 Phase 10 审计发现的 RLS 缺失问题 (P0-2)

-- ============================================
-- 1. 启用 RLS (15 个表)
-- ============================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitation_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE modules ENABLE ROW LEVEL SECURITY;

-- ============================================
-- 2. profiles 表 RLS 策略
-- ============================================

-- 用户可以读取自己的资料
CREATE POLICY "profiles_select_own"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

-- 用户可以更新自己的资料
CREATE POLICY "profiles_update_own"
  ON profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- 管理员可以访问所有资料
CREATE POLICY "profiles_admin_all"
  ON profiles FOR ALL
  USING (is_admin());

-- ============================================
-- 3. conversations 表 RLS 策略
-- ============================================

-- 用户可以读取自己的对话
CREATE POLICY "conversations_select_own"
  ON conversations FOR SELECT
  USING (auth.uid() = user_id);

-- 用户可以创建自己的对话
CREATE POLICY "conversations_insert_own"
  ON conversations FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 用户可以更新自己的对话
CREATE POLICY "conversations_update_own"
  ON conversations FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 用户可以删除自己的对话
CREATE POLICY "conversations_delete_own"
  ON conversations FOR DELETE
  USING (auth.uid() = user_id);

-- 管理员可以读取所有对话
CREATE POLICY "conversations_admin_select"
  ON conversations FOR SELECT
  USING (is_admin());

-- ============================================
-- 4. messages 表 RLS 策略
-- ============================================

-- 用户可以读取自己对话中的消息
CREATE POLICY "messages_select_own"
  ON messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM conversations
      WHERE conversations.id = messages.conversation_id
      AND conversations.user_id = auth.uid()
    )
  );

-- 用户可以在自己的对话中创建消息
CREATE POLICY "messages_insert_own"
  ON messages FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM conversations
      WHERE conversations.id = messages.conversation_id
      AND conversations.user_id = auth.uid()
    )
  );

-- 用户可以删除自己对话中的消息
CREATE POLICY "messages_delete_own"
  ON messages FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM conversations
      WHERE conversations.id = messages.conversation_id
      AND conversations.user_id = auth.uid()
    )
  );

-- 管理员可以读取所有消息
CREATE POLICY "messages_admin_select"
  ON messages FOR SELECT
  USING (is_admin());

-- ============================================
-- 5. credit_transactions 表 RLS 策略
-- ============================================

-- 用户可以读取自己的积分交易记录
CREATE POLICY "credit_transactions_select_own"
  ON credit_transactions FOR SELECT
  USING (auth.uid() = user_id);

-- 系统可以为用户插入记录 (通过 service_role)
CREATE POLICY "credit_transactions_insert_service"
  ON credit_transactions FOR INSERT
  WITH CHECK (auth.uid() = user_id OR is_admin());

-- 管理员可以访问所有记录
CREATE POLICY "credit_transactions_admin_all"
  ON credit_transactions FOR ALL
  USING (is_admin());

-- ============================================
-- 6. ai_models 表 RLS 策略
-- ============================================

-- 所有认证用户可以读取启用的模型
CREATE POLICY "ai_models_select_active"
  ON ai_models FOR SELECT
  USING (is_active = true OR is_admin());

-- 管理员可以管理所有模型
CREATE POLICY "ai_models_admin_all"
  ON ai_models FOR ALL
  USING (is_admin());

-- ============================================
-- 7. system_settings 表 RLS 策略
-- ============================================

-- 所有认证用户可以读取设置
CREATE POLICY "system_settings_select_all"
  ON system_settings FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- 只有管理员可以修改设置
CREATE POLICY "system_settings_admin_all"
  ON system_settings FOR ALL
  USING (is_admin());

-- ============================================
-- 8. tickets 表 RLS 策略
-- ============================================

-- 用户可以读取自己的工单
CREATE POLICY "tickets_select_own"
  ON tickets FOR SELECT
  USING (auth.uid() = user_id);

-- 用户可以创建自己的工单
CREATE POLICY "tickets_insert_own"
  ON tickets FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 用户可以更新自己的工单
CREATE POLICY "tickets_update_own"
  ON tickets FOR UPDATE
  USING (auth.uid() = user_id);

-- 管理员可以访问所有工单
CREATE POLICY "tickets_admin_all"
  ON tickets FOR ALL
  USING (is_admin());

-- ============================================
-- 9. ticket_replies 表 RLS 策略
-- ============================================

-- 用户可以读取自己工单的回复
CREATE POLICY "ticket_replies_select_own"
  ON ticket_replies FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM tickets
      WHERE tickets.id = ticket_replies.ticket_id
      AND tickets.user_id = auth.uid()
    )
  );

-- 用户可以在自己的工单中添加回复
CREATE POLICY "ticket_replies_insert_own"
  ON ticket_replies FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM tickets
      WHERE tickets.id = ticket_replies.ticket_id
      AND tickets.user_id = auth.uid()
    )
    OR is_admin()
  );

-- 管理员可以访问所有回复
CREATE POLICY "ticket_replies_admin_all"
  ON ticket_replies FOR ALL
  USING (is_admin());

-- ============================================
-- 10. credit_packages 表 RLS 策略
-- ============================================

-- 所有认证用户可以读取启用的积分包
CREATE POLICY "credit_packages_select_active"
  ON credit_packages FOR SELECT
  USING (is_active = true OR is_admin());

-- 管理员可以管理所有积分包
CREATE POLICY "credit_packages_admin_all"
  ON credit_packages FOR ALL
  USING (is_admin());

-- ============================================
-- 11. invitations 表 RLS 策略
-- ============================================

-- 用户可以读取自己创建的邀请码
CREATE POLICY "invitations_select_own"
  ON invitations FOR SELECT
  USING (auth.uid() = created_by);

-- 用户可以创建邀请码
CREATE POLICY "invitations_insert_own"
  ON invitations FOR INSERT
  WITH CHECK (auth.uid() = created_by);

-- 管理员可以访问所有邀请码
CREATE POLICY "invitations_admin_all"
  ON invitations FOR ALL
  USING (is_admin());

-- ============================================
-- 12. user_activity_logs 表 RLS 策略
-- ============================================

-- 用户可以读取自己的活动日志
CREATE POLICY "user_activity_logs_select_own"
  ON user_activity_logs FOR SELECT
  USING (auth.uid() = user_id);

-- 系统可以插入活动日志
CREATE POLICY "user_activity_logs_insert_service"
  ON user_activity_logs FOR INSERT
  WITH CHECK (auth.uid() = user_id OR is_admin());

-- 管理员可以访问所有活动日志
CREATE POLICY "user_activity_logs_admin_all"
  ON user_activity_logs FOR ALL
  USING (is_admin());

-- ============================================
-- 13. announcements 表 RLS 策略
-- ============================================

-- 所有认证用户可以读取激活的公告
CREATE POLICY "announcements_select_active"
  ON announcements FOR SELECT
  USING (is_active = true OR is_admin());

-- 管理员可以管理所有公告
CREATE POLICY "announcements_admin_all"
  ON announcements FOR ALL
  USING (is_admin());

-- ============================================
-- 14. prompts 表 RLS 策略
-- ============================================

-- 所有认证用户可以读取激活的提示词
CREATE POLICY "prompts_select_active"
  ON prompts FOR SELECT
  USING (active = true OR is_admin());

-- 管理员可以管理所有提示词
CREATE POLICY "prompts_admin_all"
  ON prompts FOR ALL
  USING (is_admin());

-- ============================================
-- 15. invitation_records 表 RLS 策略
-- ============================================

-- 用户可以读取自己的邀请记录 (作为邀请人或被邀请人)
CREATE POLICY "invitation_records_select_own"
  ON invitation_records FOR SELECT
  USING (
    auth.uid() = inviter_id OR auth.uid() = invitee_id
  );

-- 管理员可以访问所有邀请记录
CREATE POLICY "invitation_records_admin_all"
  ON invitation_records FOR ALL
  USING (is_admin());

-- ============================================
-- 16. membership_plans 表 RLS 策略
-- ============================================

-- 所有认证用户可以读取会员计划
CREATE POLICY "membership_plans_select_all"
  ON membership_plans FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- 管理员可以管理所有会员计划
CREATE POLICY "membership_plans_admin_all"
  ON membership_plans FOR ALL
  USING (is_admin());

-- ============================================
-- 17. modules 表 RLS 策略
-- ============================================

-- 所有认证用户可以读取激活的模块
CREATE POLICY "modules_select_active"
  ON modules FOR SELECT
  USING (active = true OR is_admin());

-- 管理员可以管理所有模块
CREATE POLICY "modules_admin_all"
  ON modules FOR ALL
  USING (is_admin());

-- ============================================
-- 18. 注释说明
-- ============================================

COMMENT ON POLICY "profiles_select_own" ON profiles IS '用户只能读取自己的资料';
COMMENT ON POLICY "conversations_select_own" ON conversations IS '用户只能读取自己的对话';
COMMENT ON POLICY "messages_select_own" ON messages IS '用户只能读取自己对话中的消息';
COMMENT ON POLICY "credit_transactions_select_own" ON credit_transactions IS '用户只能读取自己的积分交易';
COMMENT ON POLICY "ai_models_select_active" ON ai_models IS '所有用户可读取启用的模型';
COMMENT ON POLICY "system_settings_select_all" ON system_settings IS '所有认证用户可读取系统设置';
COMMENT ON POLICY "tickets_select_own" ON tickets IS '用户只能读取自己的工单';
COMMENT ON POLICY "ticket_replies_select_own" ON ticket_replies IS '用户只能读取自己工单的回复';
