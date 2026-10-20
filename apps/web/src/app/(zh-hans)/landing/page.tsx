import { AuthFragmentForward } from '@/components/auth/AuthFragmentForward';
import { JsonLd } from '@/components/seo/JsonLd';
import { rewordFaq } from '@/components/landing/preview-j/SectionsJ';
import { SampleL } from '@/components/landing/preview-l/SampleL';
import { resolveLandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData, HOME_DESCRIPTION, HOME_TITLE, homePageExtras } from '@/lib/landing/landing-page-data';
import { getLandingOffers } from '@/lib/landing/landing-offers';
import { getPublicSiteSettings } from '@/lib/public-site';
import { buildPageMetadata } from '@/lib/seo/metadata';
import { SITE_LOCALES } from '@/lib/seo/site';
import { faqPageJsonLd, softwareApplicationJsonLd } from '@/lib/seo/structured-data';

// Static with hourly refresh (SEO_GEO_SPEC section 9); plan prices come from the server catalog.
export const revalidate = 3600;

export function generateMetadata() {
  return buildPageMetadata({ title: HOME_TITLE, absoluteTitle: true, description: HOME_DESCRIPTION, path: '/' });
}

/**
 * The public Simplified home page, served at "/" (the proxy rewrites the root here and /landing 308s to "/" since the
 * /app move, SEO_GEO_SPEC section 15); canonical is "/". Owner 2026-10-17: "样稿 L 验收后，正式 /landing 整体换成样稿 L，冻结前完成" — the page
 * is sample L (components/landing/preview-l) in its production mode: no sample switcher, header and footer link only
 * pages that exist. Title, description, canonical, robots (buildPageMetadata), the structured data and the hourly
 * refresh are the home page's as before, and the footer shows the support address from the settings. The founder
 * offer stays off the home page (Owner 2026-10-15), so its FAQ entries go with it, in the page and in the FAQ
 * structured data alike.
 */
export default async function LandingPage() {
  const [{ siteName, supportEmail, membershipPlans, membershipPlansStatus }, offers] =
    await Promise.all([getPublicSiteSettings(), getLandingOffers()]);
  const plans = membershipPlansStatus === 'available' ? membershipPlans : [];
  const flags = { ...resolveLandingFlags(), founder: false };
  const data = buildLandingPageData(flags, plans, offers);

  // The structured data says what the page says: the FAQ answers with the same rewording the page shows (FaqJ).
  const faqItems = data.faqItems.map(item => ({ ...item, answer: rewordFaq(item.answer) }));

  return (
    <div lang={SITE_LOCALES['zh-Hans'].htmlLang}>
      <JsonLd data={[
        softwareApplicationJsonLd({ description: HOME_DESCRIPTION, offers: data.offerList }),
        ...(faqItems.length > 0 ? [faqPageJsonLd(faqItems)] : []),
      ]} />
      <AuthFragmentForward />
      <SampleL data={data} siteName={siteName} extras={homePageExtras(flags)} production supportEmail={supportEmail} />
    </div>
  );
}
