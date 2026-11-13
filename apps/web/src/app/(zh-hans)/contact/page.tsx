/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { ArrowRight, Mail, MessageSquareMore } from 'lucide-react';
import MarketingShell from '@/components/landing/MarketingShell';
import { ExpertConsultCard } from '@/components/expert-consult/ExpertConsultCard';
import { expertConsultPath } from '@/components/expert-consult/expertConsultCopy';
import PublicPageHero from '@/components/landing/PublicPageHero';
import styles from '@/components/public-site/article.module.css';
import { contactChannels } from '@/lib/landing-content';
import { getPublicSiteSettings } from '@/lib/public-site';
import { buildPageMetadata } from '@/lib/seo/metadata';
import { buildAuthHref } from '@/lib/site-config';

// Static with hourly refresh: the support e-mail comes from site settings (SEO_GEO_SPEC section 9).
export const revalidate = 3600;

export function generateMetadata() {
  return buildPageMetadata({
    title: '联系我们',
    description: '获取商务合作、产品咨询与支持反馈入口，快速找到适合你的沟通方式。',
    path: '/contact',
  });
}

export default async function ContactPage() {
  const { supportEmail } = await getPublicSiteSettings();

  return (
    <MarketingShell>
      <div className={styles.article} data-wide="">
        <PublicPageHero
          eyebrow="联系我们"
          title="需要进一步沟通时，直接找到正确入口"
          description="如果你在评估产品、准备团队使用，或者使用过程中遇到具体问题，这里提供一个更直接的联系入口。"
          primaryAction={{ label: '开始体验', href: '/login?action=signup&lang=zh-Hans' }}
          secondaryAction={{ label: '查看常见问题', href: '/faq' }}
        />

        <div className={styles.split} data-zone="work" style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 900px' }}>
          <div>
            {contactChannels.map((channel) => (
              <div key={channel.title} className={styles.card}>
                <h2 className={styles.h3}>{channel.title}</h2>
                <p className={styles.text}>{channel.description}</p>
              </div>
            ))}
            <ExpertConsultCard href={buildAuthHref(expertConsultPath('studio'))} />
          </div>

          <div className={styles.card}>
            <span className={styles.icon}><Mail className="h-5 w-5" aria-hidden="true" /></span>
            <h2 className={styles.cardTitle}>支持邮箱</h2>
            <p className={styles.text}>
              当前统一联系邮箱已接入系统配置，适合商务合作、产品咨询和支持反馈。
            </p>
            <a href={`mailto:${supportEmail}`} className={styles.mail}>
              {supportEmail}
              <ArrowRight className="h-4 w-4 flex-none" aria-hidden="true" />
            </a>

            <div className={styles.inset}>
              <span className={styles.icon}><MessageSquareMore className="h-5 w-5" aria-hidden="true" /></span>
              <h3 className={styles.h3}>产品内支持</h3>
              <p className={styles.text}>
                如果你已经注册并进入产品，可以使用工单系统提交更具体的问题，这通常更适合定位账号、功能或使用流程相关反馈。
              </p>
            </div>
          </div>
        </div>
      </div>
    </MarketingShell>
  );
}
