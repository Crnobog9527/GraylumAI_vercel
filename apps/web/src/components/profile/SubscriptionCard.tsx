'use client';

import { memo, startTransition, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Crown, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { trpc } from '@/trpc/client';
import { CREDITS_SUMMARY_QUERY_OPTIONS } from './creditsSummaryQuery';
import { SummaryStatValue } from './SummaryRetry';
import { getSafeErrorMessage } from '@/lib/safe-error-message';
import { formatCreditsBalance } from '@/components/credits/balancePresentation';
import { canceledReturnNotice, invalidatePostCheckoutMembershipQueries } from './checkoutSyncInvalidations';
import { formatUsd, getCreditPackagePrice } from './creditPackagePrice';
import { ProfileCatalogState } from './ProfileCatalogState';
import { EligibilityNotices } from './EligibilityNotices';
import { CreditPackagesSection } from './CreditPackagesSection';
import { MembershipPlanCard, type PlanConfig } from './MembershipPlanCard';
import { MethodMembershipSummary } from './MethodMembershipSummary';
import { currentMethodMembership, methodPlanAction, parseBuyDeepLink, type MethodMembershipRow } from './methodPlanAction';
import { methodTaxSummary, planCheckoutTarget } from './planCheckoutTarget';
import { useMethodCheckout } from '@/components/paywall/useMethodCheckout';
import { MethodCheckoutDialog, type MethodCheckoutTarget } from '@/components/paywall/MethodCheckoutDialog';
import { CHECKOUT_COPY, founderSeatsLeft } from '@/components/paywall/methodCheckout';
import { pickPaywallPlans } from '@/components/paywall/paywallPlans';
export { ProfileCatalogState, CreditPackagesSection };

interface MockUser {
  subscription_tier?: 'free' | 'basic' | 'pro' | 'enterprise';
  credits?: number;
  total_credits_used?: number;
}

interface CheckoutNotice {
  tone: 'syncing' | 'success' | 'warning' | 'error' | 'cancelled';
  message: string;
}

const NOTICE_COLORS: Record<CheckoutNotice['tone'], [string, string]> = {
  success: ['rgba(34, 197, 94, 0.25)', 'rgba(34, 197, 94, 0.08)'],
  warning: ['rgba(245, 158, 11, 0.25)', 'rgba(245, 158, 11, 0.08)'],
  cancelled: ['rgba(245, 158, 11, 0.25)', 'rgba(245, 158, 11, 0.08)'],
  error: ['rgba(239, 68, 68, 0.25)', 'rgba(239, 68, 68, 0.08)'],
  syncing: ['rgba(59, 130, 246, 0.25)', 'rgba(59, 130, 246, 0.08)'],
};

// 根据计划配置生成默认特性列表
function generateDefaultFeatures(plan: { level: string; credits?: { monthly?: number }; discount?: number }): string[] {
  if (plan.level === 'free') return ['新用户可以免费试用'];
  const features: string[] = [];
  if (plan.credits?.monthly) features.push(`月度积分${plan.credits.monthly}积分`);
  if (plan.discount && plan.discount > 0) features.push(`购买加油包享受${Math.round((1 - plan.discount) * 100) / 10}折`);
  return features;
}

// 会员订阅卡片：购买和升级走 payments.methodCheckout（PAY-STRIPE-MP 第 5 步），付款后返回由 syncCheckoutSession 核对。
export const SubscriptionCard = memo(function SubscriptionCard({ user: _user }: { user: MockUser }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const utils = trpc.useUtils();
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [checkoutNotice, setCheckoutNotice] = useState<CheckoutNotice | null>(null);
  const [target, setTarget] = useState<{ planId: string; cycle: 'monthly' | 'yearly' } | null>(null);
  const [firstMonthDeclined, setFirstMonthDeclined] = useState(false);
  const [founderSoldOut, setFounderSoldOut] = useState(false);
  const [founderDeclined, setFounderDeclined] = useState(false);
  const syncedCheckoutSessionRef = useRef<string | null>(null);
  const deepLinkHandled = useRef(false);
  const checkout = useMethodCheckout();
  const entitlements = trpc.user.getEntitlements.useQuery(undefined, { staleTime: 30_000 });
  // Old-subscription notices (#937): renewal stopped, or a failed payment that blocks new purchases.
  const eligibility = trpc.payments.getMembershipEligibilityMatrix.useQuery(undefined, { retry: false });
  const unpaidSubscription = (eligibility.data?.entries ?? []).some(entry => entry.action === 'resolvePaymentIssue');

  const customerPortal = trpc.payments.createCustomerPortalSession.useMutation();
  const subscriptionManagement = trpc.payments.getSubscriptionManagement.useQuery();
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
  const {
    data: apiPlans = [],
    isLoading: plansLoading,
    isError: plansError,
    isFetching: plansFetching,
    refetch: refetchPlans,
  } = trpc.settings.getMembershipPlans.useQuery();
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
        void utils.payments.getSubscriptionManagement.invalidate();

        if (result.orderStatus === 'refunded' || result.paymentStatus === 'refunded') {
          setCheckoutNotice({ tone: 'success', message: '这笔订单已全额退款，订单状态已同步。' });
          clearCheckoutParams();
          return;
        }

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
      .then(async (result) => {
        void invalidatePostCheckoutMembershipQueries(utils);
        setCheckoutNotice(canceledReturnNotice(result));
        clearCheckoutParams();
      })
      .catch(() => {
        syncedCheckoutSessionRef.current = null;
        // Unconfirmed: the session may still have been paid in another tab, so do not promise "no charge".
        setCheckoutNotice({ tone: 'cancelled', message: '你已离开付款页面。账单状态稍后会自动同步。' });
      });
  }, [checkoutSessionId, checkoutState, syncCheckoutSessionMutation, utils]);

  const memberships = (checkout.entry?.memberships ?? []) as MethodMembershipRow[];
  const current = currentMethodMembership(memberships);
  const methods = checkout.methodsFor('membership_plan', billingCycle);
  const goldFirstMonth = checkout.entry?.goldFirstMonthEligible === true && !firstMonthDeclined;
  const founderSeats = founderSoldOut || founderDeclined ? 0 : founderSeatsLeft(checkout.entry);
  const sellable = useMemo(() => pickPaywallPlans(apiPlans), [apiPlans]);
  const displayPlans: PlanConfig[] = apiPlans.map(plan => ({
    id: plan.id,
    name: plan.name,
    level: plan.level,
    price: plan.price,
    features: plan.features?.length > 0 ? plan.features : generateDefaultFeatures(plan),
    recommended: plan.recommended,
    highlight: plan.highlight,
  }));

  function actionFor(planId: string, cycle: 'monthly' | 'yearly') {
    const plan = apiPlans.find(item => item.id === planId);
    if (!plan) return null;
    const founderRenewal = checkout.entry?.founderRenewal;
    const walletRenewalOpen = checkout.methodsFor('membership_plan', cycle).some(method => method === 'wechat_pay' || method === 'alipay');
    if (plan.level === 'gold' && cycle === 'yearly' && walletRenewalOpen && founderRenewal
      && Date.parse(founderRenewal.eligibleUntil) > Date.now()) {
      return { kind: 'founder_renewal' as const, label: '续买创始会员一年', disabled: false as const,
        priorSubscriptionId: founderRenewal.subscriptionId };
    }
    return methodPlanAction({ level: plan.level, price: Number(plan.price?.[cycle]),
      checkoutReady: plan.checkoutReady?.[cycle] === true && checkout.methodsFor('membership_plan', cycle).length > 0,
      current, entitlementLevel: entitlements.data?.level ?? null,
      unpaidSubscription });
  }

  // Landing-page price cards link here with ?buy=&cycle=: open the same dialog the plan button opens (offers included),
  // once everything it depends on is known. Nothing opens when the plan cannot be bought; the params never replay.
  const deepLink = parseBuyDeepLink(searchParams);
  const deepLinkReady = !plansLoading && !checkout.loading && !entitlements.isLoading && !eligibility.isLoading;
  useEffect(() => {
    if (!deepLink || !deepLinkReady || deepLinkHandled.current) return;
    deepLinkHandled.current = true;
    setBillingCycle(deepLink.cycle);
    const plan = sellable.find(item => item.level === deepLink.level);
    const action = plan && checkout.open ? actionFor(plan.id, deepLink.cycle) : null;
    if (plan && action && !action.disabled) setTarget({ planId: plan.id, cycle: deepLink.cycle });
    const url = new URL(window.location.href);
    for (const key of ['buy', 'cycle', 'offer']) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  // Runs once, when the reads it needs have settled; the ref guards against replays.
  }, [deepLinkReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const dialogTarget: MethodCheckoutTarget | null = (() => {
    const plan = target && sellable.find(item => item.id === target.planId);
    const action = target && actionFor(target.planId, target.cycle);
    return plan && action ? planCheckoutTarget({ plan, billing: target.cycle, action, prior: current, goldFirstMonth, founderSeats,
      founderRenewal: checkout.entry?.founderRenewal }) : null;
  })();

  return (
    <div
      className="mb-6 rounded-2xl p-6 md:p-8"
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
      }}
    >
      <MethodCheckoutDialog target={dialogTarget} checkout={checkout} onClose={() => setTarget(null)}
        onGoldFirstDeclined={() => setFirstMonthDeclined(true)} onFounderDeclined={() => setFounderDeclined(true)}
        onFounderSoldOut={() => setFounderSoldOut(true)}
        notice={founderSoldOut && target?.cycle === 'yearly' && dialogTarget?.purchase.offer === 'standard' ? CHECKOUT_COPY.founderSoldOut : null} />
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <div
            className="p-2 rounded-lg"
            style={{ background: 'rgba(255, 215, 0, 0.1)', border: '1px solid rgba(255, 215, 0, 0.2)' }}
          >
            <Crown className="h-5 w-5" style={{ color: 'var(--color-primary)' }} />
          </div>
          <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>会员订阅</h3>
        </div>

        {subscriptionManagement.data?.available && (
          <Button
            type="button"
            variant="outline"
            disabled={customerPortal.isPending}
            onClick={async () => {
              try {
                const result = await customerPortal.mutateAsync({});
                window.location.assign(result.portalUrl);
              } catch (error) {
                setCheckoutNotice({ tone: 'error', message: getSafeErrorMessage(error, '订阅管理暂不可用，请稍后重试') });
              }
            }}
          >
            {customerPortal.isPending ? '跳转中...' : '管理订阅 / 取消续费'}
          </Button>
        )}

        {/* Billing Toggle */}
        <div role="radiogroup" aria-label="计费周期" className="flex items-center justify-end gap-2">
          {(['monthly', 'yearly'] as const).map(cycle => (
            <button key={cycle} type="button" role="radio" aria-checked={billingCycle === cycle} onClick={() => setBillingCycle(cycle)}
              className="rounded-lg px-4 py-1.5 text-sm font-medium transition-colors duration-200"
              style={{
                background: billingCycle === cycle ? 'rgba(255, 215, 0, 0.2)' : 'transparent',
                color: billingCycle === cycle ? 'var(--color-primary)' : 'var(--text-tertiary)',
                border: billingCycle === cycle ? '1px solid rgba(255, 215, 0, 0.3)' : '1px solid transparent'
              }}>
              {cycle === 'monthly' ? '按月' : '按年'}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-6 text-sm" style={{ color: 'var(--text-tertiary)' }}>
        年付积分按月释放，未使用积分可累积，不按月清零。取消续费后，已付周期权益保留至到期。
      </div>

      <MethodMembershipSummary rows={memberships} />
      <EligibilityNotices entries={eligibility.data?.entries} />

      {checkoutNotice && (
        <div role="status" data-testid="profile-checkout-notice" className="mb-6 rounded-xl border px-4 py-3 text-sm"
          style={{ borderColor: NOTICE_COLORS[checkoutNotice.tone][0], background: NOTICE_COLORS[checkoutNotice.tone][1],
            color: 'var(--text-secondary)' }}>
          {checkoutNotice.message}
        </div>
      )}

      {!checkout.loading && !checkout.open && displayPlans.length > 0 ? (
        <p data-testid="profile-method-checkout-closed" className="mb-4 text-sm" style={{ color: 'var(--text-tertiary)' }}>
          {checkout.failed ? '暂时无法确认会员状态，购买入口已暂停，请稍后刷新。' : CHECKOUT_COPY.closed}
        </p>
      ) : null}

      {/* Plans Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {plansLoading ? (
          <div className="col-span-3 text-center py-8" style={{ color: 'var(--text-tertiary)' }}>
            加载中...
          </div>
        ) : plansError ? (
          <ProfileCatalogState
            status="unavailable"
            retrying={plansFetching}
            onRetry={() => { void refetchPlans(); }}
          />
        ) : displayPlans.length === 0 ? (
          <ProfileCatalogState status="empty" />
        ) : displayPlans.map((plan) => (
          <MembershipPlanCard key={plan.id} plan={plan} billingCycle={billingCycle}
            action={checkout.open ? actionFor(plan.id, billingCycle) : null}
            taxNote={methods.length > 0 ? methodTaxSummary(methods) : null}
            firstMonth={goldFirstMonth && plan.level === 'gold' && billingCycle === 'monthly'}
            founderSeats={plan.level === 'gold' && billingCycle === 'yearly' && checkout.open ? founderSeats : 0}
            founderRenewal={plan.level === 'gold' && billingCycle === 'yearly' && actionFor(plan.id, billingCycle)?.kind === 'founder_renewal'}
            onSelect={() => setTarget({ planId: plan.id, cycle: billingCycle })} />
        ))}
      </div>
    </div>
  );
});

// 积分概览卡片（订阅管理页面用）
export const CreditStatsCard = memo(function CreditStatsCard({ user }: { user: MockUser }) {
  const [packTarget, setPackTarget] = useState<MethodCheckoutTarget | null>(null);
  const checkout = useMethodCheckout();
  const credits = typeof user?.credits === 'number' ? user.credits : null;
  const hasVerifiedBalance = credits !== null;
  const plans = trpc.settings.getMembershipPlans.useQuery();
  // 从 API 获取积分统计数据
  const monthlySummary = trpc.credits.getCreditsSummary.useQuery({ period: 'month' }, CREDITS_SUMMARY_QUERY_OPTIONS);
  const allTimeSummary = trpc.credits.getCreditsSummary.useQuery({ period: 'all' }, CREDITS_SUMMARY_QUERY_OPTIONS);

  // International card only (MP, one-time); the mainland card sells membership subscriptions only.
  const handlePackageBuy = (pkg: { id: string; name?: string; credits: number; bonus_credits: number; price: number }, level: string | null) => {
    const totalCredits = pkg.credits + (pkg.bonus_credits ?? 0);
    const payable = getCreditPackagePrice(pkg.price, level, plans.data).payableUsd;
    setPackTarget({
      title: `购买 ${pkg.name || `${pkg.credits.toLocaleString()} 积分包`}`,
      description: `共 ${totalCredits.toLocaleString()} 积分（含赠送），积分永不过期。`,
      purchase: { itemType: 'credit_package', itemId: pkg.id, billingCycle: 'one_time', offer: 'standard' },
      price: formatUsd(payable),
      renewal: '一次性付款，不自动续费。',
      cta: `去付款 · ${formatUsd(payable)}`,
    });
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
              <SummaryStatValue query={monthlySummary} pick={(s) => s.totalSpent} />
            </div>

            <div
              className="rounded-xl p-4 md:rounded-none md:p-0 md:pl-8"
              style={{
                borderLeft: '1px solid transparent',
                background: 'var(--bg-primary)',
              }}
            >
              <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-tertiary)' }}>累计消耗</div>
              <SummaryStatValue query={allTimeSummary} pick={(s) => s.totalSpent} />
            </div>
          </div>
        </div>
      </div>

      {/* 积分加油包 */}
      {hasVerifiedBalance && (
        <CreditPackagesSection onBuyClick={handlePackageBuy} checkoutOpen={checkout.methodsFor('credit_package').length > 0}
          renewalGrace={currentMethodMembership(checkout.entry?.memberships as MethodMembershipRow[] | undefined)?.inGrace === true} />
      )}

      <MethodCheckoutDialog target={packTarget} checkout={checkout} onClose={() => setPackTarget(null)} />
    </>
  );
});
