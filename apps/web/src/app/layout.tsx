import type { Metadata } from "next";
import { MiSansFont } from "@/components/misans-font";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";
import Provider from "@/trpc/provider";
import { getPublicSiteSettings } from "@/lib/public-site";
import { Toaster } from "@/components/ui/sonner";

export async function generateMetadata(): Promise<Metadata> {
  const { siteName } = await getPublicSiteSettings();

  return {
    title: siteName,
    description: `${siteName} - AI-powered chat application`,
    icons: {
      icon: '/graylum-logo.svg',
      shortcut: '/favicon.ico',
      apple: '/graylum-logo.png',
    },
  };
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
    <html lang="en">
      <body className="antialiased">
        <MiSansFont />
        <Provider>{children}</Provider>
        <Toaster />
        {shouldRenderSpeedInsights ? <SpeedInsights /> : null}
      </body>
    </html>
  );
}
