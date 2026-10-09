/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import MarketingShell from '@/components/landing/MarketingShell';
import { PricingPlans } from '@/components/pricing/PricingPlans';
import { PricingCreditPacks, PricingFaq, PricingStudio } from '@/components/pricing/PricingExtras';
import { PRICING_COPY as COPY } from '@/components/pricing/pricingContent';
import { buildPublicPageMetadata, getPublicSiteSettings } from '@/lib/public-site';
import { getPublicCreditPackages } from '@/lib/public-pricing';
import { buildAuthHref } from '@/lib/site-config';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  return buildPublicPageMetadata('价格', '免费开始，Pro 和 Gold 会员价格、积分、积分包和常见问题。', ['价格', '会员', '积分包', '退款']);
}

/** Public pricing page (PAYWALL design v25 scene 5); every price comes from the server catalog. */
export default async function PricingPage() {
  const [{ membershipPlans, membershipPlansStatus }, packs] = await Promise.all([
    getPublicSiteSettings(), getPublicCreditPackages(),
  ]);
  const plans = membershipPlansStatus === 'available' ? membershipPlans : [];
  return (
    <MarketingShell>
      <div className="mx-auto grid max-w-6xl gap-12 px-4 py-16 sm:px-6 md:py-20 lg:px-8">
        <header className="grid gap-3 text-center">
          <h1 className="text-3xl font-bold md:text-4xl" style={{ color: 'var(--text-primary)' }}>{COPY.title}</h1>
          <p className="mx-auto max-w-2xl text-base" style={{ color: 'var(--text-secondary)' }}>{COPY.lede}</p>
        </header>
        <PricingPlans plans={plans} links={{ signup: buildAuthHref('/login?action=signup'),
          membership: buildAuthHref('/profile?tab=subscription') }} />
        <PricingCreditPacks packages={packs.packages} plans={plans} failed={packs.failed} />
        <PricingStudio />
        <PricingFaq />
      </div>
    </MarketingShell>
  );
}
