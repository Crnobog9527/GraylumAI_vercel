import LandingHeader from '@/components/landing/LandingHeader';
import HeroSection from '@/components/landing/HeroSection';
import FeaturesSection from '@/components/landing/FeaturesSection';
import PricingSection from '@/components/landing/PricingSection';
import CTASection from '@/components/landing/CTASection';
import LandingFooter from '@/components/landing/LandingFooter';
import { getPublicSiteSettings } from '@/lib/public-site';

export default async function LandingPage() {
  const { siteName, supportEmail } = await getPublicSiteSettings();

  return (
    <>
      <LandingHeader siteName={siteName} />
      <main>
        <HeroSection />
        <FeaturesSection />
        <PricingSection />
        <CTASection />
      </main>
      <LandingFooter siteName={siteName} supportEmail={supportEmail} />
    </>
  );
}
