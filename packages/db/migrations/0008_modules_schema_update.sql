-- Migration: 0008_modules_schema_update.sql
-- Description: Update modules table to align with prompts table structure
-- Date: 2026-01-24
-- Related Issues: P2-7 (modules字段与后台不对应), P2-8 (credits_cost无效字段)

-- =====================================================
-- Step 1: Add missing columns to modules table
-- =====================================================

-- Add model_id column (指定模型)
ALTER TABLE modules
ADD COLUMN IF NOT EXISTS model_id uuid REFERENCES ai_models(id) ON DELETE SET NULL;

-- Add prompt_content column (提示词内容 - 核心)
ALTER TABLE modules
ADD COLUMN IF NOT EXISTS prompt_content text;

-- Add system_prompt column (系统提示词)
ALTER TABLE modules
ADD COLUMN IF NOT EXISTS system_prompt text;

-- Add user_prompt_template column (用户提示词模板)
ALTER TABLE modules
ADD COLUMN IF NOT EXISTS user_prompt_template text;

-- Add preparation_questions column (用户准备问题列表 JSON)
ALTER TABLE modules
ADD COLUMN IF NOT EXISTS preparation_questions text;

-- Add created_by column (创建者)
ALTER TABLE modules
ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES profiles(id) ON DELETE SET NULL;

-- Add updated_at column (更新时间)
ALTER TABLE modules
ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Ensure features column exists (模块特点列表 JSON)
ALTER TABLE modules
ADD COLUMN IF NOT EXISTS features text;

-- Ensure examples column exists (使用示例列表 JSON)
ALTER TABLE modules
ADD COLUMN IF NOT EXISTS examples text;

-- =====================================================
-- Step 2: Remove deprecated credits_cost column
-- (按实际 token 消耗计费，不需要固定积分成本)
-- =====================================================

-- Drop credits_cost column if exists
ALTER TABLE modules
DROP COLUMN IF EXISTS credits_cost;

-- =====================================================
-- Step 3: Create indexes for new columns
-- =====================================================

-- Index for model_id lookups
CREATE INDEX IF NOT EXISTS idx_modules_model_id ON modules(model_id);

-- Index for created_by lookups
CREATE INDEX IF NOT EXISTS idx_modules_created_by ON modules(created_by);

-- =====================================================
-- Step 4: Add RLS policies for new columns
-- =====================================================

-- No additional RLS needed - existing policies cover all columns

-- =====================================================
-- Step 5: Comments
-- =====================================================

COMMENT ON COLUMN modules.model_id IS '指定使用的 AI 模型，为空时使用智能路由';
COMMENT ON COLUMN modules.prompt_content IS '提示词内容，用户消息发送前的预设文本';
COMMENT ON COLUMN modules.system_prompt IS '系统提示词，定义 AI 角色和行为';
COMMENT ON COLUMN modules.user_prompt_template IS '用户提示词模板，使用 {{input}} 占位符';
COMMENT ON COLUMN modules.features IS '模块特点列表，JSON 字符串数组';
COMMENT ON COLUMN modules.examples IS '使用示例列表，JSON 字符串数组';
COMMENT ON COLUMN modules.preparation_questions IS '用户准备问题列表，JSON 字符串数组';

-- =====================================================
-- Migration Complete
-- =====================================================
