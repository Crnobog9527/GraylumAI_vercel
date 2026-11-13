/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import styles from '@/components/public-site/article.module.css';
import { buildAuthHref } from '@/lib/site-config';

type PageAction = {
  label: string;
  href: string;
};

/**
 * The first block of the marketing pages on the public shell (contact, accessibility), in the home page's look (Owner
 * 2026-11-14, PUBLIC-SITE): a small gold tag, the display title, the lead and up to two pill buttons.
 */
export default function PublicPageHero({
  eyebrow,
  title,
  description,
  primaryAction,
  secondaryAction,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  primaryAction?: PageAction;
  secondaryAction?: PageAction;
  children?: ReactNode;
}) {
  return (
    <section className={styles.hero}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.lead}>{description}</p>
      {(primaryAction || secondaryAction) && (
        <div className={styles.actions}>
          {primaryAction ? (
            <Link
              href={
                primaryAction.href.startsWith('/login') || primaryAction.href.startsWith('/register')
                  ? buildAuthHref(primaryAction.href)
                  : primaryAction.href
              }
              className={styles.pill}
            >
              {primaryAction.label}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          ) : null}
          {secondaryAction ? (
            <Link href={secondaryAction.href} className={styles.pillLight}>
              {secondaryAction.label}
            </Link>
          ) : null}
        </div>
      )}
      {children}
    </section>
  );
}
