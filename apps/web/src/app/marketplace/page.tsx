'use client';

import { useState, useMemo } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { AppHeader } from '@/components/layout/AppHeader';
import FeaturedModules from '@/components/marketplace/FeaturedModules';
import ModuleCard from '@/components/modules/ModuleCard';

const categories = [
  { id: 'all', label: '全部功能' },
  { id: 'writing', label: '内容创作' },
  { id: 'marketing', label: '营销文案' },
  { id: 'video', label: '视频制作' },
  { id: 'business', label: '商务办公' },
  { id: 'education', label: '教育学习' },
  { id: 'other', label: '其他分类' }
];

// TODO: 从 tRPC 获取模块数据
const mockModules = [
  {
    id: '1',
    title: 'S级直播带货话术专家',
    description: '一键生成 S 级直播带货话术，可原创可仿写，省去 90% 写话术的时间，再也不...',
    icon: 'Zap',
    category: 'marketing',
    platform: '抖音、TikTok',
    usage_count: 1200
  },
  {
    id: '2',
    title: '小红书爆款文案仿写专家',
    description: '上传想要仿写的文案以及想要表达的主旨，1 分钟一键复刻爆款结构！',
    icon: 'PenTool',
    category: 'writing',
    platform: '小红书',
    usage_count: 890
  },
  {
    id: '3',
    title: 'Tiktok爆款短视频口播稿创作专家',
    description: '一键生成专业的视频口播稿，支持多种风格和时长',
    icon: 'Video',
    category: 'video',
    platform: '抖音、TIKTOK',
    usage_count: 1950
  },
  {
    id: '4',
    title: '爆款脚本创作专家',
    description: '这是专为自媒体创作者打造的视频爆款脚本创作专家，针对AI创作常见的文案呆...',
    icon: 'Video',
    category: 'video',
    platform: '通用',
    usage_count: 1800
  },
  {
    id: '5',
    title: 'Youtube口播稿创作专家',
    description: '根据你的选题与主旨，一键生成定制化的中长视频口播稿，并且会自动控制信息...',
    icon: 'Video',
    category: 'video',
    platform: 'Youtube、B站',
    usage_count: 620
  },
  {
    id: '6',
    title: '账号商业策略分析专家',
    description: '一键战略分析你的社交媒体赛道定位与差异化竞争力，并提供定制化建议。',
    icon: 'Sparkles',
    category: 'marketing',
    platform: '通用',
    usage_count: 5400
  },
  {
    id: '7',
    title: '传统宣传片策划方案专家',
    description: '通过用户上传的资料，自动产出传统宣传片、汇报片、主题片等类型影片的文案...',
    icon: 'MessageSquare',
    category: 'video',
    platform: '传统宣传片、主题片、汇报片等',
    usage_count: 320
  },
  {
    id: '8',
    title: '活动拍摄脚本创作大师',
    description: '通过用户上传的活动资料以及拍摄配置资源，自动产出专业级的配音文案、拍摄...',
    icon: 'Lightbulb',
    category: 'video',
    platform: '通用',
    usage_count: 180
  }
];

// TODO: 从 tRPC 获取精选模块
const mockFeaturedModules = [
  {
    id: 'f1',
    title: '社交媒体账号定位分析',
    description: '你是否想要开启社交媒体的副业，但是非常迷惘不知道从何开始？立即咨询我们的超级 AI，获取孵化了全网超过 1000 万粉丝账号的同款商业分析！',
    icon: '💬',
    image_url: 'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=800&q=80',
    badge_type: 'recommend' as const,
    badge_text: '账号定位、商业变现分析',
    credits_display: '进阶会员',
    usage_count: 0
  },
  {
    id: 'f2',
    title: 'Tiktok爆款短视频口播稿创作专家',
    description: '一键生成专业的视频口播稿，支持多种风格和时长。',
    icon: '🎵',
    image_url: 'https://images.unsplash.com/photo-1611162616475-46b635cb6868?w=800&q=80',
    badge_type: 'hot' as const,
    badge_text: '热门',
    credits_display: '免费试用',
    usage_count: 0
  }
];

