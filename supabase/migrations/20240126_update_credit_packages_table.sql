-- Migration: Add missing fields to credit_packages table
-- Date: 2024-01-26
-- Description: Add bonus_credits, sort_order, is_popular fields

-- Add new columns to credit_packages table
ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS bonus_credits INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS is_popular TEXT DEFAULT 'false' NOT NULL CHECK (is_popular IN ('true', 'false'));

-- Create index for sort_order lookup
CREATE INDEX IF NOT EXISTS idx_credit_packages_sort_order ON credit_packages(sort_order);

-- Comment on new columns
COMMENT ON COLUMN credit_packages.bonus_credits IS 'Bonus credits given with purchase';
COMMENT ON COLUMN credit_packages.sort_order IS 'Display order, lower numbers appear first';
COMMENT ON COLUMN credit_packages.is_popular IS 'Whether this package is marked as popular/hot';
