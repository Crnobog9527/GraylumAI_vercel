-- Update announcements table with banner support and enhanced fields

-- Add new columns for announcement types and banner support
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS announcement_type TEXT DEFAULT 'homepage' NOT NULL
  CHECK (announcement_type IN ('homepage', 'banner'));
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS banner_style TEXT DEFAULT 'info'
  CHECK (banner_style IN ('info', 'warning', 'success', 'error', 'promo', 'announcement'));
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS banner_link TEXT;

-- Add columns for icons and tags
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS icon TEXT DEFAULT 'Megaphone';
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS icon_color TEXT DEFAULT 'text-blue-500';
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS tag TEXT;
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS tag_color TEXT DEFAULT 'blue';

-- Update type enum to include new types
-- Note: In PostgreSQL, modifying enums requires special handling
-- For now, we'll add a check constraint instead
ALTER TABLE announcements DROP CONSTRAINT IF EXISTS announcements_type_check;
ALTER TABLE announcements ADD CONSTRAINT announcements_type_check
  CHECK (type IN ('info', 'warning', 'success', 'error', 'promo', 'announcement'));

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_announcements_announcement_type ON announcements(announcement_type);
CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(active);
CREATE INDEX IF NOT EXISTS idx_announcements_priority ON announcements(priority DESC);