export default function MarketplacePage() {
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [sortOrder, setSortOrder] = useState('newest');
  const [page, setPage] = useState(1);
  const itemsPerPage = 12;

  const filteredModules = useMemo(() => {
    return mockModules.filter((module) => {
      if (selectedCategory === 'all') return true;
      if (selectedCategory === 'other') {
        return ['tool', 'analysis', 'coding', 'creative', 'audio'].includes(module.category);
      }
      return module.category === selectedCategory;
    });
  }, [selectedCategory]);

  const totalPages = Math.ceil(filteredModules.length / itemsPerPage);
  const displayedModules = filteredModules.slice((page - 1) * itemsPerPage, page * itemsPerPage);

  return (
    <div
      className="min-h-screen relative overflow-hidden"
      style={{ background: 'var(--bg-primary)' }}
    >
      {/* ============================================
          动态背景系统 - 功能市场专属设计
          ============================================ */}

      {/* 1. 深邃渐变基底 */}
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(ellipse 120% 80% at 50% 0%, rgba(30,25,40,1) 0%, var(--bg-primary) 50%, rgba(15,15,20,1) 100%)`
        }}
      />

      {/* 2. 顶部中央 - 主金色光源 */}
      <div
        className="absolute -top-20 left-1/2 -translate-x-1/2 w-[800px] h-[500px] rounded-full opacity-70 blur-[120px]"
        style={{
          background: `radial-gradient(circle, var(--color-primary) 0%, rgba(255,180,0,0.5) 40%, transparent 70%)`,
          willChange: 'transform, opacity',
          contain: 'layout paint'
        }}
      />

      {/* 3. 左下角 - 紫色/蓝色渐变光晕 */}
      <div
        className="absolute bottom-0 -left-32 w-[600px] h-[600px] rounded-full opacity-50 blur-[110px]"
        style={{
          background: `linear-gradient(45deg, rgba(99,102,241,0.8) 0%, rgba(139,92,246,0.6) 50%, transparent 100%)`,
          willChange: 'transform',
          contain: 'layout paint'
        }}
      />

      {/* 4. 右下角 - 青绿色光晕 */}
      <div
        className="absolute -bottom-20 -right-20 w-[500px] h-[500px] rounded-full opacity-45 blur-[100px]"
        style={{
          background: `radial-gradient(circle, rgba(34,197,94,0.7) 0%, rgba(20,184,166,0.5) 50%, transparent 80%)`,
          willChange: 'transform, opacity',
          contain: 'layout paint'
        }}
      />

      {/* 5. 中部偏右 - 橙色点缀 */}
      <div
        className="absolute top-1/2 right-1/4 w-[400px] h-[400px] rounded-full opacity-35 blur-[90px]"
        style={{
          background: `radial-gradient(circle, var(--color-secondary) 0%, transparent 60%)`,
          willChange: 'transform, opacity',
          contain: 'layout paint'
        }}
      />

      {/* 6. 斜向网格纹理 */}
      <div
        className="absolute inset-0 opacity-[0.02]"
        style={{
          backgroundImage: `linear-gradient(30deg, rgba(255,215,0,0.15) 1px, transparent 1px), linear-gradient(-30deg, rgba(255,215,0,0.15) 1px, transparent 1px)`,
          backgroundSize: '60px 60px',
          contain: 'layout paint'
        }}
      />

      {/* 7. 边缘渐隐遮罩 */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse 100% 90% at 50% 30%, transparent 40%, rgba(0,0,0,0.15) 65%, rgba(0,0,0,0.35) 85%, rgba(0,0,0,0.5) 100%)'
        }}
      />

      {/* 动画样式定义 */}
      <style>{`
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(30px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .module-card-animate {
          animation: fadeInUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
          will-change: transform, opacity;
        }
        .animate-slideUp {
          animation: slideUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
          opacity: 0;
          will-change: transform, opacity;
        }
        .animate-fadeIn {
          animation: fadeIn 0.6s ease forwards;
          will-change: opacity;
        }
        .no-scrollbar::-webkit-scrollbar {
          display: none;
        }
        .no-scrollbar {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
      `}</style>

      {/* 顶部导航 */}
      <AppHeader />

      <div className="container mx-auto px-4 py-8 max-w-7xl relative" style={{ zIndex: 1 }}>
        {/* 页面标题 */}
        <div className="text-center mb-12 pt-4">
          <div
            className="inline-flex items-center gap-2 mb-6 animate-fadeIn"
            style={{
              background: 'linear-gradient(135deg, rgba(255,215,0,0.1) 0%, rgba(255,180,0,0.05) 100%)',
              border: '1px solid rgba(255,215,0,0.2)',
              borderRadius: 'var(--radius-full)',
              padding: '8px 16px',
              backdropFilter: 'blur(10px)'
            }}
          >
            <Sparkles className="h-4 w-4" style={{ color: 'var(--color-primary)' }} />
            <span
              className="uppercase tracking-widest font-semibold"
              style={{ fontSize: '11px', color: 'var(--color-primary)' }}
            >
              AI TOOLS MARKETPLACE
            </span>
          </div>
          <h1
            className="text-4xl md:text-5xl lg:text-6xl font-bold mb-4 animate-slideUp"
            style={{
              background: 'linear-gradient(135deg, var(--text-primary) 0%, var(--color-primary) 50%, var(--color-secondary) 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text'
            }}
          >
            功能广场
          </h1>
          <p
            className="text-lg md:text-xl max-w-2xl mx-auto animate-slideUp"
            style={{
              color: 'var(--text-secondary)',
              lineHeight: 1.6,
              animationDelay: '0.1s'
            }}
          >
            探索强大的 AI 工具集合，一键解锁无限创作可能
          </p>
        </div>

        {/* 精选推荐 */}
        <FeaturedModules featuredModules={mockFeaturedModules} />

        {/* 筛选栏 */}
        <div
          className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-10 sticky top-16 z-40 backdrop-blur-xl py-4 px-6 rounded-2xl animate-slideUp"
          style={{
            background: 'linear-gradient(135deg, rgba(30,30,35,0.9) 0%, rgba(20,20,25,0.95) 100%)',
            border: '1px solid rgba(255,215,0,0.1)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.05)',
            animationDelay: '0.2s'
          }}
        >
          <div className="flex items-center gap-2 overflow-x-auto pb-2 md:pb-0 no-scrollbar">
            {categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => { setSelectedCategory(cat.id); setPage(1); }}
                className="px-5 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all duration-300 hover:scale-105"
                style={{
                  background: selectedCategory === cat.id
                    ? 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)'
                    : 'rgba(255,255,255,0.03)',
                  color: selectedCategory === cat.id ? 'var(--bg-primary)' : 'var(--text-secondary)',
                  border: selectedCategory === cat.id ? 'none' : '1px solid rgba(255,255,255,0.08)',
                  boxShadow: selectedCategory === cat.id
                    ? '0 4px 20px rgba(255, 215, 0, 0.3), inset 0 1px 0 rgba(255,255,255,0.2)'
                    : 'none',
                  fontWeight: selectedCategory === cat.id ? 600 : 500
                }}
              >
                {cat.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs hidden md:block" style={{ color: 'var(--text-disabled)' }}>
              共 {filteredModules.length} 个工具
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="rounded-xl h-10 text-sm font-medium transition-all duration-300 hover:scale-105"
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    borderColor: 'rgba(255,255,255,0.08)',
                    color: 'var(--text-secondary)'
                  }}
                >
                  {sortOrder === 'newest' ? '🕐 最新上线' : '🔥 最受欢迎'}
                  <ChevronDown className="h-4 w-4 ml-2" style={{ color: 'var(--text-tertiary)' }} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="rounded-xl"
                style={{
                  background: 'var(--bg-secondary)',
                  borderColor: 'var(--border-primary)'
                }}
              >
                <DropdownMenuItem
                  onClick={() => setSortOrder('newest')}
                  className="rounded-lg"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  🕐 最新上线
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setSortOrder('popular')}
                  className="rounded-lg"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  🔥 最受欢迎
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* 模块卡片网格 */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5 mb-12">
          {displayedModules.map((module, index) => (
            <div
              key={module.id}
              className="module-card-animate"
              style={{ animationDelay: `${index * 0.06}s`, opacity: 0 }}
            >
              <ModuleCard
                module={module}
                onShowDetail={() => {
                  // TODO: 实现详情弹窗
                  console.log('Show detail:', module);
                }}
              />
            </div>
          ))}
        </div>

        {/* 空状态 */}
        {filteredModules.length === 0 && (
          <div
            className="text-center py-24 rounded-3xl"
            style={{
              background: 'linear-gradient(135deg, rgba(30,30,35,0.5) 0%, rgba(20,20,25,0.5) 100%)',
              border: '1px solid var(--border-primary)'
            }}
          >
            <div
              className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4"
              style={{ background: 'rgba(255,215,0,0.1)', border: '1px solid rgba(255,215,0,0.2)' }}
            >
              <Sparkles className="h-8 w-8" style={{ color: 'var(--color-primary)' }} />
            </div>
            <p className="text-lg font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
              未找到相关功能
            </p>
            <p className="text-sm" style={{ color: 'var(--text-disabled)' }}>
              尝试选择其他分类或调整筛选条件
            </p>
          </div>
        )}

        {/* 分页 */}
        {totalPages > 1 && (
          <div
            className="flex items-center justify-center gap-3 py-6 px-8 rounded-2xl mx-auto max-w-fit"
            style={{
              background: 'linear-gradient(135deg, rgba(30,30,35,0.8) 0%, rgba(20,20,25,0.9) 100%)',
              border: '1px solid rgba(255,215,0,0.1)',
              boxShadow: '0 8px 32px rgba(0,0,0,0.2)'
            }}
          >
            <Button
              variant="outline"
              size="icon"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="h-10 w-10 rounded-xl transition-all duration-300 hover:scale-110 disabled:opacity-30"
              style={{
                background: 'rgba(255,255,255,0.03)',
                borderColor: 'rgba(255,255,255,0.08)',
                color: 'var(--text-secondary)'
              }}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>

            <div className="flex items-center gap-2">
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <Button
                  key={p}
                  variant={page === p ? 'default' : 'outline'}
                  onClick={() => setPage(p)}
                  className="h-10 w-10 rounded-xl transition-all duration-300 hover:scale-110"
                  style={{
                    background: page === p
                      ? 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)'
                      : 'rgba(255,255,255,0.03)',
                    borderColor: page === p ? 'transparent' : 'rgba(255,255,255,0.08)',
                    color: page === p ? 'var(--bg-primary)' : 'var(--text-secondary)',
                    boxShadow: page === p ? '0 4px 20px rgba(255, 215, 0, 0.3)' : 'none',
                    fontWeight: page === p ? 700 : 500
                  }}
                >
                  {p}
                </Button>
              ))}
            </div>

            <Button
              variant="outline"
              size="icon"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="h-10 w-10 rounded-xl transition-all duration-300 hover:scale-110 disabled:opacity-30"
              style={{
                background: 'rgba(255,255,255,0.03)',
                borderColor: 'rgba(255,255,255,0.08)',
                color: 'var(--text-secondary)'
              }}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>

            <div className="h-6 w-px mx-2" style={{ background: 'var(--border-primary)' }} />

            <span className="text-sm font-medium" style={{ color: 'var(--text-tertiary)' }}>
              第 <span style={{ color: 'var(--color-primary)' }}>{page}</span> / {totalPages} 页
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
