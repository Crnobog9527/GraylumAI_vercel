-- Migration: 0009_context_length_limit.sql
-- Description: Add max_context_messages field to membership_plans table
-- Date: 2026-01-24
-- Related Issue: P2-15 (上下文长度限制未实现)

-- =====================================================
-- Step 1: Add max_context_messages column to membership_plans
-- =====================================================

-- 每个会员等级的最大上下文消息数（对话历史条数）
-- free: 10 条 (5轮对话)
-- pro: 30 条 (15轮对话)
-- gold: 50 条 (25轮对话)
ALTER TABLE membership_plans
ADD COLUMN IF NOT EXISTS max_context_messages integer DEFAULT 20 NOT NULL;

-- =====================================================
-- Step 2: Update default values by membership level
-- =====================================================

-- 更新 free 等级的上下文限制
UPDATE membership_plans
SET max_context_messages = 10
WHERE level = 'free';

-- 更新 pro 等级的上下文限制
UPDATE membership_plans
SET max_context_messages = 30
WHERE level = 'pro';

-- 更新 gold 等级的上下文限制
UPDATE membership_plans
SET max_context_messages = 50
WHERE level = 'gold';

-- =====================================================
-- Step 3: Add comment
-- =====================================================

COMMENT ON COLUMN membership_plans.max_context_messages IS '最大上下文消息数（对话历史条数），限制每次 AI 请求携带的历史消息数量';

-- =====================================================
-- Migration Complete
-- =====================================================
