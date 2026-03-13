'use client';

import { Crown, Zap } from 'lucide-react';
import Link from 'next/link';

interface User {
  full_name?: string;
  email?: string;
  membership_level?: string;
  membership_expiry_date?: string;
}

interface WelcomeBannerProps {
  user: User;
}

/**
 * 欢迎横幅组件
 * 使用设计系统: card, btn-primary, badge-primary
 */
export default function WelcomeBanner({ user }: WelcomeBannerProps) {
  if (!user) return null;

  // 会员级别映射
  const membershipLevelMap: Record<string, string> = {
    'free': '普通会员',
    'pro': 'Pro会员',
    'gold': 'Gold会员'
  };

  const membershipLevel = membershipLevelMap[user.membership_level || 'free'] || '普通会员';
  const membershipExpiry = user.membership_expiry_date
    ? new Date(user.membership_expiry_date).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
    : null;

  return (
    <div
      data-testid="home-welcome-banner"
      className="card card-featured p-8 md:p-10 mb-10 flex flex-col md:flex-row md:items-center justify-between gap-6"
      style={{
        background: 'var(--bg-secondary)',
        borderRadius: 'var(--radius-2xl)',
        contain: 'layout paint',
      }}
    >
      <div>
        {/* 在线状态标签 */}
        <div className="flex items-center gap-2 mb-4">
          <span
            className="w-2 h-2 rounded-full animate-pulse"
            style={{ backgroundColor: 'var(--success)' }}
          />
          <span
            className="text-xs uppercase tracking-widest font-medium"
            style={{ color: 'var(--text-tertiary)' }}
          >
            Online
          </span>
        </div>

        {/* 欢迎标题 */}
        <h1
          className="heading-1 mb-3"
          style={{
            fontSize: 'clamp(1.75rem, 4vw, 2.5rem)',
            marginBottom: 'var(--space-sm)'
          }}
        >
          欢迎回来，{user.full_name || user.email?.split('@')[0] || '用户'}
        </h1>

        {/* 会员信息 */}
        <div className="flex items-center gap-3">
          <div
            className="badge badge-primary flex items-center gap-2 px-3 py-1.5"
            style={{ borderRadius: 'var(--radius-full)' }}
          >
            <Crown className="h-4 w-4" style={{ color: 'var(--color-primary)' }} />
            <span className="font-medium" style={{ color: 'var(--color-primary)' }}>
              {membershipLevel}
            </span>
          </div>
          {membershipExpiry && (
            <span style={{ color: 'var(--text-disabled)', fontSize: 'var(--text-small)' }}>
              有效期至 {membershipExpiry}
            </span>
          )}
        </div>
      </div>

      {/* 充值按钮 */}
      <Link href="/profile?tab=subscription">
        <button
          className="btn btn-primary"
          style={{
            height: '48px',
            paddingLeft: 'var(--space-xl)',
            paddingRight: 'var(--space-xl)',
            borderRadius: 'var(--radius-full)',
            boxShadow: 'var(--shadow-glow)'
          }}
        >
          <Zap className="h-4 w-4 mr-2" />
          充值积分
        </button>
      </Link>
    </div>
  );
}
