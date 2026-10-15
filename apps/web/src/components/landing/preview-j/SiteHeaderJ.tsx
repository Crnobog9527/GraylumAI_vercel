/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, Menu, X } from 'lucide-react';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { J_NAV, type ChromeLink } from '@/lib/landing/landing-copy-j-chrome';
import { cn } from '@/lib/utils';
import { LanguageMenuJ } from './LanguageMenuJ';
import styles from './chrome-j.module.css';
import page from './j.module.css';

/**
 * Sample J's full header (the Owner's, 2026-10-15): 产品 opens a menu (on hover or click; Escape and outside clicks
 * close it), then 教程, 价格, 常见问题, 关于我们; on the right the language switch, 登录 and 免费试用. Below 1100px
 * everything but the logo and the button folds into a menu.
 */
export function SiteHeaderJ({ siteName }: { siteName: string }) {
  const [open, setOpen] = useState<'product' | null>(null);
  const [drawer, setDrawer] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const drawerId = useId();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(null); setDrawer(false); } };
    const onClick = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(null); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('click', onClick); };
  }, []);

  return (
    <header ref={ref} className={page.header}>
      <div className={cn(page.wrap, styles.bar)}>
        <Link href="/landing" className={page.brand}>
          <img src="/graylum-logo.svg" alt="" aria-hidden="true" width={28} height={28} />{siteName}
        </Link>
        <nav className={styles.desktop} aria-label={J_NAV.label}>
          <Menu_ id="product" label={J_NAV.product.label} links={J_NAV.product.links} open={open} setOpen={setOpen} wide />
          {J_NAV.places.map(link => <Link key={link.href} href={link.href} className={styles.item}>{link.label}</Link>)}
        </nav>
        <div className={styles.end}>
          <LanguageMenuJ className={styles.desktopOnly} />
          <Link href={J_NAV.login.href} className={cn(page.pillSmallLight, styles.desktopOnly)}>{J_NAV.login.label}</Link>
          <Link href={SIGNUP_CTA_HREF} className={page.pillSmall}>{J_NAV.cta}</Link>
          <button type="button" className={styles.burger} aria-expanded={drawer} aria-controls={drawerId}
            aria-label={drawer ? J_NAV.close : J_NAV.menu} onClick={() => setDrawer(value => !value)}>
            {drawer ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
          </button>
        </div>
      </div>
      <div id={drawerId} className={styles.drawer} hidden={!drawer}>
        <nav className={page.wrap} aria-label={J_NAV.label}>
          <div className={styles.drawerGroup}>
            <p>{J_NAV.product.label}</p>
            {J_NAV.product.links.map(link => <Link key={link.href} href={link.href} onClick={() => setDrawer(false)}>{link.label}</Link>)}
          </div>
          <div className={styles.drawerGroup}>
            {[...J_NAV.places, J_NAV.login].map(link => (
              <Link key={link.href} href={link.href} onClick={() => setDrawer(false)}>{link.label}</Link>
            ))}
          </div>
          <LanguageMenuJ up full className={styles.drawerLanguages} />
        </nav>
      </div>
    </header>
  );
}

function Menu_({ id, label, links, open, setOpen, wide = false }: {
  id: 'product'; label: string; links: readonly ChromeLink[];
  open: string | null; setOpen: (value: 'product' | null) => void; wide?: boolean;
}) {
  const panelId = useId();
  const shown = open === id;
  return (
    <div className={styles.menu} data-open={shown || undefined} onMouseEnter={() => setOpen(id)} onMouseLeave={() => setOpen(null)}>
      <button type="button" className={styles.item} aria-expanded={shown} aria-controls={panelId}
        onClick={() => setOpen(shown ? null : id)}>
        {label}<ChevronDown size={15} aria-hidden="true" />
      </button>
      <div id={panelId} className={cn(styles.panel, wide && styles.panelWide)} hidden={!shown}>
        {links.map(link => (
          <Link key={link.href} href={link.href} onClick={() => setOpen(null)}>
            <b>{link.label}</b>{link.note ? <span>{link.note}</span> : null}
          </Link>
        ))}
      </div>
    </div>
  );
}
