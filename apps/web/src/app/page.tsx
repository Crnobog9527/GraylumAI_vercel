'use client';

import { AppHeader } from '@/components/layout/AppHeader';
import WelcomeBanner from '@/components/home/WelcomeBanner';
import SixStepsGuide from '@/components/home/SixStepsGuide';
import UpdatesSection from '@/components/home/UpdatesSection';

/**
 * 首页组件
 * 使用设计系统: 背景色、容器布局、动画效果
 */
export default function HomePage() {
  // TODO: 从 tRPC 获取用户数据
  const user = {
    full_name: 'office',
    email: 'office@example.com',
    membership_level: 'free',
    membership_expiry_date: undefined
  };

  // TODO: 从 tRPC 获取公告数据
  const announcements = [
    {
      id: '1',
      title: '应用上线特惠',
      description: '黄金会员年卡 5 折，限量 100 名。',
      icon: 'Megaphone',
      tag: '限量优惠',
      tag_color: 'red',
      publish_date: '2026-01-06',
    }
  ];

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
        <UpdatesSection announcements={announcements} />
      </div>
    </div>
  );
}
