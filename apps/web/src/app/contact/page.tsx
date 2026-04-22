/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { ArrowRight, Mail, MessageSquareMore } from 'lucide-react';
import MarketingShell from '@/components/landing/MarketingShell';
import PublicPageHero from '@/components/landing/PublicPageHero';
import { contactChannels } from '@/lib/landing-content';
import { buildPublicPageMetadata, getPublicSiteSettings } from '@/lib/public-site';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  return buildPublicPageMetadata(
    '联系我们',
    '获取商务合作、产品咨询与支持反馈入口，快速找到适合你的沟通方式。',
    ['联系我们', '商务合作', '产品咨询', '支持反馈']
  );
}

export default async function ContactPage() {
  const { supportEmail } = await getPublicSiteSettings();

  return (
    <MarketingShell>
      <PublicPageHero
        eyebrow="联系我们"
        title="需要进一步沟通时，直接找到正确入口"
        description="如果你在评估产品、准备团队使用，或者使用过程中遇到具体问题，这里提供一个更直接的联系入口。"
        primaryAction={{ label: '开始体验', href: '/login?action=signup' }}
        secondaryAction={{ label: '查看常见问题', href: '/faq' }}
      />

      <section
        className="bg-[#0A0A0A] py-16 md:py-20"
        style={{ contentVisibility: 'auto', containIntrinsicSize: '1080px' }}
      >
        <div className="mx-auto grid max-w-6xl gap-6 px-4 sm:px-6 lg:grid-cols-[1.1fr,0.9fr] lg:px-8">
          <div className="grid gap-6">
            {contactChannels.map((channel) => (
              <div key={channel.title} className="rounded-2xl border border-[#2B2B2B] bg-[#141414] p-6">
                <h2 className="text-xl font-semibold text-white">{channel.title}</h2>
                <p className="mt-3 text-sm leading-7 text-[#B1B1B1]">{channel.description}</p>
              </div>
            ))}
          </div>

          <div className="rounded-3xl border border-[#FFD700]/20 bg-gradient-to-b from-[#181818] to-[#111111] p-8 shadow-[0_18px_56px_rgba(0,0,0,0.18)]">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-[#FFD700]/12 text-[#FFD700]">
              <Mail className="h-6 w-6" />
            </div>
            <h2 className="mt-6 text-2xl font-semibold text-white">支持邮箱</h2>
            <p className="mt-3 text-sm leading-7 text-[#B1B1B1]">
              当前统一联系邮箱已接入系统配置，适合商务合作、产品咨询和支持反馈。
            </p>
            <a
              href={`mailto:${supportEmail}`}
              className="mt-6 inline-flex items-center gap-2 text-base font-semibold text-[#FFD700] transition-colors hover:text-[#FFE48A]"
            >
              {supportEmail}
              <ArrowRight className="h-4 w-4" />
            </a>

            <div className="mt-10 rounded-2xl border border-[#2A2A2A] bg-[#101010] p-5">
              <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-white/5 text-white">
                <MessageSquareMore className="h-5 w-5" />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-white">产品内支持</h3>
              <p className="mt-2 text-sm leading-7 text-[#AFAFAF]">
                如果你已经注册并进入产品，可以使用工单系统提交更具体的问题，这通常更适合定位账号、功能或使用流程相关反馈。
              </p>
            </div>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
