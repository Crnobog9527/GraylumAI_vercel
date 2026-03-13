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
  return buildPublicPageMetadata('使用协议', '查看平台允许与禁止的使用方式，以及异常使用的处理原则。', [
    '使用协议',
    'Acceptable Use',
    '平台规则',
  ]);
}

export default async function AcceptableUsePage() {
  const { siteName, supportEmail } = await getPublicSiteSettings();

  return (
    <MarketingShell>
      <PublicPageHero
        eyebrow="使用协议"
        title={`明确 ${siteName} 的允许使用方式与限制`}
        description="这份协议用于说明平台适用的使用边界、禁止行为和异常使用处理原则，帮助你更清楚地理解平台规则。"
      />

      <section
        className="bg-[#0A0A0A] py-16 md:py-20"
        style={{ contentVisibility: 'auto', containIntrinsicSize: '1320px' }}
      >
        <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
          <div className="space-y-10 rounded-3xl border border-[#2B2B2B] bg-[#141414] p-8 md:p-10">
            {legalSections.acceptableUse.map((section) => (
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
              <h2 className="text-2xl font-semibold text-white">补充说明</h2>
              <p className="mt-4 text-sm leading-8 text-[#B5B5B5]">
                若你对使用边界、限制措施或某类具体场景是否适用存在疑问，请通过 {supportEmail} 联系我们确认。
              </p>
            </section>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
