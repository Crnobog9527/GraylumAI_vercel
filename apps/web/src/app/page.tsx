'use client';

import { useRouter } from 'next/navigation';
import { AppHeader } from '@/components/layout/AppHeader';
import GlobalBanner from '@/components/layout/GlobalBanner';
import WelcomeBanner from '@/components/home/WelcomeBanner';
import SixStepsGuide from '@/components/home/SixStepsGuide';
import UpdatesSection from '@/components/home/UpdatesSection';
import FeaturedModules from '@/components/marketplace/FeaturedModules';
import { trpc } from '@/trpc/client';

/**
 * 首页组件
 * 使用设计系统: 背景色、容器布局、动画效果
 */
export default function HomePage() {
  const router = useRouter();
  // 从 tRPC 获取用户数据
  const { data: userProfile } = trpc.user.getUserProfile.useQuery();

  // 从 tRPC 获取公告数据
  const { data: announcementsData, isLoading: isAnnouncementsLoading } = trpc.settings.getActiveAnnouncements.useQuery();
  const { data: systemSettings } = trpc.settings.getSystemSettings.useQuery();
  const showOnboarding =
    systemSettings?.home_show_onboarding === true || systemSettings?.home_show_onboarding === 'true';
  const showFeaturedModules =
    systemSettings?.home_show_featured_modules === true || systemSettings?.home_show_featured_modules === 'true';
  const { data: featuredModules, isLoading: isFeaturedModulesLoading } = trpc.modules.getFeaturedModules.useQuery(
    { limit: 4 },
    { enabled: showFeaturedModules }
  );

  // 从 tRPC 获取横幅公告
  const { data: bannerData } = trpc.settings.getBannerAnnouncement.useQuery();

  // 用户数据 (从 tRPC 获取)
  const user = {
    full_name: userProfile?.nickname || userProfile?.email?.split('@')[0] || '用户',
    email: userProfile?.email || '',
    membership_level: userProfile?.membership_level || 'free',
    membership_expiry_date: undefined,
  };

  // 公告数据 (从 tRPC 获取)
  const announcements = (announcementsData ?? []).map(announcement => ({
    id: announcement.id,
    title: announcement.title,
    description: announcement.description || '',
    icon: announcement.icon || 'Megaphone',
    tag: announcement.tag || '',
    tag_color: announcement.tag_color || 'yellow',
    publish_date: announcement.created_at?.split('T')[0] || '',
    link_url: announcement.link_url,
  }));

  // 横幅公告数据 (从 tRPC 获取)
  const banners = bannerData ? [{
    id: bannerData.id,
    title: bannerData.title,
    description: bannerData.description || '',
    tag: bannerData.tag || '限量优惠',
    banner_style: bannerData.banner_style || 'promo',
    banner_link: bannerData.link_url,
  }] : [];

  return (
    <div
      className="min-h-screen relative overflow-hidden"
      style={{ background: 'var(--bg-primary)' }}
    >
      {/* ============================================
          动态背景系统 - 多层叠加效果
          ============================================ */}

      {/* 1. 基础渐变层 */}
      <div
        className="absolute inset-0"
        style={{
          background: `linear-gradient(135deg, var(--bg-primary) 0%, var(--bg-secondary) 50%, var(--bg-primary) 100%)`
        }}
      />

      {/* 2. 右上角金色光晕 - 简化动画 */}
      <div
        className="absolute -top-32 -right-32 w-[500px] h-[500px] rounded-full opacity-40 blur-[100px]"
        style={{
          background: `linear-gradient(135deg, var(--color-secondary) 0%, var(--color-primary) 100%)`,
          willChange: 'transform',
          contain: 'layout paint',
        }}
      />

      {/* 3. 左侧紫色光晕 - 静态 */}
      <div
        className="absolute top-1/4 -left-32 w-[400px] h-[400px] rounded-full opacity-20 blur-[80px]"
        style={{
          background: `rgba(139, 92, 246, 0.5)`,
          contain: 'layout paint',
        }}
      />

      {/* 4. 底部暖色光晕 - 静态 */}
      <div
        className="absolute -bottom-32 left-1/4 w-[500px] h-[300px] rounded-full opacity-30 blur-[100px]"
        style={{
          background: `var(--color-secondary)`,
          contain: 'layout paint',
        }}
      />

      {/* 5. 网格纹理层 - 静态 */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)`,
          backgroundSize: '50px 50px',
          contain: 'layout paint',
        }}
      />

      {/* 6. 暗角遮罩 */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse 80% 70% at 50% 50%, transparent 30%, rgba(0,0,0,0.3) 70%, rgba(0,0,0,0.6) 100%)',
          contain: 'layout paint',
        }}
      />

      {/* 动画样式定义 - 精简版 */}
      <style>{`
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .card-clickable:hover {
          border-color: var(--color-primary) !important;
        }
        .card-clickable:hover .heading-4 {
          color: var(--color-primary) !important;
        }
        .card-clickable:hover svg {
          color: var(--color-primary) !important;
        }
        .card-clickable:hover > div:first-child > div:first-child {
          border-color: var(--color-primary) !important;
        }
      `}</style>

      {/* ============================================
          顶部导航
          ============================================ */}
      <AppHeader />

      {/* ============================================
          全站横幅公告 (导航栏下方)
          ============================================ */}
      <GlobalBanner banners={banners} />

      {/* ============================================
          内容层
          ============================================ */}
      <div
        className="relative container mx-auto max-w-7xl"
        style={{
          zIndex: 'var(--z-base)',
          padding: 'var(--space-xl) var(--space-lg)'
        }}
      >
        <WelcomeBanner user={user} />
        {showOnboarding && <SixStepsGuide />}
        {showFeaturedModules && !isFeaturedModulesLoading && featuredModules && featuredModules.length > 0 && (
          <FeaturedModules
            featuredModules={featuredModules.map((module) => ({
              id: module.id,
              title: module.title,
              description: module.description ?? '',
              icon: module.icon ?? '✨',
              image_url: module.image_url ?? '',
              badge_type: (module.badge_type as 'hot' | 'new' | 'recommend') ?? 'recommend',
              badge_text: module.badge_text ?? '',
              credits_display: module.credits_display ?? '',
              usage_count: module.usage_count ?? 0,
              link_url: module.link_url ?? undefined,
              link_module_id: module.link_module_id ?? undefined,
            }))}
            onModuleClick={() => router.push('/marketplace')}
          />
        )}
        <UpdatesSection announcements={announcements} isLoading={isAnnouncementsLoading} />
      </div>
    </div>
  );
}
