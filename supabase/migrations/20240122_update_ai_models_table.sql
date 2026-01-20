-- Update ai_models table with complete model management fields

-- Add new columns if they don't exist
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS model_id TEXT;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS api_key TEXT;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS api_endpoint TEXT;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS max_tokens INTEGER DEFAULT 4096 NOT NULL;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS input_limit INTEGER DEFAULT 180000 NOT NULL;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS enable_web_search TEXT DEFAULT 'false' NOT NULL;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS input_token_cost INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS output_token_cost INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS input_token_cost_above_200k INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS output_token_cost_above_200k INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS web_search_cost INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS is_active TEXT DEFAULT 'true' NOT NULL;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL;

-- Update existing rows to have default model_id if null
UPDATE ai_models SET model_id = name WHERE model_id IS NULL;

-- Make model_id not null after filling existing rows
-- Note: Run this separately if you want to enforce NOT NULL
-- ALTER TABLE ai_models ALTER COLUMN model_id SET NOT NULL;

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_ai_models_provider ON ai_models(provider);
CREATE INDEX IF NOT EXISTS idx_ai_models_is_active ON ai_models(is_active);

-- Update RLS policies (if not already set)
ALTER TABLE ai_models ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (to avoid conflicts)
DROP POLICY IF EXISTS "Anyone can view active models" ON ai_models;
DROP POLICY IF EXISTS "Admins can view all models" ON ai_models;
DROP POLICY IF EXISTS "Admins can insert models" ON ai_models;
DROP POLICY IF EXISTS "Admins can update models" ON ai_models;
DROP POLICY IF EXISTS "Admins can delete models" ON ai_models;

-- Create new policies
CREATE POLICY "Anyone can view active models"
  ON ai_models FOR SELECT
  USING (is_active = 'true');

CREATE POLICY "Admins can view all models"
  ON ai_models FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Admins can insert models"
  ON ai_models FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Admins can update models"
  ON ai_models FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Admins can delete models"
  ON ai_models FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );
