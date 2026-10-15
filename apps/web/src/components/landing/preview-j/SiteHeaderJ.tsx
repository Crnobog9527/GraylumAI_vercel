/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, Menu, X } from 'lucide-react';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { J_NAV, type ChromeLink } from '@/lib/landing/landing-copy-j-chrome';
import { HERO } from '@/lib/landing/landing-copy';
import { cn } from '@/lib/utils';
import styles from './chrome-j.module.css';
import page from './j.module.css';

/**
 * Sample J's full header (round six, the controller's plan of 2026-10-15): 产品 and 资源 open a menu (on hover or
 * click, Escape and outside clicks close it), then 样例报告, 价格, 关于我们, the language switch, 登录 and the button.
 * Below 1100px everything but the logo and the button folds into a menu.
 */
export function SiteHeaderJ({ siteName }: { siteName: string }) {
  const [open, setOpen] = useState<'product' | 'resources' | null>(null);
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
          <Link href={J_NAV.samples.href} className={styles.item}>{J_NAV.samples.label}</Link>
          <Link href={J_NAV.pricing.href} className={styles.item}>{J_NAV.pricing.label}</Link>
          <Menu_ id="resources" label={J_NAV.resources.label} links={J_NAV.resources.links} open={open} setOpen={setOpen} />
          <Link href={J_NAV.about.href} className={styles.item}>{J_NAV.about.label}</Link>
        </nav>
        <div className={styles.end}>
          <Languages className={styles.desktopOnly} />
          <Link href={J_NAV.login.href} className={cn(page.pillSmallLight, styles.desktopOnly)}>{J_NAV.login.label}</Link>
          <Link href={SIGNUP_CTA_HREF} className={page.pillSmall}>{HERO.primaryCta}</Link>
          <button type="button" className={styles.burger} aria-expanded={drawer} aria-controls={drawerId}
            aria-label={drawer ? J_NAV.close : J_NAV.menu} onClick={() => setDrawer(value => !value)}>
            {drawer ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
          </button>
        </div>
      </div>
      <div id={drawerId} className={styles.drawer} hidden={!drawer}>
        <nav className={page.wrap} aria-label={J_NAV.label}>
          {[J_NAV.product, J_NAV.resources].map(group => (
            <div key={group.label} className={styles.drawerGroup}>
              <p>{group.label}</p>
              {group.links.map(link => <Link key={link.href} href={link.href} onClick={() => setDrawer(false)}>{link.label}</Link>)}
            </div>
          ))}
          <div className={styles.drawerGroup}>
            {[J_NAV.samples, J_NAV.pricing, J_NAV.about, J_NAV.login].map(link => (
              <Link key={link.href} href={link.href} onClick={() => setDrawer(false)}>{link.label}</Link>
            ))}
          </div>
          <Languages className={styles.drawerLanguages} />
        </nav>
      </div>
    </header>
  );
}

function Menu_({ id, label, links, open, setOpen, wide = false }: {
  id: 'product' | 'resources'; label: string; links: readonly ChromeLink[];
  open: string | null; setOpen: (value: 'product' | 'resources' | null) => void; wide?: boolean;
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

function Languages({ className }: { className?: string }) {
  return (
    <div className={cn(styles.languages, className)} role="group" aria-label={J_NAV.languageLabel}>
      {J_NAV.languages.map(item => (
        <Link key={item.lang} href={item.href} hrefLang={item.lang} lang={item.lang} aria-current={item.current ? 'page' : undefined}>
          {item.label}
        </Link>
      ))}
    </div>
  );
}
