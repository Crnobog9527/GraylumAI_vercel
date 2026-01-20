'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { X, AlertTriangle, CheckCircle, Info, ChevronRight, Gift, Megaphone } from 'lucide-react';

/**
 * 全站横幅公告组件
 * 支持多种样式主题和动态背景效果
 */

interface BannerStyle {
  gradient: string;
  border: string;
  iconBg: string;
  iconColor: string;
  glowColor: string;
  textColor: string;
  icon: React.ElementType;
}

const bannerStyles: Record<string, BannerStyle> = {
  info: {
    gradient: 'linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(139, 92, 246, 0.12) 100%)',
    border: 'rgba(139, 92, 246, 0.3)',
    iconBg: 'rgba(139, 92, 246, 0.2)',
    iconColor: '#A78BFA',
    glowColor: 'rgba(139, 92, 246, 0.25)',
    textColor: 'var(--text-primary)',
    icon: Info,
  },
  warning: {
    gradient: 'linear-gradient(135deg, rgba(251, 191, 36, 0.15) 0%, rgba(245, 158, 11, 0.12) 100%)',
    border: 'rgba(251, 191, 36, 0.3)',
    iconBg: 'rgba(251, 191, 36, 0.2)',
    iconColor: '#FBBF24',
    glowColor: 'rgba(251, 191, 36, 0.25)',
    textColor: 'var(--text-primary)',
    icon: AlertTriangle,
  },
  success: {
    gradient: 'linear-gradient(135deg, rgba(34, 197, 94, 0.15) 0%, rgba(74, 222, 128, 0.12) 100%)',
    border: 'rgba(34, 197, 94, 0.3)',
    iconBg: 'rgba(34, 197, 94, 0.2)',
    iconColor: '#22C55E',
    glowColor: 'rgba(34, 197, 94, 0.25)',
    textColor: 'var(--text-primary)',
    icon: CheckCircle,
  },
  error: {
    gradient: 'linear-gradient(135deg, rgba(239, 68, 68, 0.15) 0%, rgba(248, 113, 113, 0.12) 100%)',
    border: 'rgba(239, 68, 68, 0.3)',
    iconBg: 'rgba(239, 68, 68, 0.2)',
    iconColor: '#EF4444',
    glowColor: 'rgba(239, 68, 68, 0.25)',
    textColor: 'var(--text-primary)',
    icon: AlertTriangle,
  },
  promo: {
    gradient: 'linear-gradient(135deg, rgba(255, 215, 0, 0.12) 0%, rgba(255, 165, 0, 0.08) 100%)',
    border: 'rgba(255, 215, 0, 0.4)',
    iconBg: 'rgba(255, 215, 0, 0.2)',
    iconColor: 'var(--color-primary)',
    glowColor: 'rgba(255, 215, 0, 0.3)',
    textColor: 'var(--text-primary)',
    icon: Gift,
  },
  announcement: {
    gradient: 'linear-gradient(135deg, rgba(59, 130, 246, 0.15) 0%, rgba(99, 102, 241, 0.12) 100%)',
    border: 'rgba(59, 130, 246, 0.3)',
    iconBg: 'rgba(59, 130, 246, 0.2)',
    iconColor: '#60A5FA',
    glowColor: 'rgba(59, 130, 246, 0.25)',
    textColor: 'var(--text-primary)',
    icon: Megaphone,
  },
};

interface Banner {
  id: string;
  title: string;
  description?: string;
  tag?: string;
  banner_style: string;
  banner_link?: string;
}

interface GlobalBannerProps {
  banners?: Banner[];
}

