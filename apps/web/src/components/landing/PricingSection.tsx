import Link from 'next/link';
import { Check, Crown, Sparkles, Zap } from 'lucide-react';
import { formatUsd } from '@/lib/currency';
import { buildAuthHref } from '@/lib/site-config';
import type { PublicCatalogStatus } from '@/lib/public-site';

type MembershipPlan = {
  id: string;
  name: string;
  level: string;
  price: {
    monthly: number;
    yearly: number;
  };
  credits: {
    monthly: number;
    monthlyBonus: number;
    yearly: number;
    yearlyBonus: number;
  };
  features: string[];
  recommended?: boolean;
  highlight?: boolean;
  checkoutReady?: {
    monthly: boolean;
    yearly: boolean;
  };
};

function resolvePlanIcon(level: string) {
  if (level === 'gold') {
    return Crown;
  }

  if (level === 'pro') {
    return Sparkles;
  }

  return Zap;
}

function formatCreditAmount(value: number) {
  return new Intl.NumberFormat('en-US').format(value);
}

export default function PricingSection({
  plans,
  status = plans && plans.length > 0 ? 'available' : 'empty',
}: {
  plans?: MembershipPlan[];
  status?: PublicCatalogStatus;
}) {
  const resolvedPlans = status === 'available' ? plans ?? [] : [];

  return (
    <section id="pricing" className="relative py-24 md:py-32">
      <div className="absolute inset-0">
        <div className="absolute inset-0 bg-[#0A0A0A]" />
        <div
          className="absolute left-1/2 top-0 h-[200px] w-[280px] -translate-x-1/2 opacity-12 blur-[44px] md:h-[320px] md:w-[620px] md:opacity-16 md:blur-[72px]"
          style={{ background: 'radial-gradient(circle, #FFD700 0%, transparent 70%)' }}
        />
      </div>

      <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mb-16 text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[#FFD700]/20 bg-[#FFD700]/10 px-4 py-2">
            <span className="text-sm font-medium text-[#FFD700]">会员订阅</span>
          </div>
          <h2 className="mb-6 text-3xl font-bold text-white sm:text-4xl md:text-5xl">
            选择适合你的
            <span className="bg-gradient-to-r from-[#FFD700] to-[#FFA500] bg-clip-text text-transparent">
              套餐
            </span>
          </h2>
          <p className="mx-auto max-w-3xl text-lg text-[#B0B0B0]">
            套餐价格与权益直接同步后台会员配置。按月或按年订阅，不同等级对应不同积分额度、历史保留时长和导出能力。
          </p>
        </div>

        {status === 'unavailable' ? (
          <div
            data-testid="public-pricing-unavailable"
            className="mx-auto max-w-2xl rounded-2xl border border-amber-400/30 bg-amber-400/10 px-6 py-8 text-center"
          >
            <h3 className="text-xl font-semibold text-white">套餐服务暂不可用</h3>
            <p className="mt-3 text-[#B0B0B0]">当前无法安全读取最新套餐与价格，请稍后重试。</p>
            <Link
              href="/landing#pricing"
              className="mt-6 inline-flex rounded-xl border border-[#FFD700]/40 px-5 py-2.5 font-semibold text-[#FFD700] hover:bg-[#FFD700]/10"
            >
              重新加载
            </Link>
          </div>
        ) : status === 'empty' ? (
          <div
            data-testid="public-pricing-empty"
            className="mx-auto max-w-2xl rounded-2xl border border-[#333333] bg-[#1A1A1A] px-6 py-8 text-center"
          >
            <h3 className="text-xl font-semibold text-white">当前暂无可用套餐</h3>
            <p className="mt-3 text-[#B0B0B0]">新的套餐开放后，这里会自动显示最新价格与权益。</p>
          </div>
        ) : (
          <div className="mx-auto grid max-w-6xl grid-cols-1 gap-8 xl:grid-cols-3">
            {resolvedPlans.map((plan) => {
            const Icon = resolvePlanIcon(plan.level);
            const monthlyPrice = Number(plan.price.monthly ?? 0);
            const yearlyPrice = Number(plan.price.yearly ?? 0);
            const monthlyCredits =
              Number(plan.credits.monthly ?? 0) + Number(plan.credits.monthlyBonus ?? 0);
            const yearlyCredits =
              Number(plan.credits.yearly ?? 0) + Number(plan.credits.yearlyBonus ?? 0);
            const isHighlighted = plan.highlight || plan.recommended;
            const hasCheckout =
              plan.level !== 'free' && (
                (Boolean(plan.checkoutReady?.monthly) && Number.isFinite(monthlyPrice) && monthlyPrice > 0)
                || (Boolean(plan.checkoutReady?.yearly) && Number.isFinite(yearlyPrice) && yearlyPrice > 0)
              );
            const ctaHref = hasCheckout
              ? buildAuthHref(`/login?action=signup&plan=${encodeURIComponent(plan.name)}`)
              : '/contact';
            const ctaLabel = hasCheckout ? '立即订阅' : '联系我们';

            return (
              <div
                key={plan.id}
                className={`relative rounded-2xl p-8 transition-transform duration-300 md:hover:-translate-y-2 ${
                  isHighlighted
                    ? 'border-2 border-[#FFD700]/50 bg-gradient-to-b from-[#FFD700]/10 to-[#1A1A1A] shadow-[0_0_28px_rgba(255,215,0,0.12)]'
                    : 'border border-[#333333] bg-[#1A1A1A] hover:border-[#FFD700]/30'
                }`}
              >
                {isHighlighted && (
                  <div className="absolute -top-4 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-r from-[#FFD700] to-[#FFA500] px-4 py-1.5 text-sm font-bold text-[#0A0A0A]">
                    最受欢迎
                  </div>
                )}

                <div
                  className={`mb-6 flex h-14 w-14 items-center justify-center rounded-xl ${
                    isHighlighted ? 'bg-[#FFD700]/20' : 'bg-[#2A2A2A]'
                  }`}
                >
                  <Icon className={`h-7 w-7 ${isHighlighted ? 'text-[#FFD700]' : 'text-[#B0B0B0]'}`} />
                </div>

                <h3 className="mb-2 text-xl font-bold text-white">{plan.name}</h3>
                <p className="mb-6 text-sm text-[#808080]">
                  {plan.level === 'free'
                    ? '适合初次体验与轻量使用'
                    : plan.level === 'gold'
                      ? '适合团队与高阶创作者的长期订阅'
                      : '适合持续创作和稳定增长'}
                </p>

                <div className="mb-6 space-y-2">
                  <div className="flex items-end gap-2">
                    <span className="text-4xl font-bold text-white">{formatUsd(monthlyPrice)}</span>
                    <span className="pb-1 text-sm text-[#B0B0B0]">/月</span>
                  </div>
                  {yearlyPrice > 0 && (
                    <div className="text-sm text-[#FFD700]">
                      年付 {formatUsd(yearlyPrice)} /年
                    </div>
                  )}
                  <div className="text-sm text-[#B0B0B0]">
                    月度积分 {formatCreditAmount(monthlyCredits)}
                    {yearlyCredits > 0 ? `，年付积分按月释放，总额度 ${formatCreditAmount(yearlyCredits)}` : ''}
                  </div>
                </div>

                <ul className="mb-8 space-y-3">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-center gap-3">
                      <div
                        className={`flex h-5 w-5 items-center justify-center rounded-full ${
                          isHighlighted ? 'bg-[#FFD700]/20' : 'bg-[#2A2A2A]'
                        }`}
                      >
                        <Check className={`h-3 w-3 ${isHighlighted ? 'text-[#FFD700]' : 'text-[#22C55E]'}`} />
                      </div>
                      <span className="text-sm text-[#B0B0B0]">{feature}</span>
                    </li>
                  ))}
                </ul>

                <Link
                  href={ctaHref}
                  className={`block w-full rounded-xl py-3 text-center font-semibold transition-colors duration-200 ${
                    isHighlighted
                      ? 'bg-gradient-to-r from-[#FFD700] to-[#FFA500] text-[#0A0A0A] hover:shadow-[0_0_16px_rgba(255,215,0,0.3)]'
                      : 'border border-[#333333] bg-[#2A2A2A] text-white hover:border-[#FFD700] hover:bg-[#FFD700]/10'
                  }`}
                >
                  {ctaLabel}
                </Link>
              </div>
            );
            })}
          </div>
        )}

        {status === 'available' && (
          <p className="mt-12 text-center text-sm text-[#808080]">
            年付积分按月释放，未使用积分可累积，不按月清零。页面展示价格与权益来自后台会员配置。
          </p>
        )}
      </div>
    </section>
  );
}
