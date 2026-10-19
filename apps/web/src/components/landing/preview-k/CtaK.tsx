/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import page from '@/components/landing/preview-j/j.module.css';
import { K_CTA } from '@/lib/landing/landing-copy-k';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import styles from './k.module.css';

/** Plan item 7: a button after regions 4 and 6, so a phone never goes six screens without one. */
export function CtaK() {
  return (
    <p className={styles.cta}>
      <Link href={SIGNUP_CTA_HREF} className={page.pill}>{K_CTA}<ArrowRight size={18} aria-hidden="true" /></Link>
    </p>
  );
}
