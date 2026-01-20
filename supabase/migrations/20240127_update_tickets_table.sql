-- 更新工单表添加更多字段
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'other' NOT NULL;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'medium' NOT NULL;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'::jsonb;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL;

-- 更新工单回复表添加管理员标识和附件
ALTER TABLE ticket_replies ADD COLUMN IF NOT EXISTS is_admin TEXT DEFAULT 'false' NOT NULL;
ALTER TABLE ticket_replies ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'::jsonb;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets(category);
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(priority);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_ticket_replies_is_admin ON ticket_replies(is_admin);

-- 添加约束确保category值有效
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_category_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_category_check CHECK (category IN ('bug', 'feature', 'question', 'account', 'billing', 'other'));

-- 添加约束确保priority值有效
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_priority_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_priority_check CHECK (priority IN ('low', 'medium', 'high', 'urgent'));
