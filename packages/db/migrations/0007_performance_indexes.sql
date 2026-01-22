-- Migration: 0007_performance_indexes.sql
-- Description: Add performance indexes for common query patterns
-- Created: 2026-01-22
-- Note: Safe to run regardless of soft-delete migration status

-- =====================================================
-- CONVERSATIONS TABLE INDEXES
-- =====================================================

-- Index for fetching user's conversations (most common query)
CREATE INDEX IF NOT EXISTS idx_conversations_user_id
ON conversations(user_id);

-- Index for sorting by creation date
CREATE INDEX IF NOT EXISTS idx_conversations_created_at
ON conversations(created_at DESC);

-- Conditional: Composite index for user's active conversations (requires is_deleted column)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'conversations' AND column_name = 'is_deleted') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_conversations_user_active ON conversations(user_id, is_deleted) WHERE is_deleted = ''false''';
  END IF;
END $$;

-- =====================================================
-- MESSAGES TABLE INDEXES
-- =====================================================

-- Index for fetching messages in a conversation (critical for chat)
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
ON messages(conversation_id);

-- Composite index for conversation messages with ordering
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
ON messages(conversation_id, created_at ASC);

-- Conditional: Index for soft delete filtering (requires is_deleted column)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'is_deleted') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_messages_is_deleted ON messages(is_deleted) WHERE is_deleted = ''false''';
  END IF;
END $$;

-- =====================================================
-- TOKEN_STATS TABLE INDEXES
-- =====================================================

-- Index for user's token usage queries
CREATE INDEX IF NOT EXISTS idx_token_stats_user_id
ON token_stats(user_id);

-- Composite index for user cost reports with date range
CREATE INDEX IF NOT EXISTS idx_token_stats_user_created
ON token_stats(user_id, created_at DESC);

-- Index for conversation cost analysis
CREATE INDEX IF NOT EXISTS idx_token_stats_conversation_id
ON token_stats(conversation_id);

-- Index for model usage statistics
CREATE INDEX IF NOT EXISTS idx_token_stats_model_used
ON token_stats(model_used);

-- =====================================================
-- BILLING_HISTORY TABLE INDEXES
-- =====================================================

-- Index for user's billing history
CREATE INDEX IF NOT EXISTS idx_billing_history_user_id
ON billing_history(user_id);

-- Composite index for user billing with date filtering
CREATE INDEX IF NOT EXISTS idx_billing_history_user_created
ON billing_history(user_id, created_at DESC);

-- Index for operation type filtering (pre_deduct, settle, refund)
CREATE INDEX IF NOT EXISTS idx_billing_history_operation_type
ON billing_history(operation_type);

-- =====================================================
-- AI_USAGE_LOGS TABLE INDEXES
-- =====================================================

-- Index for user's AI usage logs
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_user_id
ON ai_usage_logs(user_id);

-- Composite index for user logs with date filtering
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_user_created
ON ai_usage_logs(user_id, created_at DESC);

-- Index for status filtering (success, failed, etc.)
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_status
ON ai_usage_logs(status);

-- Index for request_id lookups (debugging)
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_request_id
ON ai_usage_logs(request_id)
WHERE request_id IS NOT NULL;

-- =====================================================
-- CREDIT_TRANSACTIONS TABLE INDEXES
-- =====================================================

-- Index for user's credit transaction history
CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_id
ON credit_transactions(user_id);

-- Composite index for user transactions with date filtering
CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_created
ON credit_transactions(user_id, created_at DESC);

-- Index for transaction type filtering
CREATE INDEX IF NOT EXISTS idx_credit_transactions_type
ON credit_transactions(type);

-- =====================================================
-- TICKETS TABLE INDEXES
-- =====================================================

-- Index for user's tickets
CREATE INDEX IF NOT EXISTS idx_tickets_user_id
ON tickets(user_id);

-- Index for ticket status filtering (admin dashboard)
CREATE INDEX IF NOT EXISTS idx_tickets_status
ON tickets(status);

-- Index for priority filtering
CREATE INDEX IF NOT EXISTS idx_tickets_priority
ON tickets(priority);

-- Conditional: Composite index for active tickets by user (requires is_deleted column)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tickets' AND column_name = 'is_deleted') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_tickets_user_status ON tickets(user_id, status) WHERE is_deleted = ''false''';
  END IF;
