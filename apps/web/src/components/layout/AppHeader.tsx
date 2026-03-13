'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Home,
  MessageSquare,
  Grid3X3,
  User,
  Sparkles,
  ChevronDown,
  LogOut,
  Settings,
  CreditCard,
  Loader2,
  Shield
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { createClient } from '@/lib/supabase';
import { buildAppHref, resolveSiteName } from '@/lib/site-config';
import { useCreditsBalance, CREDIT_THRESHOLDS } from '@/hooks/use-credits';
import { trpc } from '@/trpc/client';
import { AlertTriangle } from 'lucide-react';

// Navigation items configuration
const navItems = [
  { href: '/', label: '首页', icon: Home },
  { href: '/chat', label: '对话', icon: MessageSquare },
  { href: '/marketplace', label: '功能广场', icon: Grid3X3 },
  { href: '/profile', label: '个人中心', icon: User },
];

export function AppHeader() {
  const pathname = usePathname();
  const { data: systemSettings } = trpc.settings.getSystemSettings.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const {
    credits,
    isLoading: isCreditsLoading,
    warningLevel,
    warningColor,
    warningBgColor,
    warningBorderColor,
    isLowBalance,
  } = useCreditsBalance();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  // Get user profile to check for admin role
  const { data: userProfile } = trpc.user.getUserProfile.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const isAdmin = userProfile?.role === 'admin';
  const siteName =
    typeof systemSettings?.site_name === 'string' && systemSettings.site_name.trim()
      ? systemSettings.site_name.trim()
      : resolveSiteName();

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      const supabase = createClient();
      await supabase.auth.signOut();

      // 根据环境跳转到不同的着陆页
      window.location.href = buildAppHref('/landing');
    } catch (error) {
      console.error('Logout failed:', error);
    } finally {
      setIsLoggingOut(false);
    }
  };

  return (
    <header
      className="sticky top-0 z-50 h-16 border-b backdrop-blur-md md:backdrop-blur-xl"
      style={{
        background: 'rgba(10, 10, 10, 0.95)',
        borderColor: 'var(--border-primary)'
      }}
    >
      {/* 顶部金色装饰线 */}
      <div
        className="absolute top-0 left-0 right-0 h-[1px]"
        style={{
          background: 'linear-gradient(90deg, transparent 0%, var(--color-primary) 50%, transparent 100%)',
          opacity: 0.6
        }}
      />

      <div className="h-full max-w-[1400px] mx-auto px-6 flex items-center justify-between">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-3 group">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-xl transition-transform duration-300 group-hover:scale-105"
            style={{
              background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
              boxShadow: '0 0 20px rgba(255, 215, 0, 0.3)'
            }}
          >
            <Sparkles className="h-5 w-5" style={{ color: 'var(--bg-primary)' }} />
          </div>
          <span
            className="text-xl font-bold tracking-tight"
            style={{
              background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent'
            }}
          >
            {siteName}
          </span>
        </Link>

        {/* Navigation */}
        <nav className="hidden md:flex items-center gap-1">
          {navItems.map((item) => {
            const isActive = pathname === item.href ||
              (item.href !== '/' && pathname?.startsWith(item.href));
            const Icon = item.icon;

            return (
              <Link key={item.href} href={item.href}>
                <Button
                  variant="ghost"
                  className="h-10 gap-2 rounded-xl px-4 transition-colors duration-200"
                  style={{
                    background: isActive ? 'var(--color-primary-10)' : 'transparent',
                    color: isActive ? 'var(--color-primary)' : 'var(--text-secondary)',
                    border: isActive ? '1px solid var(--color-primary-20)' : '1px solid transparent'
                  }}
                >
                  <Icon className="h-4 w-4" />
                  <span className="font-medium">{item.label}</span>
                </Button>
              </Link>
            );
          })}
        </nav>

        {/* Right section */}
        <div className="flex items-center gap-4">
          {/* Credits badge with warning styles */}
          <Link href="/profile?tab=subscription">
            <div
              className="hidden cursor-pointer items-center gap-2 rounded-xl px-4 py-2 transition-opacity duration-200 hover:opacity-90 sm:flex"
              style={{
                background: warningBgColor,
                border: `1px solid ${warningBorderColor}`
              }}
              title={isLowBalance ? `积分不足，请充值` : undefined}
            >
              {isCreditsLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--color-primary)' }} />
              ) : isLowBalance ? (
                <AlertTriangle className="h-4 w-4" style={{ color: warningColor }} />
              ) : (
                <Sparkles className="h-4 w-4" style={{ color: 'var(--color-primary)' }} />
              )}
              <span className="font-semibold" style={{ color: warningColor }}>
                {isCreditsLoading ? '--' : credits}
              </span>
              <span className="text-sm" style={{ color: isLowBalance ? warningColor : 'var(--text-tertiary)' }}>
                积分
              </span>
              {isLowBalance && warningLevel !== 'low' && (
                <span
                  className="text-xs px-1.5 py-0.5 rounded"
                  style={{
                    background: warningColor,
                    color: 'white',
                  }}
                >
                  {warningLevel === 'empty' ? '已用完' : warningLevel === 'critical' ? '即将用完' : '请充值'}
                </span>
              )}
            </div>
          </Link>

          {/* User avatar dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="flex items-center gap-2 px-2 h-10 rounded-xl hover:opacity-90"
                style={{ background: 'transparent' }}
              >
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center"
                  style={{
                    background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                  }}
                >
                  <User className="h-4 w-4" style={{ color: 'var(--bg-primary)' }} />
                </div>
                <ChevronDown className="h-4 w-4" style={{ color: 'var(--text-tertiary)' }} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-48 rounded-xl"
              style={{
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-primary)'
              }}
            >
              <Link href="/profile">
                <DropdownMenuItem
                  className="gap-2 rounded-lg cursor-pointer"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <User className="h-4 w-4" />
                  <span>个人中心</span>
                </DropdownMenuItem>
              </Link>
              <Link href="/profile?tab=subscription">
                <DropdownMenuItem
                  className="gap-2 rounded-lg cursor-pointer"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <CreditCard className="h-4 w-4" />
                  <span>充值积分</span>
                </DropdownMenuItem>
              </Link>
              <Link href="/profile?tab=settings">
                <DropdownMenuItem
                  className="gap-2 rounded-lg cursor-pointer"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <Settings className="h-4 w-4" />
                  <span>设置</span>
                </DropdownMenuItem>
              </Link>
              {isAdmin && (
                <>
                  <DropdownMenuSeparator style={{ background: 'var(--border-primary)' }} />
                  <Link href="/admin">
                    <DropdownMenuItem
                      className="gap-2 rounded-lg cursor-pointer"
                      style={{ color: 'var(--color-primary)' }}
                    >
                      <Shield className="h-4 w-4" />
                      <span>管理后台</span>
                    </DropdownMenuItem>
                  </Link>
                </>
              )}
              <DropdownMenuSeparator style={{ background: 'var(--border-primary)' }} />
              <DropdownMenuItem
                className="gap-2 rounded-lg cursor-pointer"
                style={{ color: 'var(--error)' }}
                onClick={handleLogout}
                disabled={isLoggingOut}
              >
                <LogOut className="h-4 w-4" />
                <span>{isLoggingOut ? '退出中...' : '退出登录'}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
