/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { HERO } from '@/lib/landing/landing-copy';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import styles from './mno.module.css';

/**
 * Samples M, N and O's shared conversion rule (Owner 2026-10-17): once the first screen is scrolled past, a thin bar
 * with "免费和教练聊聊" stays at the top, right under the site header. The first screen is the section with
 * `#hero-title`; the bar watches it and the header's height. Sample L (Owner 2026-10-17): `phoneBottom` puts it at the
 * foot of a phone, the button alone, and `hideHeaderCta` hides the header's own sign-up button while the bar shows, so
 * the page offers one button with one wording.
 */
export function StickyCtaMNO({ line, phoneBottom = false, hideHeaderCta = false }: {
  line: string; phoneBottom?: boolean; hideHeaderCta?: boolean;
}) {
  const [shown, setShown] = useState(false);
  const [top, setTop] = useState(64);
  useEffect(() => {
    const hero = document.getElementById('hero-title')?.closest('section');
    const header = document.querySelector('header');
    if (!hero || typeof IntersectionObserver === 'undefined') return;
    const measure = () => setTop(Math.round(header?.getBoundingClientRect().height ?? 64));
    measure();
    window.addEventListener('resize', measure);
    const observer = new IntersectionObserver(([entry]) => setShown(!entry.isIntersecting && entry.boundingClientRect.top < 0));
    observer.observe(hero);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  useEffect(() => {
    if (!hideHeaderCta) return;
    const button = document.querySelector<HTMLElement>('header [data-header-cta]');
    if (!button) return;
    button.style.visibility = shown ? 'hidden' : '';
    return () => { button.style.visibility = ''; };
  }, [shown, hideHeaderCta]);
  return (
    <div className={styles.stickyCta} data-shown={shown || undefined} data-phone-bottom={phoneBottom || undefined} style={{ top }}
      aria-hidden={!shown || undefined} inert={!shown || undefined}>
      <div className={styles.stickyInner}>
        <p>{line}</p>
        <Link href={SIGNUP_CTA_HREF} className={styles.stickyButton}>{HERO.primaryCta}<ArrowRight size={15} aria-hidden="true" /></Link>
      </div>
    </div>
  );
}
