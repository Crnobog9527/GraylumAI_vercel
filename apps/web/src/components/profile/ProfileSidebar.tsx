'use client';

import { memo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  User, Crown, Wallet, History, Shield, Headphones, LogOut
} from 'lucide-react';
import { createClient } from '@/lib/supabase';

export type ProfileTab = 'profile' | 'subscription' | 'credits' | 'history' | 'security' | 'tickets';

interface ProfileSidebarProps {
  activeTab: ProfileTab;
  onTabChange: (tab: ProfileTab) => void;
  onLogout?: () => void;
}

const menuItems: { id: ProfileTab; label: string; icon: typeof User }[] = [
  { id: 'profile', label: '个人资料', icon: User },
  { id: 'subscription', label: '订阅管理', icon: Crown },
  { id: 'credits', label: '积分记录', icon: Wallet },
  { id: 'history', label: '使用历史', icon: History },
  { id: 'security', label: '账户安全', icon: Shield },
  { id: 'tickets', label: '工单记录', icon: Headphones },
];

const ProfileSidebar = memo(function ProfileSidebar({
  activeTab,
  onTabChange,
  onLogout
}: ProfileSidebarProps) {
  const router = useRouter();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      const supabase = createClient();
      await supabase.auth.signOut();
      if (onLogout) {
        onLogout();
      }

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
    <div
      className="w-56 shrink-0 hidden md:block rounded-2xl p-4 h-fit"
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
      }}
    >
      <div className="mb-6">
        <h2
          className="text-base font-bold px-2 mb-4"
          style={{ color: 'var(--text-primary)' }}
        >
          个人中心
        </h2>
        <nav className="space-y-1">
          {menuItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;

            return (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg transition-all duration-200"
                style={{
                  background: isActive ? 'rgba(255, 215, 0, 0.1)' : 'transparent',
                  color: isActive ? 'var(--color-primary)' : 'var(--text-secondary)',
                  border: isActive ? '1px solid rgba(255, 215, 0, 0.2)' : '1px solid transparent'
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.background = 'rgba(255, 215, 0, 0.05)';
                    e.currentTarget.style.color = 'var(--text-primary)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = 'var(--text-secondary)';
                  }
                }}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="pt-4" style={{ borderTop: '1px solid var(--border-primary)' }}>
        <button
          onClick={handleLogout}
          disabled={isLoggingOut}
          className="w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium transition-colors disabled:opacity-50"
          style={{ color: 'var(--text-tertiary)' }}
          onMouseEnter={(e) => !isLoggingOut && (e.currentTarget.style.color = 'var(--error)')}
          onMouseLeave={(e) => !isLoggingOut && (e.currentTarget.style.color = 'var(--text-tertiary)')}
        >
          <LogOut className="h-4 w-4" />
          {isLoggingOut ? '退出中...' : '退出登录'}
        </button>
      </div>
    </div>
  );
});

export default ProfileSidebar;
