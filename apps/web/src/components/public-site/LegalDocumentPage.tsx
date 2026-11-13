/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { readLegalDoc, type LegalDocName } from '@/lib/legal-docs';
import { SiteShell } from './SiteShell';
import { LegalDocNav } from './LegalDocNav';
import article from './article.module.css';
import styles from './legal-document.module.css';

/**
 * The MiSans licence notice (public/fonts/misans/NOTICE.txt: the site uses MiSans, copyright Xiaomi, licence in LICENSE.pdf).
 * It was the last line of every public page's footer; the Owner moved it to the terms (2026-11-14, PUBLIC-SITE: "把我们落地页
 * 下方导航栏的这行话，挪到相关的条款里面去，不要放在网站首页"). It stands under the terms document, in Chinese, outside the
 * Owner's English text, which is not changed.
 */
export const FONT_LICENCE_NOTICE = {
  title: '第三方字体许可',
  text: '本网站使用 MiSans 字体，版权归小米所有。',
  link: '字体许可协议',
  href: '/fonts/misans/LICENSE.pdf',
} as const;

/**
 * One formal legal document (privacy, terms, cookies, refund) in the public site chrome. The text is the Owner's own English
 * document, kept as trusted static HTML in this repository, so it is rendered as is. The notice above it says so in Chinese.
 */
export function LegalDocumentPage({ name }: { name: LegalDocName }) {
  const html = readLegalDoc(name);
  return (
    <SiteShell locale="zh-Hans">
      <article className={article.article}>
        <p className={article.note}>
          本页是英文法律文本，以英文为准。如有疑问，请联系 support@graylum.com。
        </p>
        <div lang="en" data-legal-doc data-zone="voice" className={styles.doc} dangerouslySetInnerHTML={{ __html: html }} />
        {name === 'terms' ? (
          <section aria-labelledby="font-licence" className={styles.fontNotice} data-zone="final">
            <h2 id="font-licence">{FONT_LICENCE_NOTICE.title}</h2>
            <p>
              {FONT_LICENCE_NOTICE.text}{' '}
              <a href={FONT_LICENCE_NOTICE.href}>{FONT_LICENCE_NOTICE.link}</a>
            </p>
          </section>
        ) : null}
        {/* A phone's way round the long documents (the list of sections, from a button in the corner). */}
        <LegalDocNav />
      </article>
    </SiteShell>
  );
}
