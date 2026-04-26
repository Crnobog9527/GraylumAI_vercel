-- Migration: 0020_admin_query_indexes.sql
-- Description: Add indexes for remaining admin dashboards, filters, and invitation risk checks
-- Created: 2026-03-29

-- =====================================================
-- PROFILES
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_profiles_created_at
ON profiles(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_profiles_status_created_at
ON profiles(status, created_at DESC);

-- =====================================================
-- TICKETS
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_tickets_created_at
ON tickets(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tickets_status_created_at
ON tickets(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tickets_category_created_at
ON tickets(category, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tickets_priority_created_at
ON tickets(priority, created_at DESC);

-- =====================================================
-- CREDIT_TRANSACTIONS
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_credit_transactions_created_at
ON credit_transactions(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_type_created_at
ON credit_transactions(user_id, type, created_at DESC);

-- =====================================================
-- ANNOUNCEMENTS
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_announcements_active_priority_created_at
ON announcements(active, priority DESC, created_at DESC);

-- =====================================================
-- PROMPTS
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_prompts_active_sort_created_at
ON prompts(active, sort_order DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prompts_category_active_sort_created_at
ON prompts(category, active, sort_order DESC, created_at DESC);

-- =====================================================
-- INVITATION_RECORDS
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_invitation_records_created_at
ON invitation_records(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invitation_records_risk_level_created_at
ON invitation_records(risk_level, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invitation_records_ip_address_created_at
ON invitation_records(ip_address, created_at DESC)
WHERE ip_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invitation_records_status_created_at
ON invitation_records(status, created_at DESC);

-- =====================================================
-- AI_MODELS
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_ai_models_is_active
ON ai_models(is_active);

CREATE INDEX IF NOT EXISTS idx_ai_models_name
ON ai_models(name);
