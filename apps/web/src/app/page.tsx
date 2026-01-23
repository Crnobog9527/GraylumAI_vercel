'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AppHeader } from '@/components/layout/AppHeader';
import GlobalBanner from '@/components/layout/GlobalBanner';
import WelcomeBanner from '@/components/home/WelcomeBanner';
import SixStepsGuide from '@/components/home/SixStepsGuide';
import UpdatesSection from '@/components/home/UpdatesSection';
import { createClient } from '@/lib/supabase';
import { trpc } from '@/trpc/client';

/**
 * 首页组件
 * 使用设计系统: 背景色、容器布局、动画效果
 */
export default function HomePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    const checkAuth = async () => {
      // 检查是否有 ?domain=www 参数，如果有则重定向到 landing 页
      const domainParam = searchParams.get('domain');
      if (domainParam === 'www') {
        router.replace('/landing?domain=www');
        return;
      }

      // 检查用户登录状态
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();

      if (!user) {
        // 未登录，重定向到登录页
        router.replace('/login');
        return;
      }

      setIsAuthenticated(true);
      setIsLoading(false);
    };

    checkAuth();
  }, [router, searchParams]);

  // 从 tRPC 获取用户数据
  const { data: userProfile, isLoading: isProfileLoading } = trpc.user.getUserProfile.useQuery(
    undefined,
    { enabled: isAuthenticated }
  );

  // 从 tRPC 获取公告数据
  const { data: announcementsData, isLoading: isAnnouncementsLoading } = trpc.settings.getActiveAnnouncements.useQuery(
    undefined,
    { enabled: isAuthenticated }
  );

  // 从 tRPC 获取横幅公告
  const { data: bannerData } = trpc.settings.getBannerAnnouncement.useQuery(
    undefined,
    { enabled: isAuthenticated }
  );

  // 加载中或未认证时显示加载状态
  if (isLoading || !isAuthenticated) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: 'var(--bg-primary)' }}
      >
        <div className="text-center">
          <div
            className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin mx-auto mb-4"
            style={{ borderColor: 'var(--color-primary)', borderTopColor: 'transparent' }}
          />
          <p style={{ color: 'var(--text-secondary)' }}>加载中...</p>
        </div>
      </div>
    );
  }

  // 用户数据 (从 tRPC 获取)
  const user = {
    full_name: userProfile?.nickname || userProfile?.email?.split('@')[0] || '用户',
    email: userProfile?.email || '',
    membership_level: userProfile?.membership_level || 'free',
    membership_expiry_date: userProfile?.membership_expiry_date
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
    link_text: announcement.link_text,
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
          全站横幅公告
          ============================================ */}
      <GlobalBanner banners={banners} />

      {/* ============================================
          顶部导航
          ============================================ */}
      <AppHeader />

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
        <SixStepsGuide />
        <UpdatesSection announcements={announcements} isLoading={isAnnouncementsLoading} />
      </div>
    </div>
  );
}
