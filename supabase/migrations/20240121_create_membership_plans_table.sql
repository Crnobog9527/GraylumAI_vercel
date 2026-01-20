-- Create membership_plans table for managing subscription tiers
CREATE TABLE IF NOT EXISTS membership_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'pro' CHECK (level IN ('free', 'pro', 'gold')),
  monthly_price INTEGER NOT NULL DEFAULT 990, -- In cents
  yearly_price INTEGER NOT NULL DEFAULT 9900, -- In cents
  monthly_credits INTEGER NOT NULL DEFAULT 1500,
  yearly_credits INTEGER NOT NULL DEFAULT 20000,
  monthly_bonus_credits INTEGER NOT NULL DEFAULT 0,
  package_discount INTEGER NOT NULL DEFAULT 100, -- 100 = no discount, 90 = 10% off
  features JSONB NOT NULL DEFAULT '[]'::jsonb, -- Array of feature strings
  is_active TEXT NOT NULL DEFAULT 'true',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Create index on level and sort_order for efficient queries
CREATE INDEX IF NOT EXISTS idx_membership_plans_level ON membership_plans(level);
CREATE INDEX IF NOT EXISTS idx_membership_plans_sort_order ON membership_plans(sort_order);
CREATE INDEX IF NOT EXISTS idx_membership_plans_is_active ON membership_plans(is_active);

-- Enable RLS
ALTER TABLE membership_plans ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Only admins can manage membership plans, everyone can read active plans
CREATE POLICY "Anyone can view active membership plans"
  ON membership_plans FOR SELECT
  USING (is_active = 'true');

CREATE POLICY "Admins can view all membership plans"
  ON membership_plans FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Admins can insert membership plans"
  ON membership_plans FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Admins can update membership plans"
  ON membership_plans FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Admins can delete membership plans"
  ON membership_plans FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

-- Insert default membership plans
INSERT INTO membership_plans (name, level, monthly_price, yearly_price, monthly_credits, yearly_credits, monthly_bonus_credits, package_discount, features, sort_order) VALUES
  ('免费版', 'free', 0, 0, 100, 1200, 0, 100, '["每月100积分", "基础AI模型", "标准响应速度"]'::jsonb, 0),
  ('Pro 专业版', 'pro', 990, 9900, 1500, 20000, 100, 95, '["每月1500积分", "高级AI模型", "优先响应", "专属客服", "5%加油包折扣"]'::jsonb, 1),
  ('Gold 黄金版', 'gold', 1990, 19900, 5000, 70000, 500, 85, '["每月5000积分", "全部AI模型", "最快响应", "专属客服", "15%加油包折扣", "每月500奖励积分"]'::jsonb, 2)
ON CONFLICT DO NOTHING;
