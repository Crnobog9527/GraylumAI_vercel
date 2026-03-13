'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { resolveSiteName } from '@/lib/site-config';
import { trpc } from '@/trpc/client';
import {
  LayoutDashboard, Bot, Wand2, Package, Users,
  CreditCard, Settings, ChevronLeft, Shield, DollarSign,
  Megaphone, Headphones, Gift, Activity, Stethoscope, BarChart3
} from 'lucide-react';
import { Button } from "@/components/ui/button";

interface MenuItem {
  name: string;
  icon: React.ElementType;
  href: string;
}

const menuItems: MenuItem[] = [
  { name: '仪表盘', icon: LayoutDashboard, href: '/admin' },
  { name: 'AI 模型', icon: Bot, href: '/admin/models' },
  { name: 'AI 成本监控', icon: BarChart3, href: '/admin/costs' },
  { name: '提示词模块', icon: Wand2, href: '/admin/prompts' },
  { name: '积分包', icon: Package, href: '/admin/packages' },
  { name: '用户管理', icon: Users, href: '/admin/users' },
  { name: '交易记录', icon: CreditCard, href: '/admin/transactions' },
  { name: '财务统计', icon: DollarSign, href: '/admin/finance' },
  { name: '公告管理', icon: Megaphone, href: '/admin/announcements' },
  { name: '工单管理', icon: Headphones, href: '/admin/tickets' },
  { name: '邀请码', icon: Gift, href: '/admin/invitations' },
  { name: '性能监控', icon: Activity, href: '/admin/performance' },
  { name: '系统诊断', icon: Stethoscope, href: '/admin/diagnostics' },
  { name: '系统设置', icon: Settings, href: '/admin/settings' },
];

export function getAdminPageMeta(pathname: string | null) {
  const matchedItem = menuItems.find((item) =>
    pathname === item.href || (item.href !== '/admin' && pathname?.startsWith(item.href))
  );

  return matchedItem ?? menuItems[0];
}

export default function AdminSidebar({
  mobile = false,
  onNavigate,
}: {
  mobile?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const { data: systemSettings } = trpc.settings.getSystemSettings.useQuery();
  const siteName =
    typeof systemSettings?.site_name === 'string' && systemSettings.site_name.trim()
      ? systemSettings.site_name.trim()
      : resolveSiteName();

  return (
    <div
      className={cn(
        "flex flex-col",
        mobile ? "w-full min-h-0" : "hidden md:flex w-64 min-h-screen shrink-0"
      )}
      style={{ background: 'var(--bg-primary)', borderRight: '1px solid var(--border-primary)' }}
    >
      {/* Header */}
      <div
        className={cn("p-6", mobile && "pb-4")}
        style={{ borderBottom: '1px solid var(--border-primary)' }}
      >
        <div className="flex items-center gap-3">
          <div
            className="p-2 rounded-lg"
            style={{ background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)' }}
          >
            <Shield className="h-5 w-5 text-black" />
          </div>
          <div>
            <h1 className="font-bold" style={{ color: 'var(--text-primary)' }}>管理后台</h1>
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{siteName} 控制面板</p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
        {menuItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href ||
            (item.href !== '/admin' && pathname?.startsWith(item.href));

          return (
            <Link key={item.href} href={item.href} onClick={onNavigate}>
              <Button
                variant="ghost"
                className={cn(
                  "w-full justify-start gap-3 h-11 text-sm font-medium transition-[background-color,color,border-color] duration-200 motion-reduce:transition-none",
                  isActive
                    ? "bg-[var(--color-primary-20)] text-[var(--color-primary)] hover:bg-[var(--color-primary-30)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                )}
                aria-current={isActive ? 'page' : undefined}
              >
                <Icon className="h-5 w-5" />
                {item.name}
              </Button>
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div
        className="p-4 space-y-2"
        style={{ borderTop: '1px solid var(--border-primary)' }}
      >
        <Link href="/chat" onClick={onNavigate}>
          <Button
            variant="outline"
            className="w-full justify-start gap-3 border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          >
            <ChevronLeft className="h-4 w-4" />
            返回应用
          </Button>
        </Link>
      </div>
    </div>
  );
}
