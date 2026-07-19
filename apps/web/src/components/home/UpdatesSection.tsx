'use client';

import { Sparkles, Volume2, Wrench, Megaphone, Gift, Bell, AlertTriangle, Info, Star, ArrowUpRight } from 'lucide-react';
import Link from 'next/link';

/**
 * 更新公告组件
 * 使用设计系统: card, card-clickable, badge, skeleton
 */

// 图标映射
const iconMap: Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  Sparkles,
  Volume2,
  Wrench,
  Megaphone,
  Gift,
  Bell,
  AlertTriangle,
  Info,
  Star,
};

// 标签颜色映射 - 使用设计系统变量
const tagColorMap: Record<string, { bg: string; color: string; border: string }> = {
  blue: { bg: 'var(--info-bg)', color: 'var(--info)', border: 'var(--info)' },
  orange: { bg: 'var(--warning-bg)', color: 'var(--warning)', border: 'var(--warning)' },
  green: { bg: 'var(--success-bg)', color: 'var(--success)', border: 'var(--success)' },
  red: { bg: 'var(--error-bg)', color: 'var(--error)', border: 'var(--error)' },
  purple: { bg: 'rgba(139, 92, 246, 0.1)', color: '#A78BFA', border: '#A78BFA' },
  yellow: { bg: 'var(--color-primary-10)', color: 'var(--color-primary)', border: 'var(--color-primary)' },
};

interface Announcement {
  id: string;
  title: string;
  description: string;
  icon?: string;
  tag?: string;
  tag_color?: string;
  expire_date?: string;
  publish_date?: string;
  created_date?: string;
  link_url?: string | null;
}

interface UpdatesSectionProps {
  announcements?: Announcement[];
  isLoading?: boolean;
}

interface AnnouncementLink {
  href: string;
  isExternal: boolean;
}

const INTERNAL_LINK_BASE = 'https://graylum.internal';

export function resolveAnnouncementLink(linkUrl?: string | null): AnnouncementLink | null {
  const href = linkUrl?.trim();

  if (!href) {
    return null;
  }

  if (href.startsWith('/') && !href.startsWith('//')) {
    try {
      const parsed = new URL(href, INTERNAL_LINK_BASE);

      if (parsed.origin === INTERNAL_LINK_BASE) {
        return {
          href: `${parsed.pathname}${parsed.search}${parsed.hash}`,
          isExternal: false,
        };
      }
    } catch {
      return null;
    }
  }

  if (!/^https?:\/\//i.test(href)) {
    return null;
  }

  try {
    const parsed = new URL(href);

    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return { href: parsed.href, isExternal: true };
    }
  } catch {
    return null;
  }

  return null;
}

