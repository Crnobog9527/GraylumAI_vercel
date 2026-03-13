/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import MarketingShell from '@/components/landing/MarketingShell';
import PublicPageHero from '@/components/landing/PublicPageHero';
import { legalSections } from '@/lib/landing-content';
import { buildPublicPageMetadata, getPublicSiteSettings } from '@/lib/public-site';

export async function generateMetadata() {
  return buildPublicPageMetadata('服务条款', '查看平台服务条款、账户责任与服务变更的基础说明。', [
    '服务条款',
    'Terms',
    '账户责任',
  ]);
}

export default async function TermsPage() {
  const { siteName, supportEmail } = await getPublicSiteSettings();

  return (
    <MarketingShell>
      <PublicPageHero
        eyebrow="服务条款"
        title={`使用 ${siteName} 前，请先了解基础服务规则`}
        description="以下内容是当前版本的公开条款草案，用于说明平台服务定位、账户责任和服务变更的基础规则。后续你仍可按运营或法务意见继续修订。"
      />

      <section
        className="bg-[#0A0A0A] py-16 md:py-20"
        style={{ contentVisibility: 'auto', containIntrinsicSize: '1320px' }}
      >
        <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
          <div className="space-y-10 rounded-3xl border border-[#2B2B2B] bg-[#141414] p-8 md:p-10">
            {legalSections.terms.map((section) => (
              <section key={section.title}>
                <h2 className="text-2xl font-semibold text-white">{section.title}</h2>
                <div className="mt-4 space-y-4 text-sm leading-8 text-[#B5B5B5]">
                  {section.paragraphs.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                </div>
              </section>
            ))}
            <section>
              <h2 className="text-2xl font-semibold text-white">联系我们</h2>
              <p className="mt-4 text-sm leading-8 text-[#B5B5B5]">
                如对当前条款内容、使用限制或账户责任有疑问，请通过 {supportEmail} 与我们联系。
              </p>
            </section>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
