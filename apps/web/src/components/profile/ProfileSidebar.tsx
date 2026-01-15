'use client';

import { memo } from 'react';
import { useRouter } from 'next/navigation';
import {
  User, Crown, Wallet, History, Shield, Headphones, LogOut
} from 'lucide-react';

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
  const handleLogout = async () => {
    // TODO: Implement logout via tRPC
    if (onLogout) {
      onLogout();
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
          className="w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium transition-colors"
          style={{ color: 'var(--text-tertiary)' }}
          onMouseEnter={(e) => e.currentTarget.style.color = 'var(--error)'}
          onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-tertiary)'}
        >
          <LogOut className="h-4 w-4" />
          退出登录
        </button>
      </div>
    </div>
  );
});

export default ProfileSidebar;
