'use client';

import { memo, useEffect, useRef, useState } from 'react';
import {
  Pencil, Crown, Coins, Plus, RefreshCw, Key, Users, Headphones,
  Loader2, Check, X, Camera, MessageCircle, Copy, Gift, CalendarCheck
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { trpc } from '@/trpc/client';
import { logClientDevError } from '@/lib/client-log';
import { createClient } from '@/lib/supabase';
import { getSafeErrorMessage } from '@/lib/safe-error-message';

// Mock user type
export interface MockUser {
  id?: string;
  email?: string;
  nickname?: string;
  full_name?: string;
  auth_provider?: 'email' | 'google' | 'unknown';
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
  const [profileMessage, setProfileMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // tRPC mutation for updating profile
  const updateProfileMutation = trpc.user.updateUserProfile.useMutation();

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

  useEffect(() => {
    setNickname(user?.nickname || '');
  }, [user?.nickname]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setProfileMessage(null);

    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        throw new Error('当前登录状态已失效，请重新登录后再上传头像。');
      }

      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/api/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
        body: formData,
      });

      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.url) {
        throw new Error(result?.error || '头像上传失败，请稍后重试。');
      }

      const updatedProfile = await updateProfileMutation.mutateAsync({ avatarUrl: result.url });
      onUserUpdate?.({
        ...user,
        avatar_url: updatedProfile?.avatar_url || result.url,
      });
      setProfileMessage({ tone: 'success', text: '头像已更新。' });
    } catch (error) {
      logClientDevError('Failed to upload avatar');
      setProfileMessage({
        tone: 'error',
        text: getSafeErrorMessage(error, '头像上传失败，请稍后重试。'),
      });
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleSaveNickname = async () => {
    if (!nickname.trim()) return;
    setSavingNickname(true);
    setProfileMessage(null);
    try {
      // 调用 tRPC mutation 保存昵称到数据库
      const updatedProfile = await updateProfileMutation.mutateAsync({ nickname: nickname.trim() });
      onUserUpdate?.({
        ...user,
        nickname: updatedProfile?.nickname || nickname.trim(),
        full_name: updatedProfile?.nickname || nickname.trim(),
      });
      setProfileMessage({ tone: 'success', text: '昵称已更新。' });
      setEditingNickname(false);
    } catch (error) {
      logClientDevError('Failed to save nickname');
      setProfileMessage({
        tone: 'error',
        text: getSafeErrorMessage(error, '昵称保存失败，请稍后重试。'),
      });
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

      {profileMessage && (
        <div
          className="mt-4 rounded-xl px-4 py-3 text-sm"
          aria-live="polite"
          style={{
            background:
              profileMessage.tone === 'success'
                ? 'rgba(34, 197, 94, 0.12)'
                : 'rgba(239, 68, 68, 0.12)',
            color: profileMessage.tone === 'success' ? '#86efac' : '#fca5a5',
            border: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          {profileMessage.text}
        </div>
      )}
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

  // 从 API 获取本月消耗数据
  const { data: creditsSummary } = trpc.credits.getCreditsSummary.useQuery({ period: 'month' });
  const monthlyUsed = creditsSummary?.totalSpent ?? 0;

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
  // 从 API 获取使用统计数据
  const { data: usageStats, isLoading } = trpc.user.getUserUsageStats.useQuery();

  // 使用 API 数据或默认值
  const stats = [
    { label: '累计对话次数', value: usageStats?.totalConversations?.toLocaleString() ?? '0' },
    { label: '累计消息数', value: usageStats?.totalMessages?.toLocaleString() ?? '0' },
    { label: '本月消耗积分', value: usageStats?.monthlyCreditsUsed?.toLocaleString() ?? '0' },
    { label: '使用天数', value: usageStats?.usageDays?.toLocaleString() ?? '0' },
  ];

  const topModules = usageStats?.topModules ?? [
    { name: 'AI 智能对话', count: 0 },
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
                className="flex items-center gap-3 p-4 rounded-xl transition-[background-color,border-color,color] duration-200 motion-reduce:transition-none"
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
  onNavigateToSecurity,
  onUserUpdate,
}: {
  user: MockUser;
  onNavigateToTickets?: () => void;
  onNavigateToSecurity?: () => void;
  onUserUpdate?: (user: MockUser) => void;
}) {
  const utils = trpc.useUtils();
  const [checkinDialogOpen, setCheckinDialogOpen] = useState(false);
  const [checkinFeedback, setCheckinFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [inviteFeedback, setInviteFeedback] = useState<string | null>(null);
  const { data: checkinStatus, isLoading: isCheckinLoading } =
    trpc.checkin.getCheckinStatus.useQuery(undefined, {
      refetchOnWindowFocus: false,
    });
  const claimCheckinMutation = trpc.checkin.claimDailyCheckin.useMutation({
    onSuccess: async (result) => {
      await Promise.all([
        utils.checkin.getCheckinStatus.invalidate(),
        utils.credits.getBalance.invalidate(),
        utils.credits.getCreditTransactions.invalidate(),
        utils.credits.getCreditsSummary.invalidate(),
        utils.user.getUserProfile.invalidate(),
        utils.user.getUserUsageStats.invalidate(),
      ]);

      if (result.alreadyClaimed) {
        setCheckinFeedback({ tone: 'success', text: '今天的签到奖励已经领取过了。' });
        return;
      }

      if (result.totalReward > 0) {
        onUserUpdate?.({
          ...user,
          credits: (user?.credits ?? 0) + result.totalReward,
        });
      }

      const bonusText = result.monthlyBonusCredits > 0
        ? `，其中包含月度全勤奖 ${result.monthlyBonusCredits} 积分`
        : '';

      setCheckinFeedback({
        tone: 'success',
        text: `签到成功，获得 ${result.totalReward} 积分${bonusText}。`,
      });
    },
  });
  const { data: invitationDashboard, isLoading: isInviteLoading } =
    trpc.invitation.getMyInvitationDashboard.useQuery(undefined, {
      enabled: inviteDialogOpen,
      refetchOnWindowFocus: false,
    });

  const handleCopyInviteValue = async (value: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setInviteFeedback(successMessage);
    } catch {
      setInviteFeedback('复制失败，请手动选择并复制。');
    }
  };

  const handleClaimCheckin = async () => {
    setCheckinFeedback(null);

    try {
      await claimCheckinMutation.mutateAsync();
    } catch (error) {
      setCheckinFeedback({
        tone: 'error',
        text: getSafeErrorMessage(error, '签到失败，请稍后重试。'),
      });
    }
  };

  return (
    <>
      <div
        className="rounded-2xl p-6"
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
          contain: 'layout paint',
        }}
      >
        <h3 className="font-semibold mb-6" style={{ color: 'var(--text-primary)' }}>快捷操作</h3>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* 每日签到 */}
        <div
          className="p-4 rounded-xl cursor-pointer transition-[border-color,box-shadow,transform] duration-200 motion-reduce:transition-none hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(0,0,0,0.18)]"
          data-testid="profile-checkin-card"
          style={{
            background: 'var(--bg-primary)',
            border: '1px solid var(--border-primary)'
          }}
          onClick={() => {
            setCheckinFeedback(null);
            setCheckinDialogOpen(true);
          }}
        >
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center mb-3"
            style={{ background: 'rgba(56, 189, 248, 0.12)', border: '1px solid rgba(56, 189, 248, 0.24)' }}
          >
            <CalendarCheck className="h-5 w-5" style={{ color: '#38bdf8' }} />
          </div>
          <h4 className="font-medium mb-1" style={{ color: 'var(--text-primary)' }}>每日签到</h4>
          <p className="text-sm mb-3 min-h-[40px]" style={{ color: 'var(--text-tertiary)' }}>
            {isCheckinLoading
              ? '正在读取今日签到状态...'
              : checkinStatus?.hasCheckedInToday
                ? `今天已领取 ${checkinStatus.todayRewardCredits} 积分`
                : `今天可领取 ${checkinStatus?.nextRewardCredits ?? 0} 积分`}
          </p>
          <div
            className="inline-block text-xs px-2 py-0.5 rounded mb-3"
            style={{
              background: checkinStatus?.hasCheckedInToday ? 'rgba(34, 197, 94, 0.1)' : 'rgba(56, 189, 248, 0.12)',
              color: checkinStatus?.hasCheckedInToday ? 'var(--success)' : '#38bdf8',
            }}
          >
            {checkinStatus?.hasCheckedInToday
              ? `本月 ${checkinStatus.monthlyCheckinCount} 天`
              : `第 ${checkinStatus?.currentCycleDay ?? 1} 天奖励`}
          </div>
          <div className="text-sm font-medium flex items-center gap-1" style={{ color: 'var(--color-primary)' }}>
            {checkinStatus?.hasCheckedInToday ? '查看进度' : '立即签到'}
            <span>→</span>
          </div>
        </div>

        {/* 账户安全 */}
        <div
          className="p-4 rounded-xl cursor-pointer transition-[border-color,box-shadow,transform] duration-200 motion-reduce:transition-none hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(0,0,0,0.18)]"
          style={{
            background: 'var(--bg-primary)',
            border: '1px solid var(--border-primary)'
          }}
          onClick={() => onNavigateToSecurity?.()}
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
          className="p-4 rounded-xl cursor-pointer transition-[border-color,box-shadow,transform] duration-200 motion-reduce:transition-none hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(0,0,0,0.18)]"
          data-testid="profile-invite-card"
          style={{
            background: 'var(--bg-primary)',
            border: '1px solid var(--border-primary)'
          }}
          onClick={() => {
            setInviteFeedback(null);
            setInviteDialogOpen(true);
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
          className="p-4 rounded-xl cursor-pointer transition-[border-color,box-shadow,transform] duration-200 motion-reduce:transition-none hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(0,0,0,0.18)]"
          style={{
            background: 'var(--bg-primary)',
            border: '1px solid var(--border-primary)'
          }}
          onClick={() => onNavigateToTickets?.()}
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

      <Dialog open={checkinDialogOpen} onOpenChange={setCheckinDialogOpen}>
        <DialogContent
          data-testid="profile-checkin-dialog"
          className="border"
          style={{
            background: 'var(--bg-secondary)',
            borderColor: 'var(--border-primary)',
            color: 'var(--text-primary)',
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <CalendarCheck className="h-5 w-5" style={{ color: '#38bdf8' }} />
              每日签到
            </DialogTitle>
            <DialogDescription style={{ color: 'var(--text-tertiary)' }}>
              连续签到按 5 天一循环发放奖励，本月签到满 30 天还可额外获得全勤奖。
            </DialogDescription>
          </DialogHeader>

          {isCheckinLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--color-primary)' }} />
            </div>
          ) : checkinStatus ? (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div className="rounded-xl p-4" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}>
                  <div className="text-sm mb-1" style={{ color: 'var(--text-tertiary)' }}>今日状态</div>
                  <div className="text-lg font-semibold" style={{ color: checkinStatus.hasCheckedInToday ? 'var(--success)' : '#38bdf8' }}>
                    {checkinStatus.hasCheckedInToday ? '已签到' : '待领取'}
                  </div>
                </div>
                <div className="rounded-xl p-4" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}>
                  <div className="text-sm mb-1" style={{ color: 'var(--text-tertiary)' }}>循环进度</div>
                  <div className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                    第 {checkinStatus.currentCycleDay} 天
                  </div>
                </div>
                <div className="rounded-xl p-4" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}>
                  <div className="text-sm mb-1" style={{ color: 'var(--text-tertiary)' }}>本月签到</div>
                  <div className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {checkinStatus.monthlyCheckinCount} / 30
                  </div>
                </div>
                <div className="rounded-xl p-4" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}>
                  <div className="text-sm mb-1" style={{ color: 'var(--text-tertiary)' }}>月度全勤奖</div>
                  <div className="text-lg font-semibold" style={{ color: 'var(--color-primary)' }}>
                    +{checkinStatus.monthlyBonusCredits}
                  </div>
                </div>
              </div>

              <div className="rounded-2xl p-4" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}>
                <div className="mb-3 flex items-center justify-between">
                  <h4 className="font-medium" style={{ color: 'var(--text-primary)' }}>5 天签到奖励</h4>
                  <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                    距全勤奖还差 {checkinStatus.daysUntilMonthlyBonus} 天
                  </span>
                </div>
                <div className="grid grid-cols-5 gap-2">
                  {Object.entries(checkinStatus.cycleRewards).map(([day, reward]) => {
                    const dayNumber = Number(day);
                    const isCurrent = dayNumber === checkinStatus.currentCycleDay;

                    return (
                      <div
                        key={day}
                        className="rounded-xl px-3 py-3 text-center"
                        style={{
                          background: isCurrent ? 'rgba(56, 189, 248, 0.12)' : 'rgba(255,255,255,0.03)',
                          border: isCurrent ? '1px solid rgba(56, 189, 248, 0.3)' : '1px solid var(--border-primary)',
                        }}
                      >
                        <div className="text-xs mb-1" style={{ color: 'var(--text-tertiary)' }}>第 {day} 天</div>
                        <div className="font-semibold" style={{ color: isCurrent ? '#38bdf8' : 'var(--text-primary)' }}>
                          +{reward}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-2xl p-4" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}>
                <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                  {checkinStatus.hasCheckedInToday
                    ? `今天已到账 ${checkinStatus.todayRewardCredits} 积分。明天签到将进入第 ${checkinStatus.nextCycleDay} 天奖励。`
                    : `今天签到可领取 ${checkinStatus.nextRewardCredits} 积分。完成本次签到后，本月进度将达到 ${checkinStatus.monthlyCheckinCount + 1} / 30。`}
                </div>
              </div>

              {checkinFeedback && (
                <div
                  data-testid="profile-checkin-feedback"
                  className="rounded-xl px-4 py-3 text-sm"
                  style={{
                    background: checkinFeedback.tone === 'success' ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                    color: checkinFeedback.tone === 'success' ? '#86efac' : '#fca5a5',
                    border: '1px solid rgba(255,255,255,0.06)',
                  }}
                >
                  {checkinFeedback.text}
                </div>
              )}

              <Button
                type="button"
                data-testid="checkin-claim-button"
                onClick={handleClaimCheckin}
                disabled={checkinStatus.hasCheckedInToday || claimCheckinMutation.isPending}
                className="w-full"
                style={{
                  background: checkinStatus.hasCheckedInToday
                    ? 'rgba(255,255,255,0.08)'
                    : 'linear-gradient(135deg, #38bdf8 0%, var(--color-primary) 100%)',
                  color: checkinStatus.hasCheckedInToday ? 'var(--text-tertiary)' : 'var(--bg-primary)',
                }}
              >
                {claimCheckinMutation.isPending
                  ? '签到中...'
                  : checkinStatus.hasCheckedInToday
                    ? '今日已签到'
                    : `立即签到并领取 +${checkinStatus.nextRewardCredits} 积分`}
              </Button>
            </div>
          ) : (
            <p className="py-8 text-sm" style={{ color: 'var(--text-tertiary)' }}>
              暂时无法加载签到信息，请稍后重试。
            </p>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={inviteDialogOpen} onOpenChange={setInviteDialogOpen}>
        <DialogContent
          className="border"
          style={{
            background: 'var(--bg-secondary)',
            borderColor: 'var(--border-primary)',
            color: 'var(--text-primary)',
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <Gift className="h-5 w-5" style={{ color: 'var(--success)' }} />
              邀请好友
            </DialogTitle>
            <DialogDescription style={{ color: 'var(--text-tertiary)' }}>
              使用你的邀请码邀请好友注册。好友完成注册后，双方都会获得积分奖励。
            </DialogDescription>
          </DialogHeader>

          {isInviteLoading ? (
            <div className="flex items-center justify-center py-12" data-testid="profile-invite-loading">
              <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--color-primary)' }} />
            </div>
          ) : invitationDashboard ? (
            <div className="space-y-5">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="rounded-xl p-4" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}>
                  <div className="text-sm mb-1" style={{ color: 'var(--text-tertiary)' }}>邀请奖励</div>
                  <div className="text-2xl font-bold" style={{ color: 'var(--success)' }}>
                    +{invitationDashboard.rewards.inviterReward}
                  </div>
                </div>
                <div className="rounded-xl p-4" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}>
                  <div className="text-sm mb-1" style={{ color: 'var(--text-tertiary)' }}>好友奖励</div>
                  <div className="text-2xl font-bold" style={{ color: 'var(--color-primary)' }}>
                    +{invitationDashboard.rewards.inviteeReward}
                  </div>
                </div>
                <div className="rounded-xl p-4" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}>
                  <div className="text-sm mb-1" style={{ color: 'var(--text-tertiary)' }}>累计邀请</div>
                  <div className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {invitationDashboard.summary.totalInvites}
                  </div>
                </div>
              </div>

              <div className="rounded-2xl p-4" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}>
                <div className="mb-2 text-sm" style={{ color: 'var(--text-tertiary)' }}>我的邀请码</div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <code
                    data-testid="profile-invitation-code"
                    className="flex-1 rounded-xl px-4 py-3 text-base font-semibold tracking-[0.18em]"
                    style={{
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid var(--border-primary)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    {invitationDashboard.invitationCode}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      handleCopyInviteValue(invitationDashboard.invitationCode, '邀请码已复制。')
                    }
                    className="gap-2"
                  >
                    <Copy className="h-4 w-4" />
                    复制邀请码
                  </Button>
                </div>
                <div className="mt-3 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                  邀请链接：
                </div>
                <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center">
                  <input
                    readOnly
                    value={invitationDashboard.inviteLink}
                    className="h-11 flex-1 rounded-xl border px-3 text-sm"
                    style={{
                      background: 'rgba(255,255,255,0.03)',
                      borderColor: 'var(--border-primary)',
                      color: 'var(--text-primary)',
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      handleCopyInviteValue(invitationDashboard.inviteLink, '邀请链接已复制。')
                    }
                    className="gap-2"
                  >
                    <Copy className="h-4 w-4" />
                    复制链接
                  </Button>
                </div>
                {inviteFeedback && (
                  <p className="mt-3 text-sm" style={{ color: 'var(--success)' }}>
                    {inviteFeedback}
                  </p>
                )}
              </div>

              <div className="rounded-2xl p-4" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}>
                <div className="mb-3 flex items-center justify-between">
                  <h4 className="font-medium" style={{ color: 'var(--text-primary)' }}>最近邀请记录</h4>
                  <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                    已奖励 {invitationDashboard.summary.rewardedInvites} 人
                  </span>
                </div>
                {invitationDashboard.records.length > 0 ? (
                  <div className="space-y-3">
                    {invitationDashboard.records.map((record) => (
                      <div
                        key={record.id}
                        className="flex items-center justify-between rounded-xl px-4 py-3"
                        style={{ background: 'rgba(255,255,255,0.03)' }}
                      >
                        <div>
                          <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                            {record.invitee_email || '待完成注册'}
                          </div>
                          <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                            {new Date(record.created_at).toLocaleString('zh-CN')}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-medium" style={{ color: 'var(--success)' }}>
                            +{record.inviter_reward}
                          </div>
                          <div className="text-xs uppercase tracking-[0.18em]" style={{ color: 'var(--text-tertiary)' }}>
                            {record.status}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                    还没有邀请记录。把邀请码发给好友后，这里会显示注册结果。
                  </p>
                )}
              </div>
            </div>
          ) : (
            <p className="py-8 text-sm" style={{ color: 'var(--text-tertiary)' }}>
              暂时无法加载邀请信息，请稍后重试。
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
});
