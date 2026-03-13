/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import MarketingShell from '@/components/landing/MarketingShell';
import PublicPageHero from '@/components/landing/PublicPageHero';
import { faqItems } from '@/lib/landing-content';
import { buildPublicPageMetadata } from '@/lib/public-site';

export async function generateMetadata() {
  return buildPublicPageMetadata(
    '常见问题',
    '查看产品定位、适用对象、套餐选择、数据安全和支持方式等高频问题。',
    ['常见问题', 'FAQ', '数据安全', '套餐选择']
  );
}

export default function FAQPage() {
  return (
    <MarketingShell>
      <PublicPageHero
        eyebrow="常见问题"
        title="在开始之前，先把关键问题说清楚"
        description="如果你在判断这套产品是否适合自己、是否适合团队、以及应该如何开始，这些问题最值得先看。"
        primaryAction={{ label: '开始体验', href: '/login?action=signup' }}
        secondaryAction={{ label: '联系我们', href: '/contact' }}
      />

      <section
        className="bg-[#0A0A0A] py-16 md:py-20"
        style={{ contentVisibility: 'auto', containIntrinsicSize: '980px' }}
      >
        <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
          <div className="space-y-4">
            {faqItems.map((item) => (
              <article key={item.question} className="rounded-2xl border border-[#2B2B2B] bg-[#141414] p-6 md:p-7">
                <h2 className="text-xl font-semibold text-white">{item.question}</h2>
                <p className="mt-4 text-sm leading-8 text-[#B4B4B4]">{item.answer}</p>
              </article>
            ))}
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