END $$;

-- =====================================================
-- USER_ACTIVITY_LOGS TABLE INDEXES
-- =====================================================

-- Index for user's activity logs
CREATE INDEX IF NOT EXISTS idx_user_activity_logs_user_id
ON user_activity_logs(user_id);

-- Index for admin's actions
CREATE INDEX IF NOT EXISTS idx_user_activity_logs_admin_id
ON user_activity_logs(admin_id)
WHERE admin_id IS NOT NULL;

-- Composite index for user activity with date filtering
CREATE INDEX IF NOT EXISTS idx_user_activity_logs_user_created
ON user_activity_logs(user_id, created_at DESC);

-- Index for action type filtering
CREATE INDEX IF NOT EXISTS idx_user_activity_logs_action_type
ON user_activity_logs(action_type);

-- =====================================================
-- PROFILES TABLE INDEXES
-- =====================================================

-- Index for role-based queries (admin dashboard)
CREATE INDEX IF NOT EXISTS idx_profiles_role
ON profiles(role);

-- Index for membership level queries
CREATE INDEX IF NOT EXISTS idx_profiles_membership_level
ON profiles(membership_level);

-- Conditional: Index for active users (requires is_deleted column)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'is_deleted') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_profiles_active ON profiles(status) WHERE is_deleted = ''false''';
  END IF;
END $$;

-- =====================================================
-- ANNOUNCEMENTS TABLE INDEXES
-- =====================================================

-- Index for announcement type
CREATE INDEX IF NOT EXISTS idx_announcements_type
ON announcements(announcement_type);

-- Conditional: Index for active announcements (requires is_deleted column)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'announcements' AND column_name = 'is_deleted') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(active, priority DESC) WHERE is_deleted = ''false''';
  END IF;
END $$;

-- =====================================================
-- INVITATIONS TABLE INDEXES
-- =====================================================

-- Index for invitation status
CREATE INDEX IF NOT EXISTS idx_invitations_status
ON invitations(status);

-- Index for creator's invitations
CREATE INDEX IF NOT EXISTS idx_invitations_created_by
ON invitations(created_by);

-- =====================================================
-- INVITATION_RECORDS TABLE INDEXES
-- =====================================================

-- Index for inviter's records
CREATE INDEX IF NOT EXISTS idx_invitation_records_inviter_id
ON invitation_records(inviter_id);

-- Index for status filtering
CREATE INDEX IF NOT EXISTS idx_invitation_records_status
ON invitation_records(status);

-- =====================================================
-- APPLICATION_LOGS TABLE INDEXES (if table exists)
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'application_logs') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_application_logs_level ON application_logs(level)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_application_logs_context ON application_logs(context)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_application_logs_created ON application_logs(created_at DESC)';
  END IF;
END $$;

-- =====================================================
-- DIAGNOSTICS_RESULTS TABLE INDEXES (if table exists)
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'diagnostics_results') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_diagnostics_results_batch_id ON diagnostics_results(batch_id)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_diagnostics_results_category ON diagnostics_results(category)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_diagnostics_results_created ON diagnostics_results(created_at DESC)';
  END IF;
END $$;

-- =====================================================
-- ANALYZE TABLES (update statistics for query planner)
-- Only analyze tables that exist
-- =====================================================

DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY['conversations', 'messages', 'token_stats', 'billing_history',
                         'ai_usage_logs', 'credit_transactions', 'tickets',
                         'user_activity_logs', 'profiles', 'announcements',
                         'invitations', 'invitation_records'];
BEGIN
  FOREACH tbl IN ARRAY tables
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = tbl) THEN
      EXECUTE 'ANALYZE ' || tbl;
    END IF;
  END LOOP;
END $$;
