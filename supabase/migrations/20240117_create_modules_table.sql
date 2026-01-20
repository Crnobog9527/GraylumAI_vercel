-- Migration: Create modules table
-- Date: 2024-01-17
-- Description: Table for AI tool modules in the marketplace

-- ============================================
-- 1. MODULES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS modules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  icon TEXT DEFAULT 'Sparkles',
  category TEXT NOT NULL DEFAULT 'other',
  platform TEXT,
  usage_count INTEGER DEFAULT 0,
  credits_cost INTEGER DEFAULT 1,
  is_featured BOOLEAN DEFAULT false,
  image_url TEXT,
  badge_type TEXT,  -- 'hot', 'new', 'recommend'
  badge_text TEXT,
  credits_display TEXT,
  active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_modules_category ON modules(category);
CREATE INDEX IF NOT EXISTS idx_modules_active ON modules(active);
CREATE INDEX IF NOT EXISTS idx_modules_is_featured ON modules(is_featured);
CREATE INDEX IF NOT EXISTS idx_modules_usage_count ON modules(usage_count DESC);
CREATE INDEX IF NOT EXISTS idx_modules_sort_order ON modules(sort_order);
CREATE INDEX IF NOT EXISTS idx_modules_created_at ON modules(created_at DESC);

-- Enable RLS
ALTER TABLE modules ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated users to read modules
CREATE POLICY "Allow read access to modules" ON modules
  FOR SELECT USING (active = true);

-- ============================================
-- 2. SEED DATA (Optional initial modules)
-- ============================================
INSERT INTO modules (title, description, icon, category, platform, usage_count, is_featured, image_url, badge_type, badge_text, credits_display) VALUES
('S级直播带货话术专家', '一键生成 S 级直播带货话术，可原创可仿写，省去 90% 写话术的时间。', 'Zap', 'marketing', '抖音、TikTok', 1200, false, null, null, null, null),
('小红书爆款文案仿写专家', '上传想要仿写的文案以及想要表达的主旨，1 分钟一键复刻爆款结构！', 'PenTool', 'writing', '小红书', 890, false, null, null, null, null),
('Tiktok爆款短视频口播稿创作专家', '一键生成专业的视频口播稿，支持多种风格和时长', 'Video', 'video', '抖音、TIKTOK', 1950, true, 'https://images.unsplash.com/photo-1611162616475-46b635cb6868?w=800&q=80', 'hot', '热门', '免费试用'),
('爆款脚本创作专家', '这是专为自媒体创作者打造的视频爆款脚本创作专家', 'Video', 'video', '通用', 1800, false, null, null, null, null),
('Youtube口播稿创作专家', '根据你的选题与主旨，一键生成定制化的中长视频口播稿', 'Video', 'video', 'Youtube、B站', 620, false, null, null, null, null),
('账号商业策略分析专家', '一键战略分析你的社交媒体赛道定位与差异化竞争力，并提供定制化建议。', 'Sparkles', 'marketing', '通用', 5400, true, 'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=800&q=80', 'recommend', '账号定位、商业变现分析', '进阶会员'),
('传统宣传片策划方案专家', '通过用户上传的资料，自动产出传统宣传片、汇报片、主题片等类型影片的文案', 'MessageSquare', 'video', '传统宣传片、主题片、汇报片等', 320, false, null, null, null, null),
('活动拍摄脚本创作大师', '通过用户上传的活动资料以及拍摄配置资源，自动产出专业级的配音文案、拍摄脚本', 'Lightbulb', 'video', '通用', 180, false, null, null, null, null);

-- ============================================
-- DONE
-- ============================================
