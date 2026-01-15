'use client';

import { memo, useState, useRef } from 'react';
import {
  Pencil, Crown, Coins, Plus, RefreshCw, Key, Users, Headphones,
  Loader2, Check, X, Camera, MessageCircle
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

// Mock user type
export interface MockUser {
  id?: string;
  email?: string;
  nickname?: string;
  full_name?: string;
  avatar_url?: string;
  credits?: number;
  total_credits_used?: number;
  total_credits_purchased?: number;
  subscription_tier?: 'free' | 'basic' | 'pro' | 'enterprise';
  email_verified?: boolean;
  created_date?: string;
}

// 用户头像和基本信息卡片
export const UserProfileHeader = memo(function UserProfileHeader({
  user,
  onUserUpdate
}: {
  user: MockUser;
  onUserUpdate?: (user: MockUser) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [editingNickname, setEditingNickname] = useState(false);
  const [nickname, setNickname] = useState(user?.nickname || '');
  const [savingNickname, setSavingNickname] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const registerDate = user?.created_date
    ? new Date(user.created_date).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
    : '-';

  const tierLabels: Record<string, string> = {
    free: '免费用户',
    basic: '基础会员',
    pro: '专业会员',
    enterprise: '企业会员'
  };
  const subscriptionTier = user?.subscription_tier || 'free';

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // TODO: Implement avatar upload
    console.log('File selected:', file.name);
  };

  const handleSaveNickname = async () => {
    if (!nickname.trim()) return;
    setSavingNickname(true);
    try {
      // TODO: Save nickname via tRPC
      console.log('Save nickname:', nickname);
      onUserUpdate?.({ ...user, nickname: nickname.trim() });
      setEditingNickname(false);
    } finally {
      setSavingNickname(false);
    }
  };

  const handleCancelNickname = () => {
    setNickname(user?.nickname || '');
    setEditingNickname(false);
  };

  return (
    <div
      className="rounded-2xl p-6 mb-6"
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        contain: 'layout paint',
      }}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <div className="relative group">
            <Avatar
              className="h-20 w-20"
              style={{ border: '2px solid rgba(255, 215, 0, 0.3)' }}
            >
              <AvatarImage src={user?.avatar_url} />
              <AvatarFallback
                className="text-2xl font-medium"
                style={{ background: 'rgba(255, 215, 0, 0.1)', color: 'var(--color-primary)' }}
              >
                {user?.full_name?.[0] || user?.email?.[0]?.toUpperCase() || 'U'}
              </AvatarFallback>
            </Avatar>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileSelect}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="absolute inset-0 flex items-center justify-center rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ background: 'rgba(0,0,0,0.6)' }}
            >
              {uploading ? (
                <Loader2 className="h-6 w-6 animate-spin text-white" />
              ) : (
                <Camera className="h-6 w-6 text-white" />
              )}
            </button>
          </div>
          <div>
            <div className="flex items-center gap-2 mb-1">
              {editingNickname ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={nickname}
                    onChange={(e) => setNickname(e.target.value)}
                    placeholder="输入昵称"
                    className="text-xl font-bold px-2 py-1 rounded-lg outline-none"
                    style={{
                      background: 'var(--bg-primary)',
                      border: '1px solid var(--border-primary)',
                      color: 'var(--text-primary)',
                      width: '150px'
                    }}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveNickname();
                      if (e.key === 'Escape') handleCancelNickname();
                    }}
                  />
                  <button
                    onClick={handleSaveNickname}
                    disabled={savingNickname || !nickname.trim()}
                    className="p-1.5 rounded-lg transition-colors"
                    style={{ background: 'rgba(34, 197, 94, 0.1)', color: 'var(--success)' }}
                  >
                    {savingNickname ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  </button>
                  <button
                    onClick={handleCancelNickname}
                    className="p-1.5 rounded-lg transition-colors"
                    style={{ background: 'rgba(239, 68, 68, 0.1)', color: 'var(--error)' }}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <>
                  <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {user?.nickname || user?.full_name || '用户'}
                  </h2>
                  <button
                    onClick={() => {
                      setNickname(user?.nickname || user?.full_name || '');
                      setEditingNickname(true);
                    }}
                    className="p-1 rounded-lg transition-colors opacity-60 hover:opacity-100"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                </>
              )}
            </div>
            <p className="text-sm mb-2" style={{ color: 'var(--text-tertiary)' }}>{user?.email}</p>
            <div className="flex items-center gap-4 text-sm" style={{ color: 'var(--text-tertiary)' }}>
              <span>注册时间：{registerDate}</span>
              <div className="flex items-center gap-1" style={{ color: 'var(--color-primary)' }}>
                <Crown className="h-4 w-4" />
                <span>{tierLabels[subscriptionTier]}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

