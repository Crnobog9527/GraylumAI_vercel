/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import MarketingShell from '@/components/landing/MarketingShell';
import PublicPageHero from '@/components/landing/PublicPageHero';
import { tutorials } from '@/lib/landing-content';
import { buildPublicPageMetadata } from '@/lib/public-site';

export async function generateMetadata() {
  return buildPublicPageMetadata(
    '使用教程',
    '查看适合新用户的社媒增长使用教程，从账号审计到内容优化快速建立上手路径。',
    ['使用教程', '账号审计', '受众研究', '内容策略']
  );
}

export default function TutorialsPage() {
  return (
    <MarketingShell>
      <PublicPageHero
        eyebrow="使用教程"
        title="先按场景上手，而不是从空白对话框开始"
        description="下面这些教程按真实增长工作流拆分，适合第一次接触产品或想把使用方式整理得更清晰的人。"
        primaryAction={{ label: '开始体验', href: '/login?action=signup' }}
        secondaryAction={{ label: '查看常见问题', href: '/faq' }}
      />

      <section
        className="bg-[#0A0A0A] py-16 md:py-20"
        style={{ contentVisibility: 'auto', containIntrinsicSize: '1120px' }}
      >
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-6 lg:grid-cols-2">
            {tutorials.map((tutorial, index) => {
              const Icon = tutorial.icon;
              return (
                <article
                  key={tutorial.slug}
                  className="rounded-3xl border border-[#2B2B2B] bg-[#141414] p-7 shadow-[0_14px_44px_rgba(0,0,0,0.16)]"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-[#FFD700]/12 text-[#FFD700]">
                      <Icon className="h-6 w-6" />
                    </div>
                    <div className="rounded-full border border-[#FFD700]/20 bg-[#FFD700]/10 px-3 py-1 text-xs font-semibold text-[#FFD700]">
                      教程 {index + 1}
                    </div>
                  </div>
                  <h2 className="mt-6 text-2xl font-semibold text-white">{tutorial.title}</h2>
                  <p className="mt-3 text-sm leading-7 text-[#B1B1B1]">{tutorial.summary}</p>
                  <ol className="mt-6 space-y-3">
                    {tutorial.steps.map((step) => (
                      <li key={step} className="flex gap-3 text-sm leading-7 text-[#D0D0D0]">
                        <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[#FFD700]" />
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                </article>
              );
            })}
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
