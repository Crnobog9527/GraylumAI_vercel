'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
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
import { useCreditsBalance } from '@/hooks/use-credits';
import { trpc } from '@/trpc/client';

// Navigation items configuration
const navItems = [
  { href: '/', label: '首页', icon: Home },
  { href: '/chat', label: '对话', icon: MessageSquare },
  { href: '/marketplace', label: '功能广场', icon: Grid3X3 },
  { href: '/profile', label: '个人中心', icon: User },
];

export function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const { credits, isLoading: isCreditsLoading } = useCreditsBalance();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  // Get user profile to check for admin role
  const { data: userProfile } = trpc.user.getUserProfile.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const isAdmin = userProfile?.role === 'admin';

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      const supabase = createClient();
      await supabase.auth.signOut();

      // 根据环境跳转到不同的着陆页
      const hostname = typeof window !== 'undefined' ? window.location.hostname : '';
      const isProduction = hostname.includes('graylum.com');

      if (isProduction) {
        // 生产环境: 跳转到 www 域名的着陆页
        window.location.href = 'https://www.graylum.com';
      } else {
        // 开发环境: 跳转到带 domain 参数的着陆页
        router.push('/landing?domain=www');
      }
    } catch (error) {
      console.error('Logout failed:', error);
    } finally {
      setIsLoggingOut(false);
    }
  };

  return (
    <header
      className="h-16 border-b sticky top-0 z-50 backdrop-blur-xl"
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
            className="w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-300 group-hover:scale-105"
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
            GraylumAI
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
                  className="gap-2 px-4 h-10 rounded-xl transition-all duration-200"
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
          {/* Credits badge */}
          <div
            className="hidden sm:flex items-center gap-2 px-4 py-2 rounded-xl"
            style={{
              background: 'var(--color-primary-10)',
              border: '1px solid var(--color-primary-20)'
            }}
          >
            {isCreditsLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--color-primary)' }} />
            ) : (
              <Sparkles className="h-4 w-4" style={{ color: 'var(--color-primary)' }} />
            )}
            <span className="font-semibold" style={{ color: 'var(--color-primary)' }}>
              {isCreditsLoading ? '--' : credits}
            </span>
            <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
              积分
            </span>
          </div>

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