// 积分和订阅卡片
export const CreditsAndSubscriptionCards = memo(function CreditsAndSubscriptionCards({
  user,
  onNavigateToSubscription
}: {
  user: MockUser;
  onNavigateToSubscription?: () => void;
}) {
  const credits = user?.credits || 0;
  const monthlyUsed = 256; // TODO: Calculate from real data

  const tierLabels: Record<string, string> = {
    free: '免费用户',
    basic: '基础会员',
    pro: '专业会员',
    enterprise: '企业会员'
  };
  const subscriptionTier = user?.subscription_tier || 'free';
  const isFreeTier = subscriptionTier === 'free';

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
      {/* Credits Card */}
      <div
        className="rounded-2xl p-6 flex flex-col"
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
          contain: 'layout paint',
        }}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold" style={{ color: 'var(--text-primary)' }}>积分余额</h3>
          <Coins className="h-5 w-5" style={{ color: 'var(--color-primary)' }} />
        </div>
        <div
          className="text-4xl font-bold mb-2"
          style={{
            background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent'
          }}
        >
          {credits.toLocaleString()}
        </div>
        <div className="text-sm mb-4 flex-1" style={{ color: 'var(--text-tertiary)' }}>
          本月已消耗 {monthlyUsed.toLocaleString()} 积分
        </div>
        <Button
          onClick={() => onNavigateToSubscription?.()}
          className="w-full gap-2"
          style={{
            background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
            color: 'var(--bg-primary)',
          }}
        >
          <Plus className="h-4 w-4" />
          购买加油包
        </Button>
      </div>

      {/* Subscription Card */}
      <div
        className="rounded-2xl p-6 flex flex-col"
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
          contain: 'layout paint',
        }}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold" style={{ color: 'var(--text-primary)' }}>订阅状态</h3>
          <Crown className="h-5 w-5" style={{ color: 'var(--color-primary)' }} />
        </div>
        <div className="text-2xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
          {tierLabels[subscriptionTier]}
        </div>
        <div className="text-sm mb-4 flex-1" style={{ color: 'var(--text-tertiary)' }}>
          {isFreeTier ? '升级会员享受更多权益' : '感谢您的支持'}
        </div>
        <Button
          onClick={() => onNavigateToSubscription?.()}
          className="w-full gap-2"
          style={{
            background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
            color: 'var(--bg-primary)',
          }}
        >
          {isFreeTier ? (
            <>
              <Crown className="h-4 w-4" />
              升级会员
            </>
          ) : (
            <>
              <RefreshCw className="h-4 w-4" />
              续费订阅
            </>
          )}
        </Button>
      </div>
    </div>
  );
});

