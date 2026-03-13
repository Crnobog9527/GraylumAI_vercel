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
  return buildPublicPageMetadata('隐私政策', '查看平台对账户信息、使用数据和安全保护的基础说明。', [
    '隐私政策',
    'Privacy Policy',
    '数据安全',
  ]);
}

export default async function PrivacyPage() {
  const { siteName, supportEmail } = await getPublicSiteSettings();

  return (
    <MarketingShell>
      <PublicPageHero
        eyebrow="隐私政策"
        title={`了解 ${siteName} 如何处理账户与使用数据`}
        description="以下内容说明平台在账户管理、服务交付、支持响应与安全审计过程中可能涉及的信息类型与使用方式。"
      />

      <section
        className="bg-[#0A0A0A] py-16 md:py-20"
        style={{ contentVisibility: 'auto', containIntrinsicSize: '1320px' }}
      >
        <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
          <div className="space-y-10 rounded-3xl border border-[#2B2B2B] bg-[#141414] p-8 md:p-10">
            {legalSections.privacy.map((section) => (
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
              <h2 className="text-2xl font-semibold text-white">联系与反馈</h2>
              <p className="mt-4 text-sm leading-8 text-[#B5B5B5]">
                如果你对数据使用方式、访问权限或隐私相关问题有疑问，可以通过 {supportEmail} 联系我们。
              </p>
            </section>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
