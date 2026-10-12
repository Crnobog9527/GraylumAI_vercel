import { JsonLd } from '@/components/seo/JsonLd';
import { FinalAction } from '@/components/landing/offer/FinalAction';
import { FlowSteps } from '@/components/landing/offer/FlowSteps';
import { HowItWorks } from '@/components/landing/offer/HowItWorks';
import { OfferFaq } from '@/components/landing/offer/OfferFaq';
import { OfferHero } from '@/components/landing/offer/OfferHero';
import { PriceSection } from '@/components/landing/offer/PriceSection';
import { SiteShell } from '@/components/public-site/SiteShell';
import { VoiceWall } from '@/components/landing/offer/VoiceWall';
import { resolveLandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData, HOME_DESCRIPTION, HOME_TITLE } from '@/lib/landing/landing-page-data';
import { getPublicSiteSettings } from '@/lib/public-site';
import { buildPageMetadata } from '@/lib/seo/metadata';
import { faqPageJsonLd, softwareApplicationJsonLd } from '@/lib/seo/structured-data';
import { buildAuthHref } from '@/lib/site-config';

// Static with hourly refresh (SEO_GEO_SPEC section 9); plan prices come from the server catalog.
export const revalidate = 3600;

export function generateMetadata() {
  return buildPageMetadata({ title: HOME_TITLE, absoluteTitle: true, description: HOME_DESCRIPTION, path: '/' });
}

/**
 * The public Simplified home page (offer final 2026-10-13, docs/launch/design/landing/). It lives at
 * /landing until the /app move makes "/" public (SEO_GEO_SPEC section 15); canonical is already "/".
 * Section order is fixed by the Owner: hero, sticky notes, how the coach works, price, FAQ, final action.
 */
export default async function LandingPage() {
  const { siteName, supportEmail, membershipPlans, membershipPlansStatus } = await getPublicSiteSettings();
  const plans = membershipPlansStatus === 'available' ? membershipPlans : [];
  // The Gold first-month price and founder seats have no public server answer yet, so no offers are passed.
  const data = buildLandingPageData(resolveLandingFlags(), plans);

  return (
    <SiteShell locale="zh-Hans" supportEmail={supportEmail} siteName={siteName}>
      <JsonLd data={[
        softwareApplicationJsonLd({ description: HOME_DESCRIPTION, offers: data.offerList }),
        ...(data.faqItems.length > 0 ? [faqPageJsonLd(data.faqItems)] : []),
      ]} />
      <OfferHero note={data.heroNote} />
      <VoiceWall notes={data.notes} />
      <HowItWorks promise={data.promise} timeline={data.timeline}>
        <FlowSteps steps={data.flowSteps} />
      </HowItWorks>
      <PriceSection
        pricing={data.pricing}
        rows={data.compareRows}
        risk={data.risk}
        showResult={data.showResult}
        founderSeats={data.founderSeats}
        membershipHref={buildAuthHref('/profile?tab=subscription')}
      />
      <OfferFaq groups={data.faqGroups} />
      <FinalAction showStack={data.showStack} founderSeats={data.founderSeats} note={data.finalNote} />
    </SiteShell>
  );
}
