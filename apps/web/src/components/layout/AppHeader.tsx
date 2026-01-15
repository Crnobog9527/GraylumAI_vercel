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
  CreditCard
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// Navigation items configuration
const navItems = [
  { href: '/', label: '首页', icon: Home },
  { href: '/chat', label: '对话', icon: MessageSquare },
  { href: '/features', label: '功能广场', icon: Grid3X3 },
  { href: '/profile', label: '个人中心', icon: User },
];

export function AppHeader() {
  const pathname = usePathname();
  const [credits] = useState(100); // TODO: Get from user context

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
            <Sparkles className="h-4 w-4" style={{ color: 'var(--color-primary)' }} />
            <span className="font-semibold" style={{ color: 'var(--color-primary)' }}>
              {credits}
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
              <DropdownMenuItem
                className="gap-2 rounded-lg cursor-pointer"
                style={{ color: 'var(--text-secondary)' }}
              >
                <User className="h-4 w-4" />
                <span>个人中心</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2 rounded-lg cursor-pointer"
                style={{ color: 'var(--text-secondary)' }}
              >
                <CreditCard className="h-4 w-4" />
                <span>充值积分</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2 rounded-lg cursor-pointer"
                style={{ color: 'var(--text-secondary)' }}
              >
                <Settings className="h-4 w-4" />
                <span>设置</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator style={{ background: 'var(--border-primary)' }} />
              <DropdownMenuItem
                className="gap-2 rounded-lg cursor-pointer"
                style={{ color: 'var(--error)' }}
              >
                <LogOut className="h-4 w-4" />
                <span>退出登录</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
