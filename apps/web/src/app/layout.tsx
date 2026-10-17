import type { Metadata } from "next";
import { MiSansFont } from "@/components/misans-font";
import "./globals.css";
import Provider from "@/trpc/provider";
import { getPublicSiteSettings } from "@/lib/public-site";
import { Toaster } from "@/components/ui/sonner";
import { JsonLd } from "@/components/seo/JsonLd";
import { SiteAnalytics } from "@/components/analytics/SiteAnalytics";
import { NOINDEX_ROBOTS } from "@/lib/seo/metadata";
import { DEFAULT_LOCALE, SITE_LOCALES } from "@/lib/seo/site";
import { organizationJsonLd, websiteJsonLd } from "@/lib/seo/structured-data";
import { resolveSupportEmail } from "@/lib/site-config";

export async function generateMetadata(): Promise<Metadata> {
  const { siteName } = await getPublicSiteSettings();

  return {
    title: siteName,
    description: `${siteName} - AI-powered chat application`,
    // Every page is noindex unless it builds its metadata with buildPageMetadata (public pages only).
    robots: NOINDEX_ROBOTS,
    icons: {
      icon: '/graylum-logo.svg',
      shortcut: '/favicon.ico',
      apple: '/graylum-logo.png',
    },
  };
}

// Support inbox from the environment; the placeholder default is not a real inbox, so leave contactPoint out.
function publicSupportEmail() {
  const value = resolveSupportEmail();
  return value.endsWith('@example.com') ? null : value;
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Vercel Web Analytics and Speed Insights only report from Vercel production-mode deployments.
  const onVercel =
    process.env.NODE_ENV === 'production' &&
    (process.env.VERCEL === '1' || Boolean(process.env.VERCEL_URL));

  return (
    // One root layout serves every language, so this is the default (Simplified); /zh-tw pages mark their
    // content with lang="zh-Hant-TW" on their own wrapper until route groups split the root layout.
    <html lang={SITE_LOCALES[DEFAULT_LOCALE].htmlLang}>
      <body className="antialiased">
        <JsonLd data={[organizationJsonLd({ supportEmail: publicSupportEmail() }), websiteJsonLd()]} />
        <MiSansFont />
        <Provider>
          {children}
          {/* Termly consent, GA4 and Vercel statistics; loads nothing until configured (ANALYTICS plan §3). */}
          <SiteAnalytics onVercel={onVercel} />
        </Provider>
        <Toaster />
      </body>
    </html>
  );
}
