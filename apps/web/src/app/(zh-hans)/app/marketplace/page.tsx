'use client';

import { Suspense, useEffect, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Sparkles, Loader2 } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { AppHeader } from '@/components/layout/AppHeader';
import GlobalBanner from '@/components/layout/GlobalBanner';
import FeaturedModules from '@/components/marketplace/FeaturedModules';
import ModuleCard from '@/components/modules/ModuleCard';
import ModuleDetailDialog from '@/components/modules/ModuleDetailDialog';
import { trpc } from '@/trpc/client';
import { useBanner } from '@/hooks/use-banner';

// Module type for detail dialog
interface ModuleData {
  id: string;
  title: string;
  description: string;
  icon?: string;
  category?: string;
  platform?: string;
  usage_count?: number;
}

const categories = [
  { id: 'all', label: '全部功能' },
  { id: 'writing', label: '内容创作' },
  { id: 'marketing', label: '营销文案' },
  { id: 'video', label: '视频制作' },
  { id: 'business', label: '商务办公' },
  { id: 'education', label: '教育学习' },
  { id: 'coding', label: '编程开发' },
  { id: 'analysis', label: '分析洞察' },
  { id: 'creative', label: '创意策划' },
  { id: 'other', label: '其他分类' }
];

function MarketplacePageContent() {
  const searchParams = useSearchParams();
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [sortOrder, setSortOrder] = useState<'newest' | 'popular'>('newest');
  const [page, setPage] = useState(1);
  const [selectedModule, setSelectedModule] = useState<ModuleData | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const itemsPerPage = 12;
  const { banners } = useBanner();

  // Fetch modules from tRPC
  const { data: modulesData, isLoading: isModulesLoading } = trpc.modules.getModules.useQuery({
    category: selectedCategory,
    limit: itemsPerPage,
    offset: (page - 1) * itemsPerPage,
    sortBy: sortOrder,
  });

  // Fetch featured modules from tRPC
  const { data: featuredModules, isLoading: isFeaturedLoading } = trpc.modules.getFeaturedModules.useQuery({
    limit: 4,
  });

  const isLoading = isModulesLoading || isFeaturedLoading;
  const modules = modulesData?.modules ?? [];
  const totalModules = modulesData?.total ?? 0;
  const totalPages = Math.ceil(totalModules / itemsPerPage);
  const requestedModuleId = searchParams.get('module');

  useEffect(() => {
    if (!requestedModuleId) {
      return;
    }

    const requestedModule =
      modules.find((module) => module.id === requestedModuleId) ??
      featuredModules?.find((module) => module.id === requestedModuleId);

    if (!requestedModule) {
      return;
    }

    setSelectedModule({
      id: requestedModule.id,
      title: requestedModule.title,
      description: requestedModule.description ?? '',
      icon: requestedModule.icon ?? 'Sparkles',
      category: requestedModule.category,
      platform: requestedModule.platform ?? '',
      usage_count: requestedModule.usage_count ?? 0,
    });
    setDialogOpen(true);
  }, [featuredModules, modules, requestedModuleId]);

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
        className="absolute -top-12 left-1/2 -translate-x-1/2 h-[240px] w-[320px] rounded-full opacity-35 blur-[64px] md:-top-16 md:h-[420px] md:w-[680px] md:opacity-55 md:blur-[96px]"
        style={{
          background: `radial-gradient(circle, var(--color-primary) 0%, rgba(255,180,0,0.5) 40%, transparent 70%)`,
          willChange: 'transform, opacity',
          contain: 'layout paint'
        }}
      />

      {/* 3. 左下角 - 紫色/蓝色渐变光晕 */}
      <div
        className="absolute -left-16 bottom-0 h-[220px] w-[220px] rounded-full opacity-24 blur-[56px] md:-left-24 md:h-[480px] md:w-[480px] md:opacity-40 md:blur-[88px]"
        style={{
          background: `linear-gradient(45deg, rgba(99,102,241,0.8) 0%, rgba(139,92,246,0.6) 50%, transparent 100%)`,
          willChange: 'transform',
          contain: 'layout paint'
        }}
      />

      {/* 4. 右下角 - 青绿色光晕 */}
      <div
        className="absolute -bottom-6 -right-8 h-[200px] w-[200px] rounded-full opacity-22 blur-[54px] md:-bottom-16 md:-right-16 md:h-[420px] md:w-[420px] md:opacity-35 md:blur-[84px]"
        style={{
          background: `radial-gradient(circle, rgba(34,197,94,0.7) 0%, rgba(20,184,166,0.5) 50%, transparent 80%)`,
          willChange: 'transform, opacity',
          contain: 'layout paint'
        }}
      />

      {/* 5. 中部偏右 - 橙色点缀 */}
      <div
        className="absolute right-6 top-[55%] h-[150px] w-[150px] rounded-full opacity-16 blur-[44px] md:right-1/4 md:top-1/2 md:h-[320px] md:w-[320px] md:opacity-26 md:blur-[72px]"
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

      {/* 全站横幅公告 */}
      <GlobalBanner banners={banners} />

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
        {!isFeaturedLoading && featuredModules && featuredModules.length > 0 && (
          <FeaturedModules featuredModules={featuredModules.map(m => ({
            id: m.id,
            title: m.title,
            description: m.description ?? '',
            icon: m.icon ?? '✨',
            image_url: m.image_url ?? '',
            badge_type: (m.badge_type as 'hot' | 'new' | 'recommend') ?? 'recommend',
            badge_text: m.badge_text ?? '',
            credits_display: m.credits_display ?? '',
            usage_count: m.usage_count ?? 0,
            link_url: m.link_url ?? undefined,
            link_module_id: m.link_module_id ?? undefined,
          }))}
          onModuleClick={(featured) => {
            setSelectedModule({
              id: featured.id,
              title: featured.title,
              description: featured.description,
              icon: featured.icon ?? 'Sparkles',
              usage_count: featured.usage_count ?? 0,
            });
            setDialogOpen(true);
          }}
        />
        )}

        {/* 筛选栏 */}
        <div
          className="animate-slideUp sticky top-[72px] z-40 mb-8 flex flex-col gap-4 rounded-2xl px-4 py-3 backdrop-blur-sm md:top-16 md:mb-10 md:px-6 md:py-4 md:backdrop-blur-md"
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
                className="whitespace-nowrap rounded-xl px-5 py-2.5 text-sm font-medium transition-[background-color,color,border-color,box-shadow] duration-200 motion-reduce:transition-none"
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

          <div className="flex items-center justify-between gap-3 md:justify-end">
            <span className="text-xs" style={{ color: 'var(--text-disabled)' }}>
              共 {totalModules} 个工具
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="h-10 rounded-xl text-sm font-medium transition-[background-color,color,border-color] duration-200 motion-reduce:transition-none"
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
        {isModulesLoading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="h-8 w-8 animate-spin" style={{ color: 'var(--color-primary)' }} />
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5 mb-12">
            {modules.map((module, index) => (
              <div
                key={module.id}
                className="module-card-animate"
                style={{ animationDelay: `${index * 0.06}s`, opacity: 0 }}
              >
                <ModuleCard
                  module={{
                    id: module.id,
                    title: module.title,
                    description: module.description ?? '',
                    icon: module.icon ?? 'Sparkles',
                    category: module.category,
                    platform: module.platform ?? '',
                    usage_count: module.usage_count ?? 0,
                  }}
                  onShowDetail={() => {
                    setSelectedModule({
                      id: module.id,
                      title: module.title,
                      description: module.description ?? '',
                      icon: module.icon ?? 'Sparkles',
                      category: module.category,
                      platform: module.platform ?? '',
                      usage_count: module.usage_count ?? 0,
                    });
                    setDialogOpen(true);
                  }}
                />
              </div>
            ))}
          </div>
        )}

        {/* 空状态 */}
        {!isModulesLoading && modules.length === 0 && (
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
            className="flex flex-wrap items-center justify-center gap-3 py-4 px-4 md:px-8 rounded-2xl mx-auto max-w-full md:max-w-fit"
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
              className="h-10 w-10 rounded-xl transition-[background-color,color,border-color] duration-200 motion-reduce:transition-none disabled:opacity-30"
              style={{
                background: 'rgba(255,255,255,0.03)',
                borderColor: 'rgba(255,255,255,0.08)',
                color: 'var(--text-secondary)'
              }}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>

            <div className="hidden md:flex items-center gap-2">
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <Button
                  key={p}
                  variant={page === p ? 'default' : 'outline'}
                  onClick={() => setPage(p)}
                  className="h-10 w-10 rounded-xl transition-[background-color,color,border-color,box-shadow] duration-200 motion-reduce:transition-none"
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
              className="h-10 w-10 rounded-xl transition-[background-color,color,border-color] duration-200 motion-reduce:transition-none disabled:opacity-30"
              style={{
                background: 'rgba(255,255,255,0.03)',
                borderColor: 'rgba(255,255,255,0.08)',
                color: 'var(--text-secondary)'
              }}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>

            <div className="hidden md:block h-6 w-px mx-2" style={{ background: 'var(--border-primary)' }} />

            <span className="text-sm font-medium" style={{ color: 'var(--text-tertiary)' }}>
              第 <span style={{ color: 'var(--color-primary)' }}>{page}</span> / {totalPages} 页
            </span>
          </div>
        )}
      </div>

      {/* Module Detail Dialog */}
      <ModuleDetailDialog
        module={selectedModule}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </div>
  );
}

export default function MarketplacePage() {
  return (
    <Suspense
      fallback={
        <div
          className="min-h-screen"
          style={{ background: 'var(--bg-primary)' }}
        />
      }
    >
      <MarketplacePageContent />
    </Suspense>
  );
}
