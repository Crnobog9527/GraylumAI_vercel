'use client';

import { memo, useState } from 'react';
import { Crown, Zap, CheckCircle2, Package } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { trpc } from '@/trpc/client';

interface MockUser {
  subscription_tier?: 'free' | 'basic' | 'pro' | 'enterprise';
  credits?: number;
  total_credits_used?: number;
}

interface PlanConfig {
  name: string;
  level: string;
  price: { monthly: number; yearly: number };
  features: string[];
  recommended?: boolean;
  highlight?: boolean;
}

// 积分加油包区块
const CreditPackagesSection = memo(function CreditPackagesSection({
  onBuyClick
}: {
  onBuyClick?: () => void;
}) {
  // 从 API 获取积分加油包数据
  const { data: packages = [], isLoading } = trpc.settings.getCreditPackages.useQuery();

  // 如果 API 没有数据，使用默认数据
  const displayPackages = packages.length > 0 ? packages : [
    { id: '1', credits: 500, bonus_credits: 0, price: 4.9, is_popular: false },
    { id: '2', credits: 1200, bonus_credits: 100, price: 9.9, is_popular: true },
    { id: '3', credits: 3000, bonus_credits: 300, price: 19.9, is_popular: false },
    { id: '4', credits: 6500, bonus_credits: 800, price: 39.9, is_popular: false },
  ];

  return (
    <div
      className="rounded-2xl p-6 md:p-8 mt-6 transition-all duration-300"
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
      }}
    >
      <div className="flex items-center gap-3 mb-6">
        <div
          className="p-2 rounded-lg"
          style={{ background: 'rgba(139, 92, 246, 0.1)', border: '1px solid rgba(139, 92, 246, 0.2)' }}
        >
          <Package className="h-5 w-5" style={{ color: 'rgba(139, 92, 246, 1)' }} />
        </div>
        <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>积分加油包</h3>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {isLoading ? (
          <div className="col-span-4 text-center py-8" style={{ color: 'var(--text-tertiary)' }}>
            加载中...
          </div>
        ) : displayPackages.map((pkg) => (
          <div
            key={pkg.id}
            data-testid={`profile-credit-package-${pkg.id}`}
            className="relative p-4 rounded-xl text-center transition-all duration-300"
            style={{
              background: 'var(--bg-primary)',
              border: pkg.is_popular ? '2px solid rgba(59, 130, 246, 0.5)' : '1px solid var(--border-primary)',
              boxShadow: pkg.is_popular ? '0 0 20px rgba(59, 130, 246, 0.2)' : 'none'
            }}
          >
            {pkg.is_popular && (
              <div
                className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-xs font-medium"
                style={{ background: 'rgba(59, 130, 246, 0.2)', color: '#3B82F6', border: '1px solid rgba(59, 130, 246, 0.3)' }}
              >
                热门
              </div>
            )}
            <div className="flex items-center justify-center gap-1 mb-2 mt-2">
              <Zap className="h-5 w-5" style={{ color: 'var(--color-primary)' }} />
              <span
                className="text-2xl font-bold"
                style={{
                  background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent'
                }}
              >
                {pkg.credits.toLocaleString()}
              </span>
            </div>
            {pkg.bonus_credits > 0 && (
              <div className="text-xs mb-2" style={{ color: 'var(--success)' }}>
                +{pkg.bonus_credits} 赠送
              </div>
            )}
            <div className="text-lg font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>
              ${pkg.price.toFixed(1)}
            </div>
            <div
              data-testid="profile-credit-package-name"
              className="text-sm font-medium mb-3"
              style={{ color: 'var(--text-primary)' }}
            >
              {'name' in pkg && typeof pkg.name === 'string' ? pkg.name : `${pkg.credits.toLocaleString()} 积分包`}
            </div>
            <Button
              onClick={onBuyClick}
              size="sm"
              className="w-full gap-2"
              style={{
                background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                color: 'var(--bg-primary)'
              }}
            >
              购买
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
});

// 会员订阅卡片
export const SubscriptionCard = memo(function SubscriptionCard({ user }: { user: MockUser }) {
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly');

  const subscriptionTier = user?.subscription_tier || 'free';

  // 从 API 获取会员等级数据
  const { data: apiPlans = [], isLoading: plansLoading } = trpc.settings.getMembershipPlans.useQuery();

  // 默认会员等级配置 (API 无数据时使用)
  const defaultPlanConfigs: PlanConfig[] = [
    {
      name: '免费会员',
      level: 'free',
      price: { monthly: 0, yearly: 0 },
      features: ['注册赠送100积分（一次性）', '对话历史保存5天'],
      recommended: false,
      highlight: false
    },
    {
      name: '进阶会员',
      level: 'pro',
      price: { monthly: 9.9, yearly: 95 },
      features: ['月度积分1500积分', '购买加油包享受95折', '对话历史保存1个月'],
      recommended: false,
      highlight: false
    },
    {
      name: '黄金会员',
      level: 'gold',
      price: { monthly: 29.9, yearly: 287 },
      features: ['月度积分5500积分', '购买加油包享受9折', '对话历史保存1个月'],
      recommended: true,
      highlight: true
    }
  ];

  // 将 API 数据转换为 PlanConfig 格式
  const displayPlans: PlanConfig[] = apiPlans.length > 0
    ? apiPlans.map(plan => ({
        name: plan.name,
        level: plan.level,
        price: plan.price,
        features: plan.features?.length > 0 ? plan.features : generateDefaultFeatures(plan),
        recommended: plan.recommended,
        highlight: plan.highlight,
      }))
    : defaultPlanConfigs;

  // 根据计划配置生成默认特性列表
  function generateDefaultFeatures(plan: typeof apiPlans[0]): string[] {
    const features: string[] = [];
    if (plan.level === 'free') {
      features.push('注册赠送100积分（一次性）');
    } else {
      if (plan.credits?.monthly) {
        features.push(`月度积分${plan.credits.monthly}积分`);
      }
      if (plan.discount && plan.discount > 0) {
        const discountPercent = Math.round((1 - plan.discount) * 100);
        features.push(`购买加油包享受${discountPercent}折`);
      }
    }
    features.push(`对话历史保存${plan.historyRetentionDays ?? 7}天`);
    return features;
  }

  const handleSelectPlan = (plan: PlanConfig) => {
    // TODO: Navigate to payment or show payment dialog
    console.log('Selected plan:', plan);
  };

  return (
    <div
      className="rounded-2xl p-6 md:p-8 mb-6 transition-all duration-300"
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div
            className="p-2 rounded-lg"
            style={{ background: 'rgba(255, 215, 0, 0.1)', border: '1px solid rgba(255, 215, 0, 0.2)' }}
          >
            <Crown className="h-5 w-5" style={{ color: 'var(--color-primary)' }} />
          </div>
          <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>会员订阅</h3>
        </div>

        {/* Billing Toggle */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setBillingCycle('monthly')}
            className="px-4 py-1.5 rounded-lg text-sm font-medium transition-all"
            style={{
              background: billingCycle === 'monthly' ? 'rgba(255, 215, 0, 0.2)' : 'transparent',
              color: billingCycle === 'monthly' ? 'var(--color-primary)' : 'var(--text-tertiary)',
              border: billingCycle === 'monthly' ? '1px solid rgba(255, 215, 0, 0.3)' : '1px solid transparent'
            }}
          >
            按月
          </button>
          <button
            onClick={() => setBillingCycle('yearly')}
            className="px-4 py-1.5 rounded-lg text-sm font-medium transition-all flex items-center gap-2"
            style={{
              background: billingCycle === 'yearly' ? 'rgba(255, 215, 0, 0.2)' : 'transparent',
              color: billingCycle === 'yearly' ? 'var(--color-primary)' : 'var(--text-tertiary)',
              border: billingCycle === 'yearly' ? '1px solid rgba(255, 215, 0, 0.3)' : '1px solid transparent'
            }}
          >
            按年
          </button>
        </div>
      </div>

      {/* Plans Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {plansLoading ? (
          <div className="col-span-3 text-center py-8" style={{ color: 'var(--text-tertiary)' }}>
            加载中...
          </div>
        ) : displayPlans.map((plan) => {
          const isCurrentPlan = plan.level === subscriptionTier || (plan.level === 'free' && subscriptionTier === 'free');
          const isHighlight = plan.recommended || plan.highlight;
          const price = billingCycle === 'monthly' ? plan.price.monthly : plan.price.yearly;

          return (
            <div
              key={plan.level}
              data-testid={`profile-membership-plan-${plan.level}`}
              className="relative rounded-xl p-5 transition-all duration-300"
              style={{
                background: isHighlight ? 'linear-gradient(135deg, rgba(99, 102, 241, 0.1) 0%, rgba(139, 92, 246, 0.1) 100%)' : 'var(--bg-primary)',
                border: isHighlight ? '2px solid rgba(139, 92, 246, 0.5)' : '1px solid var(--border-primary)',
                boxShadow: isHighlight ? '0 0 30px rgba(139, 92, 246, 0.2)' : 'none'
              }}
            >
              {/* Recommended Badge */}
              {plan.recommended && (
                <div
                  className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-xs font-medium"
                  style={{
                    background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.3) 0%, rgba(99, 102, 241, 0.3) 100%)',
                    color: '#A78BFA',
                    border: '1px solid rgba(139, 92, 246, 0.4)'
                  }}
                >
                  推荐
                </div>
              )}

              {/* Plan Name */}
              <h4 data-testid="profile-membership-plan-name" className="text-center font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
                {plan.name}
              </h4>

              {/* Price */}
              <div className="text-center mb-4">
                {price === 0 ? (
                  <span className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>免费</span>
                ) : billingCycle === 'yearly' ? (
                  <div className="flex flex-col items-center gap-1">
                    {/* Original price strikethrough */}
                    <div className="flex items-center gap-2">
                      <span className="text-sm line-through" style={{ color: 'var(--text-disabled)' }}>
                        ${plan.price.monthly.toFixed(1)}/月
                      </span>
                      <span
                        className="text-xs px-1.5 py-0.5 rounded"
                        style={{ background: 'rgba(34, 197, 94, 0.2)', color: 'var(--success)' }}
                      >
                        省{Math.round((1 - price / (plan.price.monthly * 12)) * 100)}%
                      </span>
                    </div>
                    {/* Yearly price per month */}
                    <div className="flex items-baseline justify-center gap-1">
                      <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>$</span>
                      <span
                        className="text-3xl font-bold"
                        style={{
                          background: isHighlight
                            ? 'linear-gradient(135deg, #A78BFA 0%, #818CF8 100%)'
                            : 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                          WebkitBackgroundClip: 'text',
                          WebkitTextFillColor: 'transparent'
                        }}
                      >
                        {(price / 12).toFixed(1)}
                      </span>
                      <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>/月</span>
                    </div>
                    <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      年付共 ${price.toFixed(1)}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-baseline justify-center gap-1">
                    <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>$</span>
                    <span
                      className="text-3xl font-bold"
                      style={{
                        background: isHighlight
                          ? 'linear-gradient(135deg, #A78BFA 0%, #818CF8 100%)'
                          : 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent'
                      }}
                    >
                      {price.toFixed(1)}
                    </span>
                    <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>/月</span>
                  </div>
                )}
              </div>

              {/* Features */}
              <div className="space-y-2 mb-5">
                {plan.features?.map((feature, idx) => (
                  <div key={idx} className="flex items-start gap-2 text-sm">
                    <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" style={{ color: 'var(--success)' }} />
                    <span style={{ color: 'var(--text-secondary)' }}>{feature}</span>
                  </div>
                ))}
              </div>

              {/* Action Button */}
              <Button
                onClick={() => handleSelectPlan(plan)}
                className="w-full"
                disabled={isCurrentPlan}
                style={{
                  background: isCurrentPlan
                    ? 'var(--bg-tertiary)'
                    : 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                  color: isCurrentPlan ? 'var(--text-tertiary)' : 'var(--bg-primary)',
                  cursor: isCurrentPlan ? 'default' : 'pointer'
                }}
              >
                {isCurrentPlan ? '当前套餐' : '选择'}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
});

// 积分概览卡片（订阅管理页面用）
export const CreditStatsCard = memo(function CreditStatsCard({ user }: { user: MockUser }) {
  const credits = user?.credits || 0;

  // 从 API 获取积分统计数据
  const { data: creditsSummary } = trpc.credits.getCreditsSummary.useQuery({ period: 'month' });
  const { data: allTimeSummary } = trpc.credits.getCreditsSummary.useQuery({ period: 'year' });
  const monthlyUsed = creditsSummary?.totalSpent ?? 0;
  const totalUsed = allTimeSummary?.totalSpent ?? user?.total_credits_used ?? 0;

  return (
    <>
      <div
        className="rounded-2xl p-6 md:p-8 mb-6 transition-all duration-300"
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
        }}
      >
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>积分概览</h3>
          <Zap className="h-5 w-5" style={{ color: 'var(--color-primary)' }} />
        </div>

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-8">
            <div>
              <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-tertiary)' }}>积分余额</div>
              <div
                className="text-3xl font-bold"
                style={{
                  background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent'
                }}
              >
                {credits.toLocaleString()}
              </div>
            </div>

            <div className="pl-8 hidden md:block" style={{ borderLeft: '1px solid var(--border-primary)' }}>
              <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-tertiary)' }}>本月消耗</div>
              <div className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{monthlyUsed.toLocaleString()}</div>
            </div>

            <div className="pl-8 hidden md:block" style={{ borderLeft: '1px solid var(--border-primary)' }}>
              <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-tertiary)' }}>累计消耗</div>
              <div className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{totalUsed.toLocaleString()}</div>
            </div>
          </div>
        </div>
      </div>

      {/* 积分加油包 */}
      <CreditPackagesSection onBuyClick={() => console.log('Open credits dialog')} />
    </>
  );
});
