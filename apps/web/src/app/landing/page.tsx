import LandingHeader from '@/components/landing/LandingHeader';
import HeroSection from '@/components/landing/HeroSection';
import FeaturesSection from '@/components/landing/FeaturesSection';
import PricingSection from '@/components/landing/PricingSection';
import CTASection from '@/components/landing/CTASection';
import LandingFooter from '@/components/landing/LandingFooter';
import FeaturedModules from '@/components/marketplace/FeaturedModules';
import { getPublicSiteSettings } from '@/lib/public-site';

export default async function LandingPage() {
  const {
    siteName,
    supportEmail,
    membershipPlans,
    featuredModules,
    showOnboarding,
    showFeaturedModules,
  } = await getPublicSiteSettings();

  return (
    <>
      <LandingHeader siteName={siteName} />
      <main>
        <HeroSection />
        {showOnboarding && <FeaturesSection />}
        {showFeaturedModules && featuredModules.length > 0 && (
          <section className="relative py-24 md:py-28">
            <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
              <FeaturedModules
                featuredModules={featuredModules.map((module) => ({
                  id: module.id,
                  title: module.title,
                  description: module.description ?? '',
                  icon: module.icon ?? '✨',
                  image_url: module.image_url ?? '',
                  badge_type: (module.badge_type as 'hot' | 'new' | 'recommend') ?? undefined,
                  badge_text: module.badge_text ?? '',
                  credits_display: module.credits_display ?? '',
                  usage_count: module.usage_count ?? 0,
                  link_url: module.link_url ?? undefined,
                  link_module_id: module.link_module_id ?? undefined,
                }))}
              />
            </div>
          </section>
        )}
        <PricingSection plans={membershipPlans} />
        <CTASection />
      </main>
      <LandingFooter siteName={siteName} supportEmail={supportEmail} />
    </>
  );
}
