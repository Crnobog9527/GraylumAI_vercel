/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { J_FOOTER } from '@/lib/landing/landing-copy-j-chrome';
import { LanguageMenuJ } from './LanguageMenuJ';
import styles from './chrome-j.module.css';
import page from './j.module.css';

/**
 * Sample J's footer (the Owner's, 2026-10-15): four columns (产品, 资源, 公司, 法律), then a
 * line with the logo and the site's one-line definition, the language switch and the copyright. No social accounts
 * until the Owner gives them. Column titles are not headings.
 */
export function SiteFooterJ() {
  return (
    <footer className={styles.footer} data-region="页脚">
      <div className={page.wrap}>
        <nav className={styles.columns} aria-label={J_FOOTER.label}>
          {J_FOOTER.columns.map(column => (
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
          <p className={styles.rights}>{J_FOOTER.rights}</p>
        </div>
      </div>
    </footer>
  );
}