// 使用统计卡片
export const UsageStatsCard = memo(function UsageStatsCard({ user }: { user: MockUser }) {
  // Mock data
  const stats = [
    { label: '累计对话次数', value: '128' },
    { label: '累计消息数', value: '1,024' },
    { label: '本月消耗积分', value: '256' },
    { label: '使用天数', value: '32' },
  ];

  const topModules = [
    { name: 'AI 智能对话', count: 56 },
    { name: '文案生成', count: 34 },
    { name: '代码助手', count: 28 },
  ];

  return (
    <div
      className="rounded-2xl p-6 mb-6"
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        contain: 'layout paint',
      }}
    >
      <h3 className="font-semibold mb-6" style={{ color: 'var(--text-primary)' }}>使用统计</h3>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-8">
        {stats.map((stat, index) => (
          <div key={index}>
            <div className="text-sm mb-1" style={{ color: 'var(--text-tertiary)' }}>{stat.label}</div>
            <div
              className="text-2xl font-bold"
              style={{
                background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent'
              }}
            >
              {stat.value}
            </div>
          </div>
        ))}
      </div>

      {topModules.length > 0 && (
        <>
          <h4 className="font-medium mb-4" style={{ color: 'var(--text-primary)' }}>最常使用功能 Top 3</h4>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {topModules.map((module, index) => (
              <div
                key={index}
                className="flex items-center gap-3 p-4 rounded-xl transition-all duration-200"
                style={{
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--border-primary)'
                }}
              >
                <div
                  className="p-2 rounded-lg"
                  style={{
                    background: 'rgba(255, 215, 0, 0.1)',
                    border: '1px solid rgba(255, 215, 0, 0.2)'
                  }}
                >
                  <MessageCircle className="h-5 w-5" style={{ color: 'var(--color-primary)' }} />
                </div>
                <div>
                  <div className="font-medium" style={{ color: 'var(--text-primary)' }}>{module.name}</div>
                  <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{module.count}次</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
});

// 快捷操作卡片
export const QuickActionsCard = memo(function QuickActionsCard({
  user,
  onNavigateToTickets,
  onNavigateToSecurity
}: {
  user: MockUser;
  onNavigateToTickets?: () => void;
  onNavigateToSecurity?: () => void;
}) {
  return (
    <div
      className="rounded-2xl p-6"
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        contain: 'layout paint',
      }}
    >
      <h3 className="font-semibold mb-6" style={{ color: 'var(--text-primary)' }}>快捷操作</h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* 账户安全 */}
        <div
          className="p-4 rounded-xl transition-all duration-300 cursor-pointer"
          style={{
            background: 'var(--bg-primary)',
            border: '1px solid var(--border-primary)'
          }}
          onClick={() => onNavigateToSecurity?.()}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'rgba(255, 215, 0, 0.3)';
            e.currentTarget.style.boxShadow = '0 4px 15px rgba(0,0,0,0.2)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--border-primary)';
            e.currentTarget.style.boxShadow = 'none';
          }}
        >
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center mb-3"
            style={{ background: 'rgba(255, 215, 0, 0.1)', border: '1px solid rgba(255, 215, 0, 0.2)' }}
          >
            <Key className="h-5 w-5" style={{ color: 'var(--color-primary)' }} />
          </div>
          <h4 className="font-medium mb-1" style={{ color: 'var(--text-primary)' }}>账户安全</h4>
          <p className="text-sm mb-3 min-h-[40px]" style={{ color: 'var(--text-tertiary)' }}>管理登录方式和密码设置</p>
          <div className="text-sm font-medium flex items-center gap-1" style={{ color: 'var(--color-primary)' }}>
            前往设置
            <span>→</span>
          </div>
        </div>

        {/* 邀请好友 */}
        <div
          className="p-4 rounded-xl transition-all duration-300 cursor-pointer"
          style={{
            background: 'var(--bg-primary)',
            border: '1px solid var(--border-primary)'
          }}
          onClick={() => {
            // TODO: Open invite dialog
            console.log('Open invite dialog');
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'rgba(34, 197, 94, 0.3)';
            e.currentTarget.style.boxShadow = '0 4px 15px rgba(0,0,0,0.2)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--border-primary)';
            e.currentTarget.style.boxShadow = 'none';
          }}
        >
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center mb-3"
            style={{ background: 'rgba(34, 197, 94, 0.1)', border: '1px solid rgba(34, 197, 94, 0.2)' }}
          >
            <Users className="h-5 w-5" style={{ color: 'var(--success)' }} />
          </div>
          <h4 className="font-medium mb-1" style={{ color: 'var(--text-primary)' }}>邀请好友</h4>
          <p className="text-sm mb-3 min-h-[40px]" style={{ color: 'var(--text-tertiary)' }}>邀请好友注册，获得积分奖励</p>
          <div
            className="inline-block text-xs px-2 py-0.5 rounded mb-3"
            style={{ background: 'rgba(34, 197, 94, 0.1)', color: 'var(--success)' }}
          >
            +50积分
          </div>
          <div className="text-sm font-medium flex items-center gap-1" style={{ color: 'var(--color-primary)' }}>
            生成邀请码
            <span>→</span>
          </div>
        </div>

        {/* 提交工单 */}
        <div
          className="p-4 rounded-xl transition-all duration-300 cursor-pointer"
          style={{
            background: 'var(--bg-primary)',
            border: '1px solid var(--border-primary)'
          }}
          onClick={() => onNavigateToTickets?.()}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'rgba(139, 92, 246, 0.3)';
            e.currentTarget.style.boxShadow = '0 4px 15px rgba(0,0,0,0.2)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--border-primary)';
            e.currentTarget.style.boxShadow = 'none';
          }}
        >
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center mb-3"
            style={{ background: 'rgba(139, 92, 246, 0.1)', border: '1px solid rgba(139, 92, 246, 0.2)' }}
          >
            <Headphones className="h-5 w-5" style={{ color: 'rgba(139, 92, 246, 1)' }} />
          </div>
          <h4 className="font-medium mb-1" style={{ color: 'var(--text-primary)' }}>提交工单</h4>
          <p className="text-sm mb-3 min-h-[40px]" style={{ color: 'var(--text-tertiary)' }}>遇到问题？我们随时为您提供帮助</p>
          <div className="flex items-center gap-1 text-xs mb-3" style={{ color: 'var(--success)' }}>
            <span className="w-2 h-2 rounded-full" style={{ background: 'var(--success)' }}></span>
            在线反馈
          </div>
          <div className="text-sm font-medium flex items-center gap-1" style={{ color: 'var(--color-primary)' }}>
            立即咨询
            <span>→</span>
          </div>
        </div>
      </div>
    </div>
  );
});
