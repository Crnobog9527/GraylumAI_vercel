import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";
import Provider from "@/trpc/provider";
import { getPublicSiteSettings } from "@/lib/public-site";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const { siteName } = await getPublicSiteSettings();

  return {
    title: siteName,
    description: `${siteName} - AI-powered chat application`,
    icons: {
      icon: '/globe.svg',
      shortcut: '/globe.svg',
      apple: '/globe.svg',
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
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <Provider>{children}</Provider>
        {shouldRenderSpeedInsights ? <SpeedInsights /> : null}
      </body>
    </html>
  );
}
