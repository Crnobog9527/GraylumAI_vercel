/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import MarketingShell from '@/components/landing/MarketingShell';
import PublicPageHero from '@/components/landing/PublicPageHero';
import { sectionZone } from '@/components/public-site/ArticlePage';
import styles from '@/components/public-site/article.module.css';
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
      <div className={styles.article}>
        <PublicPageHero
          eyebrow="无障碍声明"
          title={`${siteName} 的无障碍承诺`}
          description={ACCESSIBILITY_STATEMENT.intro}
        />

        {ACCESSIBILITY_STATEMENT.sections.map((section, index) => (
          <section key={section.title} className={styles.section} data-zone={sectionZone(index)}>
            <h2>{section.title}</h2>
            {section.paragraphs.map((paragraph) => (
              <p key={paragraph} className={styles.text}>{paragraph}</p>
            ))}
          </section>
        ))}
        <section className={styles.section} data-zone="final">
          <h2>反馈与联系</h2>
          <p className={styles.text}>
            如果你在使用中遇到无法访问的内容，或需要其他形式的信息，请发邮件到{' '}
            <a className={styles.textLink} href={`mailto:${supportEmail}`}>{supportEmail}</a>
            ，写明页面地址、你遇到的问题和使用的设备或辅助工具。我们会尽快回复并处理。
          </p>
          <p className={styles.byline}>最近更新：{ACCESSIBILITY_STATEMENT.updated}</p>
        </section>
      </div>
    </MarketingShell>
  );
}
