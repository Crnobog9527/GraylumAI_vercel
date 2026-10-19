/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { readLegalDoc, type LegalDocName } from '@/lib/legal-docs';
import { SiteShell } from './SiteShell';
import styles from './legal-document.module.css';

/**
 * One formal legal document (privacy, terms, cookies, refund) in the public site chrome. The text is the Owner's own English
 * document, kept as trusted static HTML in this repository, so it is rendered as is. The notice above it says so in Chinese.
 */
export function LegalDocumentPage({ name }: { name: LegalDocName }) {
  const html = readLegalDoc(name);
  return (
    <SiteShell locale="zh-Hans">
      <article className="mx-auto max-w-3xl px-4 py-10 sm:px-6 md:py-14">
        <p className="mb-6 rounded-lg border border-[#2b2b2b] bg-[#141414] px-4 py-3 text-sm text-[#9a9a9a]">
          本页是英文法律文本，以英文为准。如有疑问，请联系 support@graylum.com。
        </p>
        <div lang="en" className={styles.doc} dangerouslySetInnerHTML={{ __html: html }} />
      </article>
    </SiteShell>
  );
}
