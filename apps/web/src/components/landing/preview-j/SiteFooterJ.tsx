/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { ConsentPreferenceLinks } from '@/components/analytics/ConsentPreferenceLinks';
import { ANALYTICS_CONFIG } from '@/lib/analytics/config';
import { J_COOKIE_SETTINGS_HREF, J_FOOTER, linkReady } from '@/lib/landing/landing-copy-j-chrome';
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
  // With Termly in place, its own two entries (change or withdraw consent; do not sell or share) take the static
  // cookie link's place, as the public site's footer has them (ANALYTICS plan section 3.4).
  const termly = Boolean(ANALYTICS_CONFIG.termlyWebsiteUuid);
  const columns = J_FOOTER.columns.map(column => {
    const consent = column.links.some(link => link.href === J_COOKIE_SETTINGS_HREF);
    const links = column.links.filter(link => (!onlyBuilt || linkReady(link.href)) && !(termly && link.href === J_COOKIE_SETTINGS_HREF));
    return { ...column, links, consent };
  }).filter(column => column.links.length > 0 || column.consent);
  return (
    <footer className={styles.footer} data-region="页脚">
      <div className={page.wrap}>
        <nav className={styles.columns} aria-label={J_FOOTER.label}>
          {columns.map(column => (
            <div key={column.title} className={styles.column}>
              <p>{column.title}</p>
              <ul>
                {column.links.map(link => <li key={link.href}><Link href={link.href}>{link.label}</Link></li>)}
                {column.consent ? <ConsentPreferenceLinks className={styles.consent} /> : null}
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
