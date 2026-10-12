import type { Metadata } from "next";
import { MiSansFont } from "@/components/misans-font";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";
import Provider from "@/trpc/provider";
import { getPublicSiteSettings } from "@/lib/public-site";
import { Toaster } from "@/components/ui/sonner";
import { JsonLd } from "@/components/seo/JsonLd";
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
  const shouldRenderSpeedInsights =
    process.env.NODE_ENV === 'production' &&
    (process.env.VERCEL === '1' || Boolean(process.env.VERCEL_URL));

  return (
    // One root layout serves every language, so this is the default (Simplified); /zh-tw pages mark their
    // content with lang="zh-Hant-TW" on their own wrapper until route groups split the root layout.
    <html lang={SITE_LOCALES[DEFAULT_LOCALE].htmlLang}>
      <body className="antialiased">
        <JsonLd data={[organizationJsonLd({ supportEmail: publicSupportEmail() }), websiteJsonLd()]} />
        <MiSansFont />
        <Provider>{children}</Provider>
        <Toaster />
        {shouldRenderSpeedInsights ? <SpeedInsights /> : null}
      </body>
    </html>
  );
}
