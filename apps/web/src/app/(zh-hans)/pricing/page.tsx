/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import MarketingShell from '@/components/landing/MarketingShell';
import { ExpertConsultCard } from '@/components/expert-consult/ExpertConsultCard';
import { expertConsultPath } from '@/components/expert-consult/expertConsultCopy';
import { PricingPlans } from '@/components/pricing/PricingPlans';
import { PricingCreditPacks, PricingFaq, PricingStudio } from '@/components/pricing/PricingExtras';
import { PRICING_COPY as COPY } from '@/components/pricing/pricingContent';
import styles from '@/components/pricing/pricing-page.module.css';
import { getPublicSiteSettings } from '@/lib/public-site';
import { buildPageMetadata } from '@/lib/seo/metadata';
import { getPublicCreditPackages } from '@/lib/public-pricing';
import { getPublicPageOffers } from '@/lib/landing/landing-offers';
import { buildAuthHref } from '@/lib/site-config';

// Static with hourly refresh (SEO_GEO_SPEC section 9); plan and credit-pack prices come from the server catalog.
export const revalidate = 3600;

export function generateMetadata() {
  return buildPageMetadata({
    title: '价格',
    description: '免费开始，Pro 和 Gold 会员价格、积分、积分包和常见问题。',
    path: '/pricing',
  });
}

/**
 * Public pricing page (PAYWALL design v25 scene 5); every price comes from the server catalog. In the home page's look
 * (Owner 2026-11-14, PUBLIC-SITE): pricing-page.module.css gives the cards the public layer's values on this page only.
 */
export default async function PricingPage() {
  const [{ membershipPlans, membershipPlansStatus }, packs, offers] = await Promise.all([
    getPublicSiteSettings(), getPublicCreditPackages(), getPublicPageOffers(),
  ]);
  const plans = membershipPlansStatus === 'available' ? membershipPlans : [];
  return (
    <MarketingShell tone="light">
      <div className={styles.pricing}>
        <header className={styles.head}>
          <h1 className={styles.title}>{COPY.title}</h1>
          <p className={styles.lede}>{COPY.lede}</p>
        </header>
        <div data-zone="price">
          <PricingPlans plans={plans} links={{ signup: buildAuthHref('/login?action=signup&lang=zh-Hans'),
            membership: buildAuthHref('/app/profile?tab=subscription') }} offers={offers} />
        </div>
        <div data-zone="work">
          <PricingCreditPacks packages={packs.packages} plans={plans} failed={packs.failed} />
        </div>
        <PricingStudio />
        <ExpertConsultCard href={buildAuthHref(expertConsultPath('pricing'))} />
        <div data-zone="faq">
          <PricingFaq />
        </div>
      </div>
    </MarketingShell>
  );
}