export default function UpdatesSection({ announcements = [], isLoading = false }: UpdatesSectionProps) {
  if (isLoading) {
    return (
      <div className="mb-8">
        {/* 标题骨架 */}
        <div className="flex items-center gap-3 mb-8">
          <div
            className="badge badge-default inline-flex items-center gap-2"
            style={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-primary)',
              borderRadius: 'var(--radius-full)',
              padding: 'var(--space-sm) var(--space-md)'
            }}
          >
            <span
              className="uppercase tracking-widest font-medium"
              style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}
            >
              ANNOUNCEMENTS
            </span>
          </div>
        </div>

        {/* 骨架屏卡片 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => (
            <div
              key={i}
              className="card p-8"
              style={{ borderRadius: 'var(--radius-2xl)' }}
            >
              <div className="skeleton skeleton-avatar mb-6" style={{ width: '48px', height: '48px', borderRadius: 'var(--radius-lg)' }} />
              <div className="skeleton skeleton-title mb-3" />
              <div className="skeleton skeleton-text mb-2" />
              <div className="skeleton skeleton-text" style={{ width: '66%' }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (announcements.length === 0) {
    return null;
  }

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toISOString().split('T')[0];
  };

  return (
    <div className="mb-8">
      {/* 标题区域 */}
      <div className="flex items-center justify-between mb-8">
        <div
          className="badge badge-default inline-flex items-center gap-2"
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-primary)',
            borderRadius: 'var(--radius-full)',
            padding: 'var(--space-sm) var(--space-md)'
          }}
        >
          <Bell className="h-3 w-3" style={{ color: 'var(--color-primary)' }} />
          <span
            className="uppercase tracking-widest font-medium"
            style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}
          >
            ANNOUNCEMENTS
          </span>
        </div>

        <h2 className="heading-3" style={{ margin: 0 }}>平台公告</h2>
      </div>

      {/* Bento Grid - 公告卡片网格 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {announcements.slice(0, 3).map((item) => {
          const IconComponent = iconMap[item.icon || 'Megaphone'] || Megaphone;
          const tagStyle = tagColorMap[item.tag_color || 'blue'] || tagColorMap.blue;
          const announcementLink = resolveAnnouncementLink(item.link_url);

          let dateDisplay = '';
          if (item.expire_date) {
            dateDisplay = `活动截止: ${formatDate(item.expire_date)}`;
          } else if (item.publish_date) {
            dateDisplay = formatDate(item.publish_date);
          } else if (item.created_date) {
            dateDisplay = formatDate(item.created_date);
          }

          const cardContent = (
            <>
              {/* 头部 - 图标和标签 */}
              <div className="flex items-center justify-between mb-6">
                <div
                  className="w-12 h-12 flex items-center justify-center transition-all duration-300"
                  style={{
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border-primary)',
                    borderRadius: 'var(--radius-lg)'
                  }}
                >
                  <IconComponent className="h-5 w-5" style={{ color: 'var(--color-primary)' }} />
                </div>
                {item.tag && (
                  <span
                    className="uppercase tracking-wider font-medium"
                    style={{
                      fontSize: 'var(--text-xs)',
                      padding: 'var(--space-xs) var(--space-sm)',
                      borderRadius: 'var(--radius-full)',
                      background: tagStyle.bg,
                      color: tagStyle.color,
                      border: `1px solid ${tagStyle.border}30`
                    }}
                  >
                    {item.tag}
                  </span>
                )}
              </div>

              {/* 标题 */}
              <h3
                className="heading-4 mb-3 transition-colors duration-300"
                style={{ color: 'var(--text-primary)' }}
              >
                {item.title}
              </h3>

              {/* 描述 */}
              <p
                className="mb-6 flex-1"
                style={{
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--text-small)',
                  lineHeight: 'var(--leading-relaxed)'
                }}
              >
                {item.description}
              </p>

              {/* 底部 - 日期和箭头 */}
              <div
                className="flex items-center justify-between pt-4"
                style={{ borderTop: '1px solid var(--border-primary)' }}
              >
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-disabled)' }}>
                  {dateDisplay}
                </span>
                {announcementLink && (
                  <ArrowUpRight
                    aria-hidden="true"
                    className="h-4 w-4 transition-colors duration-300"
                    style={{ color: 'var(--text-disabled)' }}
                  />
                )}
              </div>
            </>
          );

          const cardClassName = `card p-8 flex flex-col h-full${announcementLink ? ' card-clickable group' : ''}`;
          const cardStyle = {
            borderRadius: 'var(--radius-2xl)',
            contain: 'layout paint',
          } as const;

          if (!announcementLink) {
            return (
              <div key={item.id} className={cardClassName} style={cardStyle}>
                {cardContent}
              </div>
            );
          }

          if (announcementLink.isExternal) {
            return (
              <a
                key={item.id}
                href={announcementLink.href}
                target="_blank"
                rel="noopener noreferrer"
                className={cardClassName}
                style={cardStyle}
              >
                {cardContent}
              </a>
            );
          }

          return (
            <Link
              key={item.id}
              href={announcementLink.href}
              className={cardClassName}
              style={cardStyle}
            >
              {cardContent}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
