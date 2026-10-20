/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import MarketingShell from '@/components/landing/MarketingShell';
import PublicPageHero from '@/components/landing/PublicPageHero';
import { ACCESSIBILITY_STATEMENT } from '@/lib/accessibility-statement';
import { getPublicSiteSettings } from '@/lib/public-site';
import { buildPageMetadata } from '@/lib/seo/metadata';

export function generateMetadata() {
  return buildPageMetadata({
    title: '无障碍声明',
    description: '说明 Graylum 在网站无障碍方面的目标、已知限制和反馈方式。',
    path: '/accessibility',
  });
}

export default async function AccessibilityPage() {
  const { siteName, supportEmail } = await getPublicSiteSettings();

  return (
    <MarketingShell>
      <PublicPageHero
        eyebrow="无障碍声明"
        title={`${siteName} 的无障碍承诺`}
        description={ACCESSIBILITY_STATEMENT.intro}
      />

      <section className="bg-[#0A0A0A] py-16 md:py-20">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
          <div className="space-y-10 rounded-3xl border border-[#2B2B2B] bg-[#141414] p-8 md:p-10">
            {ACCESSIBILITY_STATEMENT.sections.map((section) => (
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
              <h2 className="text-2xl font-semibold text-white">反馈与联系</h2>
              <p className="mt-4 text-sm leading-8 text-[#B5B5B5]">
                如果你在使用中遇到无法访问的内容，或需要其他形式的信息，请发邮件到{' '}
                <a className="text-[#FFD700] underline underline-offset-2" href={`mailto:${supportEmail}`}>{supportEmail}</a>
                ，写明页面地址、你遇到的问题和使用的设备或辅助工具。我们会尽快回复并处理。
              </p>
              <p className="mt-4 text-sm leading-8 text-[#B5B5B5]">最近更新：{ACCESSIBILITY_STATEMENT.updated}</p>
            </section>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
