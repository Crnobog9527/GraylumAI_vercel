/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { J_FOOTER, linkReady } from '@/lib/landing/landing-copy-j-chrome';
import { LanguageMenuJ } from './LanguageMenuJ';
import styles from './chrome-j.module.css';
import page from './j.module.css';

/**
 * Sample J's footer (the Owner's, 2026-10-15): four columns (产品, 资源, 公司, 法律), then a
 * line with the logo and the site's one-line definition, the language switch and the copyright. No social accounts
 * until the Owner gives them. Column titles are not headings.
 */
export function SiteFooterJ({ onlyBuilt = false, supportEmail }: { onlyBuilt?: boolean; supportEmail?: string | null } = {}) {
  // The production home page links only pages that exist (linkReady); an emptied column goes.
  const columns = J_FOOTER.columns.map(column => ({ ...column, links: onlyBuilt ? column.links.filter(link => linkReady(link.href)) : column.links }))
    .filter(column => column.links.length > 0);
  return (
    <footer className={styles.footer} data-region="页脚">
      <div className={page.wrap}>
        <nav className={styles.columns} aria-label={J_FOOTER.label}>
          {columns.map(column => (
            <div key={column.title} className={styles.column}>
              <p>{column.title}</p>
              <ul>
                {column.links.map(link => <li key={link.href}><Link href={link.href}>{link.label}</Link></li>)}
              </ul>
            </div>
          ))}
        </nav>
        <div className={styles.base}>
          <p className={styles.definition}>
            <img src="/graylum-logo.svg" alt="" aria-hidden="true" width={24} height={24} />{J_FOOTER.definition}
          </p>
          <LanguageMenuJ up full />
          {supportEmail ? <a className={styles.rights} href={`mailto:${supportEmail}`}>{supportEmail}</a> : null}
          <p className={styles.rights}>{J_FOOTER.rights}</p>
        </div>
      </div>
    </footer>
  );
}
