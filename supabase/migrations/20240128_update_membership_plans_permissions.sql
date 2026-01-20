-- 更新会员套餐表添加对话历史相关权限字段
ALTER TABLE membership_plans ADD COLUMN IF NOT EXISTS history_retention_days INTEGER DEFAULT 30 NOT NULL;
ALTER TABLE membership_plans ADD COLUMN IF NOT EXISTS allow_export TEXT DEFAULT 'false' NOT NULL;
ALTER TABLE membership_plans ADD COLUMN IF NOT EXISTS allow_batch_export TEXT DEFAULT 'false' NOT NULL;

-- 更新现有记录的默认值
UPDATE membership_plans SET history_retention_days =
  CASE
    WHEN level = 'free' THEN 7
    WHEN level = 'pro' THEN 30
    WHEN level = 'gold' THEN 90
    ELSE 30
  END
WHERE history_retention_days = 30;

UPDATE membership_plans SET allow_export =
  CASE
    WHEN level = 'free' THEN 'false'
    WHEN level = 'pro' THEN 'true'
    WHEN level = 'gold' THEN 'true'
    ELSE 'false'
  END
WHERE allow_export = 'false';

UPDATE membership_plans SET allow_batch_export =
  CASE
    WHEN level = 'free' THEN 'false'
    WHEN level = 'pro' THEN 'false'
    WHEN level = 'gold' THEN 'true'
    ELSE 'false'
  END
WHERE allow_batch_export = 'false';

-- 添加约束
ALTER TABLE membership_plans ADD CONSTRAINT check_history_retention_days CHECK (history_retention_days > 0 AND history_retention_days <= 365);