export default function GlobalBanner({ banners = [] }: GlobalBannerProps) {
  const [dismissedBanners, setDismissedBanners] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const saved = localStorage.getItem('dismissedBanners');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [isVisible, setIsVisible] = useState(false);

  // 延迟显示动画
  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 100);
    return () => clearTimeout(timer);
  }, []);

  const visibleBanners = banners.filter(b => !dismissedBanners.includes(b.id));

  const handleDismiss = (bannerId: string) => {
    const newDismissed = [...dismissedBanners, bannerId];
    setDismissedBanners(newDismissed);
    localStorage.setItem('dismissedBanners', JSON.stringify(newDismissed));
  };

  if (visibleBanners.length === 0) return null;

  const banner = visibleBanners[0];
  const style = bannerStyles[banner.banner_style] || bannerStyles.announcement;
  const IconComponent = style.icon;

  const BannerContent = ({ clickable = false }: { clickable?: boolean }) => (
    <div className="flex items-center gap-3 flex-1 min-w-0">
      <div
        className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-transform duration-300 hover:scale-110"
        style={{
          background: style.iconBg,
          boxShadow: `0 0 16px ${style.glowColor}`,
        }}
      >
        <IconComponent className="h-4 w-4" style={{ color: style.iconColor }} />
      </div>

      <div className="flex-1 min-w-0 flex items-center gap-2">
        {banner.tag && (
          <span
            className="shrink-0 text-xs font-medium px-2 py-0.5 rounded-full"
            style={{ background: style.iconBg, color: style.iconColor }}
          >
            {banner.tag}
          </span>
        )}
        <span
          className="font-medium truncate"
          style={{ color: style.textColor }}
        >
          {banner.title}
        </span>
        {banner.description && (
          <span
            className="hidden md:inline truncate"
            style={{ color: 'var(--text-secondary)' }}
          >
            {banner.description}
          </span>
        )}
      </div>

      {clickable && (
        <ChevronRight
          className="h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5"
          style={{ color: style.iconColor }}
        />
      )}
    </div>
  );

  const wrapperClass = "group flex items-center gap-3 flex-1 min-w-0 transition-all duration-200";

  return (
    <>
      <div
        className={`w-full px-4 py-2.5 relative z-40 overflow-hidden transition-all duration-500 ${
          isVisible ? 'opacity-100 max-h-16' : 'opacity-0 max-h-0'
        }`}
        style={{
          background: style.gradient,
          borderBottom: `1px solid ${style.border}`,
          backdropFilter: 'blur(10px)',
        }}
      >
        {/* 动态光效背景 */}
        <div
          className="absolute inset-0 pointer-events-none animate-banner-glow-left"
          style={{
            background: `radial-gradient(ellipse 40% 100% at 15% 50%, ${style.glowColor} 0%, transparent 70%)`,
          }}
        />
        <div
          className="absolute inset-0 pointer-events-none animate-banner-glow-right"
          style={{
            background: `radial-gradient(ellipse 35% 100% at 85% 50%, ${style.glowColor} 0%, transparent 70%)`,
          }}
        />

        {/* 顶部装饰线 */}
        <div
          className="absolute top-0 left-0 right-0 h-[1px]"
          style={{
            background: `linear-gradient(90deg, transparent 0%, ${style.iconColor} 50%, transparent 100%)`,
            opacity: 0.5,
          }}
        />

        {/* 内容区域 */}
        <div className="relative max-w-7xl mx-auto flex items-center gap-3">
          {banner.banner_link ? (
            banner.banner_link.startsWith('http') ? (
              <a
                href={banner.banner_link}
                target="_blank"
                rel="noopener noreferrer"
                className={wrapperClass}
              >
                <BannerContent clickable />
              </a>
            ) : (
              <Link href={banner.banner_link} className={wrapperClass}>
                <BannerContent clickable />
              </Link>
            )
          ) : (
            <BannerContent />
          )}

          <button
            onClick={() => handleDismiss(banner.id)}
            className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-300 hover:scale-110 bg-white/[0.08] text-[var(--text-tertiary)] hover:bg-white/[0.15] hover:text-[var(--text-primary)]"
            aria-label="关闭公告"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 动画样式 */}
      <style jsx>{`
        @keyframes bannerGlowLeft {
          0%, 100% {
            opacity: 0.3;
            transform: translateX(-5%);
          }
          50% {
            opacity: 0.6;
            transform: translateX(5%);
          }
        }
        @keyframes bannerGlowRight {
          0%, 100% {
            opacity: 0.4;
            transform: translateX(5%);
          }
          50% {
            opacity: 0.6;
            transform: translateX(-5%);
          }
        }
        .animate-banner-glow-left {
          animation: bannerGlowLeft 10s ease-in-out infinite;
        }
        .animate-banner-glow-right {
          animation: bannerGlowRight 10s ease-in-out infinite 5s;
        }
      `}</style>
    </>
  );
}
