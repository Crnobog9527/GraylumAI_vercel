'use client';

import { memo, startTransition, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Crown, Zap, CheckCircle2, Package } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { trpc } from '@/trpc/client';
import { getSafeErrorMessage } from '@/lib/safe-error-message';
import { formatCreditsBalance } from '@/components/credits/balancePresentation';
import {
  getMembershipPlanButtonState,
  getPlanEligibilityKey,
  type MembershipPlanEligibilityEntry,
} from './subscriptionPlanButtonState';
import { invalidatePostCheckoutMembershipQueries } from './checkoutSyncInvalidations';

interface MockUser {
  subscription_tier?: 'free' | 'basic' | 'pro' | 'enterprise';
  credits?: number;
  total_credits_used?: number;
}

interface PlanConfig {
  id: string;
  name: string;
  level: string;
  price: { monthly: number; yearly: number };
  features: string[];
  recommended?: boolean;
  highlight?: boolean;
  checkoutReady?: {
    monthly: boolean;
    yearly: boolean;
  };
}

interface PurchaseIntent {
  kind: 'plan' | 'package';
  title: string;
  summary: string;
}

interface CheckoutNotice {
  tone: 'syncing' | 'success' | 'warning' | 'error' | 'cancelled';
  message: string;
}

const PurchaseIntentDialog = memo(function PurchaseIntentDialog({
  intent,
  onOpenChange,
  onContactSupport,
}: {
  intent: PurchaseIntent | null;
  onOpenChange: (open: boolean) => void;
  onContactSupport: () => void;
}) {
  return (
    <Dialog open={!!intent} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md max-h-[90vh] overflow-y-auto"
        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}
      >
        <DialogHeader>
          <DialogTitle style={{ color: 'var(--text-primary)' }}>支付暂不可用</DialogTitle>
          <DialogDescription style={{ color: 'var(--text-tertiary)' }}>
            当前无法直接继续支付，你选择的是 <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{intent?.title}</span>。
          </DialogDescription>
        </DialogHeader>

        {intent?.summary && (
          <div
            className="rounded-xl border px-4 py-3 text-sm"
            style={{
              borderColor: 'rgba(255,255,255,0.08)',
              background: 'var(--bg-primary)',
              color: 'var(--text-secondary)',
            }}
          >
            {intent.summary}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}
          >
            稍后再说
          </Button>
          <Button
            type="button"
            onClick={onContactSupport}
            style={{
              background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
              color: 'var(--bg-primary)',
            }}
          >
            提交工单咨询
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

const emptyStateCardStyle = {
  borderColor: 'rgba(255,255,255,0.08)',
  background: 'var(--bg-primary)',
} as const;

// 积分加油包区块
const CreditPackagesSection = memo(function CreditPackagesSection({
  onBuyClick,
  pendingPackageId,
}: {
  onBuyClick?: (pkg: { id: string; name?: string; credits: number; bonus_credits: number; price: number; checkout_ready?: boolean }) => void;
  pendingPackageId?: string | null;
}) {
  // 从 API 获取积分加油包数据
  const { data: packages = [], isLoading } = trpc.settings.getCreditPackages.useQuery();

  return (
    <div
      className="mt-6 rounded-2xl p-6 md:p-8"
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

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {isLoading ? (
          <div className="col-span-4 text-center py-8" style={{ color: 'var(--text-tertiary)' }}>
            加载中...
          </div>
        ) : packages.length === 0 ? (
          <div
            className="col-span-4 rounded-xl border px-4 py-6 text-center text-sm"
            style={emptyStateCardStyle}
          >
            <div className="font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
              积分包暂未发布
            </div>
            <div style={{ color: 'var(--text-tertiary)' }}>
              后台尚未配置可展示的积分包，发布后这里会自动同步。
            </div>
          </div>
        ) : packages.map((pkg) => (
          <div
            key={pkg.id}
            data-testid={`profile-credit-package-${pkg.id}`}
            className="relative rounded-xl p-4 text-center transition-colors duration-200"
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
              onClick={() => onBuyClick?.(pkg)}
              size="sm"
              disabled={pendingPackageId === pkg.id}
              className="w-full gap-2"
              style={{
                background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                color: 'var(--bg-primary)'
              }}
            >
              {pendingPackageId === pkg.id ? '跳转中...' : '购买'}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
});

// 会员订阅卡片
export const SubscriptionCard = memo(function SubscriptionCard({ user: _user }: { user: MockUser }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const utils = trpc.useUtils();
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [purchaseIntent, setPurchaseIntent] = useState<PurchaseIntent | null>(null);
  const [pendingCheckoutKey, setPendingCheckoutKey] = useState<string | null>(null);
  const [checkoutNotice, setCheckoutNotice] = useState<CheckoutNotice | null>(null);
  const syncedCheckoutSessionRef = useRef<string | null>(null);

  const createCheckoutSession = trpc.payments.createCheckoutSession.useMutation();
  const changeSubscriptionPlan = trpc.payments.changeSubscriptionPlan.useMutation();
  const syncCheckoutSession = trpc.payments.syncCheckoutSession.useMutation();
  const syncCheckoutSessionMutation = syncCheckoutSession.mutateAsync;
  const checkoutState = searchParams.get('checkout');
  const checkoutSessionId = searchParams.get('session_id');

  const clearCheckoutParams = () => {
    if (typeof window === 'undefined') {
      return;
    }

    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete('checkout');
    nextUrl.searchParams.delete('session_id');
    const relativeUrl = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;

    window.history.replaceState(window.history.state, '', relativeUrl);
    startTransition(() => {
      router.replace(relativeUrl, { scroll: false });
    });
  };

  // 从 API 获取会员等级数据
  const { data: apiPlans = [], isLoading: plansLoading } = trpc.settings.getMembershipPlans.useQuery();
  const {
    data: eligibilityMatrix,
    isLoading: eligibilityLoading,
  } = trpc.payments.getMembershipEligibilityMatrix.useQuery();

  const eligibilityByPlanCycle = useMemo(() => {
    const entries = new Map<string, MembershipPlanEligibilityEntry>();

    for (const entry of eligibilityMatrix?.entries ?? []) {
      entries.set(getPlanEligibilityKey(entry.planId, entry.billingCycle), entry);
    }

    return entries;
  }, [eligibilityMatrix?.entries]);

  useEffect(() => {
    if (checkoutState !== 'success' || !checkoutSessionId) {
      return;
    }

    if (syncedCheckoutSessionRef.current === checkoutSessionId) {
      return;
    }

    syncedCheckoutSessionRef.current = checkoutSessionId;
    setCheckoutNotice({
      tone: 'syncing',
      message: '正在向 Stripe 核对这笔支付并同步到账状态...',
    });

    void syncCheckoutSessionMutation({ sessionId: checkoutSessionId })
      .then(async (result) => {
        void invalidatePostCheckoutMembershipQueries(utils);

        if (result.fulfilledAt || result.orderStatus === 'completed') {
          setCheckoutNotice({
            tone: 'success',
            message: '支付已确认，订单状态已同步到账。',
          });
          clearCheckoutParams();
          return;
        }

        setCheckoutNotice({
          tone: 'warning',
          message: '支付已返回，系统仍在等待 Stripe 最终回调。若稍后仍未更新，请刷新页面或提交工单。',
        });
      })
      .catch((error) => {
        syncedCheckoutSessionRef.current = null;
        setCheckoutNotice({
          tone: 'error',
          message: getSafeErrorMessage(error, '订单同步失败，请稍后重试或提交工单。'),
        });
      });
  }, [checkoutSessionId, checkoutState, router, syncCheckoutSessionMutation, utils]);

  useEffect(() => {
    if (checkoutState !== 'canceled' && checkoutState !== 'cancelled') {
      return;
    }

    if (!checkoutSessionId) {
      setCheckoutNotice({
        tone: 'cancelled',
        message: '你已取消本次支付，没有发生扣费。',
      });
      clearCheckoutParams();
      return;
    }

    if (syncedCheckoutSessionRef.current === checkoutSessionId) {
      return;
    }

    syncedCheckoutSessionRef.current = checkoutSessionId;
    setCheckoutNotice({
      tone: 'syncing',
      message: '正在记录这笔已取消的支付会话...',
    });

    void syncCheckoutSessionMutation({
      sessionId: checkoutSessionId,
      checkoutState: 'canceled',
    })
      .then(async () => {
        void utils.payments.listBillingRecords.invalidate();
        setCheckoutNotice({
          tone: 'cancelled',
          message: '你已取消本次支付，没有发生扣费。',
        });
        clearCheckoutParams();
      })
      .catch(() => {
        syncedCheckoutSessionRef.current = null;
        setCheckoutNotice({
          tone: 'cancelled',
          message: '你已取消本次支付，没有发生扣费。账单状态稍后会自动同步。',
        });
      });
  }, [checkoutSessionId, checkoutState, syncCheckoutSessionMutation, utils]);

  // 将 API 数据转换为 PlanConfig 格式
  const displayPlans: PlanConfig[] = apiPlans.map(plan => ({
    id: plan.id,
    name: plan.name,
    level: plan.level,
    price: plan.price,
    features: plan.features?.length > 0 ? plan.features : generateDefaultFeatures(plan),
    recommended: plan.recommended,
    highlight: plan.highlight,
    checkoutReady: plan.checkoutReady,
  }));

  // 根据计划配置生成默认特性列表
  function generateDefaultFeatures(plan: any): string[] {
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

  const handleSelectPlan = async (plan: PlanConfig) => {
    const price = billingCycle === 'monthly' ? plan.price.monthly : plan.price.yearly;
    const unit = billingCycle === 'monthly' ? '/月' : '/年';
    const eligibility = eligibilityByPlanCycle.get(getPlanEligibilityKey(plan.id, billingCycle));
    const ready = billingCycle === 'monthly'
      ? plan.checkoutReady?.monthly
      : plan.checkoutReady?.yearly;
    const buttonState = getMembershipPlanButtonState({
      eligibility,
      eligibilityLoading,
      checkoutReady: Boolean(ready),
      pending: pendingCheckoutKey === `plan:${plan.id}:${billingCycle}`,
    });

    if (!buttonState.canCreateCheckout && !buttonState.canChangeSubscriptionPlan) {
      const summary = eligibility?.action === 'createCheckoutSession' && !ready
        ? `当前展示价格为 $${price.toFixed(1)}${unit}，但该套餐的 Stripe 支付配置尚未完整启用。你可以先提交工单，我们会按最新配置协助你完成开通。`
        : eligibility?.action === 'changeSubscriptionPlan' && !ready
          ? `当前展示价格为 $${price.toFixed(1)}${unit}，但该套餐的 Stripe 支付配置尚未完整启用。你可以先提交工单，我们会协助处理升级。`
        : buttonState.message ?? '正在确认当前会员状态，请稍后再试。';

      setPurchaseIntent({
        kind: 'plan',
        title: plan.name,
        summary,
      });
      return;
    }

    if (buttonState.canChangeSubscriptionPlan) {
      const checkoutKey = `plan:${plan.id}:${billingCycle}`;
      setPendingCheckoutKey(checkoutKey);

      try {
        const result = await changeSubscriptionPlan.mutateAsync({
          planId: plan.id,
          billingCycle,
        });

        await Promise.all([
          utils.user.getUserProfile.invalidate(),
          utils.payments.getMembershipEligibilityMatrix.invalidate(),
          utils.payments.listBillingRecords.invalidate(),
        ]);

        setCheckoutNotice({
          tone: 'success',
          message: `${plan.name} 升级请求已提交，当前订阅状态为 ${result.status}。`,
        });
      } catch (error) {
        setPurchaseIntent({
          kind: 'plan',
          title: plan.name,
          summary: getSafeErrorMessage(error, '切换订阅套餐失败，请稍后重试。'),
        });
      } finally {
        setPendingCheckoutKey(null);
      }
      return;
    }

    if (price <= 0 || plan.level === 'free') {
      setPurchaseIntent({
        kind: 'plan',
        title: plan.name,
        summary: '当前是免费方案，无需额外购买即可使用基础功能。',
      });
      return;
    }

    const checkoutKey = `plan:${plan.id}:${billingCycle}`;
    setPendingCheckoutKey(checkoutKey);

    try {
      const result = await createCheckoutSession.mutateAsync({
        kind: 'membership_plan',
        planId: plan.id,
        billingCycle,
      });
      window.location.assign(result.checkoutUrl);
    } catch (error) {
      setPurchaseIntent({
        kind: 'plan',
        title: plan.name,
        summary: getSafeErrorMessage(error, '创建支付会话失败，请稍后重试。'),
      });
    } finally {
      setPendingCheckoutKey(null);
    }
  };

  const handleContactSupport = () => {
    setPurchaseIntent(null);
    router.push('/profile?tab=tickets');
  };

  return (
    <div
      className="mb-6 rounded-2xl p-6 md:p-8"
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
      }}
      >
        {/* Header */}
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between mb-6">
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
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => setBillingCycle('monthly')}
            className="rounded-lg px-4 py-1.5 text-sm font-medium transition-colors duration-200"
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
            className="flex items-center gap-2 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors duration-200"
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

        <div className="mb-6 text-sm" style={{ color: 'var(--text-tertiary)' }}>
          年付积分按月释放，未使用积分可累积，不按月清零。
        </div>

        {checkoutNotice && (
          <div
            className="mb-6 rounded-xl border px-4 py-3 text-sm"
            style={{
              borderColor:
                checkoutNotice.tone === 'success'
                  ? 'rgba(34, 197, 94, 0.25)'
                  : checkoutNotice.tone === 'warning' || checkoutNotice.tone === 'cancelled'
                    ? 'rgba(245, 158, 11, 0.25)'
                    : checkoutNotice.tone === 'error'
                      ? 'rgba(239, 68, 68, 0.25)'
                      : 'rgba(59, 130, 246, 0.25)',
              background:
                checkoutNotice.tone === 'success'
                  ? 'rgba(34, 197, 94, 0.08)'
                  : checkoutNotice.tone === 'warning' || checkoutNotice.tone === 'cancelled'
                    ? 'rgba(245, 158, 11, 0.08)'
                    : checkoutNotice.tone === 'error'
                      ? 'rgba(239, 68, 68, 0.08)'
                      : 'rgba(59, 130, 246, 0.08)',
              color: 'var(--text-secondary)',
            }}
          >
            {checkoutNotice.message}
          </div>
        )}

      {/* Plans Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {plansLoading ? (
          <div className="col-span-3 text-center py-8" style={{ color: 'var(--text-tertiary)' }}>
            加载中...
          </div>
        ) : displayPlans.length === 0 ? (
          <div
            className="col-span-3 rounded-xl border px-4 py-6 text-center text-sm"
            style={emptyStateCardStyle}
          >
            <div className="font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
              会员方案暂未发布
            </div>
            <div style={{ color: 'var(--text-tertiary)' }}>
              后台尚未发布可展示的会员计划，配置完成后这里会自动更新。
            </div>
          </div>
        ) : displayPlans.map((plan) => {
          const isHighlight = plan.recommended || plan.highlight;
          const price = billingCycle === 'monthly' ? plan.price.monthly : plan.price.yearly;
          const warmHighlightBackground = 'linear-gradient(135deg, rgba(245, 158, 11, 0.12) 0%, rgba(249, 115, 22, 0.14) 100%)';
          const warmHighlightBorder = '2px solid rgba(245, 158, 11, 0.45)';
          const warmHighlightShadow = '0 0 30px rgba(249, 115, 22, 0.16)';
          const warmHighlightText = 'linear-gradient(135deg, #FBBF24 0%, #FB923C 100%)';
          const checkoutKey = `plan:${plan.id}:${billingCycle}`;
          const eligibility = eligibilityByPlanCycle.get(getPlanEligibilityKey(plan.id, billingCycle));
          const isPendingPlan = pendingCheckoutKey === checkoutKey;
          const ready = billingCycle === 'monthly'
            ? plan.checkoutReady?.monthly
            : plan.checkoutReady?.yearly;
          const buttonState = getMembershipPlanButtonState({
            eligibility,
            eligibilityLoading,
            checkoutReady: Boolean(ready),
            pending: isPendingPlan,
          });

          return (
            <div
              key={plan.id}
              data-testid={`profile-membership-plan-${plan.level}`}
              data-plan-id={plan.id}
              data-plan-level={plan.level}
              data-highlight-tone={isHighlight ? 'warm' : 'default'}
              className="relative rounded-xl p-5 transition-colors duration-200"
              style={{
                background: isHighlight ? warmHighlightBackground : 'var(--bg-primary)',
                border: isHighlight ? warmHighlightBorder : '1px solid var(--border-primary)',
                boxShadow: isHighlight ? warmHighlightShadow : 'none'
              }}
            >
              {/* Recommended Badge */}
              {plan.recommended && (
                <div
                  data-testid={`profile-membership-plan-recommended-${plan.level}`}
                  className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-xs font-medium"
                  style={{
                    background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.24) 0%, rgba(249, 115, 22, 0.24) 100%)',
                    color: '#FBBF24',
                    border: '1px solid rgba(245, 158, 11, 0.4)'
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
                            ? warmHighlightText
                            : 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                          WebkitBackgroundClip: 'text',
                          WebkitTextFillColor: 'transparent'
                        }}
                      >
                        {(price / 12).toFixed(1)}
                      </span>
                      <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>/月</span>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-baseline justify-center gap-1">
                    <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>$</span>
                    <span
                      className="text-3xl font-bold"
                      style={{
                        background: isHighlight
                          ? warmHighlightText
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
                disabled={buttonState.disabled}
                style={{
                  background: buttonState.disabled
                    ? 'var(--bg-tertiary)'
                    : 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                  color: buttonState.disabled ? 'var(--text-tertiary)' : 'var(--bg-primary)',
                  cursor: buttonState.disabled ? 'default' : 'pointer'
                }}
              >
                {buttonState.label}
              </Button>
            </div>
          );
        })}
      </div>

      <PurchaseIntentDialog
        intent={purchaseIntent}
        onOpenChange={(open) => {
          if (!open) setPurchaseIntent(null);
        }}
        onContactSupport={handleContactSupport}
      />
    </div>
  );
});

// 积分概览卡片（订阅管理页面用）
export const CreditStatsCard = memo(function CreditStatsCard({ user }: { user: MockUser }) {
  const router = useRouter();
  const [purchaseIntent, setPurchaseIntent] = useState<PurchaseIntent | null>(null);
  const [pendingCheckoutPackageId, setPendingCheckoutPackageId] = useState<string | null>(null);
  const credits = typeof user?.credits === 'number' ? user.credits : null;
  const hasVerifiedBalance = credits !== null;
  const createCheckoutSession = trpc.payments.createCheckoutSession.useMutation();

  // 从 API 获取积分统计数据
  const { data: creditsSummary } = trpc.credits.getCreditsSummary.useQuery({ period: 'month' });
  const { data: allTimeSummary } = trpc.credits.getCreditsSummary.useQuery({ period: 'all' });
  const monthlyUsed = creditsSummary?.totalSpent ?? 0;
  const totalUsed = allTimeSummary?.totalSpent ?? user?.total_credits_used ?? 0;

  const handlePackageBuy = async (pkg: { id: string; name?: string; credits: number; bonus_credits: number; price: number; checkout_ready?: boolean }) => {
    const totalCredits = pkg.credits + (pkg.bonus_credits ?? 0);

    if (!pkg.checkout_ready) {
      setPurchaseIntent({
        kind: 'package',
        title: pkg.name || `${pkg.credits.toLocaleString()} 积分包`,
        summary: `当前展示价格为 $${pkg.price.toFixed(1)}，共 ${totalCredits.toLocaleString()} 积分（含赠送），但该积分包的 Stripe 支付配置尚未完整启用。`,
      });
      return;
    }

    setPendingCheckoutPackageId(pkg.id);

    try {
      const result = await createCheckoutSession.mutateAsync({
        kind: 'credit_package',
        packageId: pkg.id,
      });
      window.location.assign(result.checkoutUrl);
      return;
    } catch (error) {
      setPurchaseIntent({
        kind: 'package',
        title: pkg.name || `${pkg.credits.toLocaleString()} 积分包`,
        summary: getSafeErrorMessage(error, '创建支付会话失败，请稍后重试。'),
      });
    } finally {
      setPendingCheckoutPackageId(null);
    }
  };

  const handleContactSupport = () => {
    setPurchaseIntent(null);
    router.push('/profile?tab=tickets');
  };

  return (
    <>
      <div
        className="mb-6 rounded-2xl p-6 md:p-8"
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
          <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-8">
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
                {formatCreditsBalance(hasVerifiedBalance ? 'ready' : 'unavailable', credits)}
              </div>
            </div>

            <div
              className="rounded-xl p-4 md:rounded-none md:p-0 md:pl-8"
              style={{
                borderLeft: '1px solid transparent',
                background: 'var(--bg-primary)',
              }}
            >
              <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-tertiary)' }}>本月消耗</div>
              <div className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{monthlyUsed.toLocaleString()}</div>
            </div>

            <div
              className="rounded-xl p-4 md:rounded-none md:p-0 md:pl-8"
              style={{
                borderLeft: '1px solid transparent',
                background: 'var(--bg-primary)',
              }}
            >
              <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-tertiary)' }}>累计消耗</div>
              <div className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{totalUsed.toLocaleString()}</div>
            </div>
          </div>
        </div>
      </div>

      {/* 积分加油包 */}
      {hasVerifiedBalance && (
        <CreditPackagesSection onBuyClick={handlePackageBuy} pendingPackageId={pendingCheckoutPackageId} />
      )}

      {pendingCheckoutPackageId && (
        <div className="mt-4 text-sm" style={{ color: 'var(--text-tertiary)' }}>
          正在跳转到 Stripe Checkout...
        </div>
      )}

      <PurchaseIntentDialog
        intent={purchaseIntent}
        onOpenChange={(open) => {
          if (!open) setPurchaseIntent(null);
        }}
        onContactSupport={handleContactSupport}
      />
    </>
  );
});
