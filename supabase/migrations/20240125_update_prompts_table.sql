-- Migration: Add missing fields to prompts table
-- Date: 2024-01-25
-- Description: Add system_prompt, user_prompt_template, model_id, platform, features, user_questions, icon fields

-- Add new columns to prompts table
ALTER TABLE prompts ADD COLUMN IF NOT EXISTS system_prompt TEXT;
ALTER TABLE prompts ADD COLUMN IF NOT EXISTS user_prompt_template TEXT;
ALTER TABLE prompts ADD COLUMN IF NOT EXISTS model_id UUID REFERENCES ai_models(id) ON DELETE SET NULL;
ALTER TABLE prompts ADD COLUMN IF NOT EXISTS platform TEXT DEFAULT 'all' CHECK (platform IN ('all', 'web', 'mobile', 'desktop', 'api'));
ALTER TABLE prompts ADD COLUMN IF NOT EXISTS features TEXT; -- JSON array as string
ALTER TABLE prompts ADD COLUMN IF NOT EXISTS user_questions TEXT; -- JSON array as string
ALTER TABLE prompts ADD COLUMN IF NOT EXISTS icon TEXT DEFAULT 'Wand2';

-- Create index for model_id lookup
CREATE INDEX IF NOT EXISTS idx_prompts_model_id ON prompts(model_id);

-- Comment on new columns
COMMENT ON COLUMN prompts.system_prompt IS 'System prompt template for AI';
COMMENT ON COLUMN prompts.user_prompt_template IS 'User prompt template with placeholders';
COMMENT ON COLUMN prompts.model_id IS 'Designated AI model for this prompt';
COMMENT ON COLUMN prompts.platform IS 'Target platform: all, web, mobile, desktop, api';
COMMENT ON COLUMN prompts.features IS 'Module features as JSON array string';
COMMENT ON COLUMN prompts.user_questions IS 'Prepared questions for user as JSON array string';
COMMENT ON COLUMN prompts.icon IS 'Lucide icon name for display';
