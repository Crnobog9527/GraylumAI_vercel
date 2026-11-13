import type { ReactNode } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import light from '@/components/design/light-tokens.module.css';
import { BackdropJ } from '@/components/landing/preview-j/BackdropJ';
import dawn from '@/components/landing/preview-l/dawn-l.module.css';
import { resolveSiteName } from '@/lib/site-config';
import styles from './auth-shell.module.css';

/**
 * The one shell of the sign-in pages (login, sign-up, email verification, forgot and reset password) and of the maintenance and
 * access-denied pages: the public layer's canvas, a brand header that leads back to the home page, and a white card. Look only.
 * In the home page's "晨光" look (Owner 2026-11-14, PUBLIC-SITE): its backdrop (grid and three pools of light, in their first
 * position; nothing to follow on a one-card page), its .dawn values for the pill, a glass card.
 */
export function AuthShell({ children, siteName, homeHref = '/' }: { children: ReactNode; siteName?: string; homeHref?: string }) {
  return (
    <main className={`${light.light} ${dawn.dawn} ${styles.shell}`} data-zone="hero">
      <BackdropJ />
      <header className={styles.header}>
        <Link href={homeHref} className={styles.brand}>
          <img src="/graylum-logo.svg" alt="" aria-hidden="true" className={styles.logo} />
          <span>{siteName ?? resolveSiteName()}</span>
        </Link>
      </header>
      <div className={styles.stage}><div className={styles.column}>{children}</div></div>
    </main>
  );
}

/** The white card of the shell; `className` adds the vertical rhythm of the content (Tailwind `space-y-*`). */
export function AuthCard({ children, className = 'space-y-6' }: { children: ReactNode; className?: string }) {
  return <section className={`${styles.card} ${className}`}>{children}</section>;
}

/** The card's head: an optional icon tile, the page title (the page's only h1) and a short lead. */
export function AuthHead({ icon, title, lead }: { icon?: ReactNode; title: ReactNode; lead?: ReactNode }) {
  return (
    <div className="space-y-5 text-center">
      {icon && <div className={styles.tile}>{icon}</div>}
      <div className="space-y-2">
        <h1 className={styles.title}>{title}</h1>
        {lead && <p className={styles.lead}>{lead}</p>}
      </div>
    </div>
  );
}

/** A quiet bordered block inside the card (hints, the redirect target, the links under a form). */
export function AuthPanel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`${styles.panel} ${className}`}>{children}</div>;
}

/** Two choices in one pill (sign in / sign up); the chosen one is dark. */
export function AuthSegment({ value, options, onChange }: {
  value: string; options: ReadonlyArray<{ value: string; label: string }>; onChange: (value: string) => void;
}) {
  return (
    <div className={styles.segment}>
      {options.map(option => (
        <button key={option.value} type="button" aria-pressed={value === option.value} className={styles.segmentItem}
          onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  );
}

export function AuthDivider({ children }: { children: ReactNode }) {
  return <div className={styles.divider}>{children}</div>;
}

export function AuthLoading() {
  return <AuthShell><AuthCard className="flex justify-center py-12"><Loader2 className="h-7 w-7 animate-spin" aria-label="加载中" /></AuthCard></AuthShell>;
}

// Fields, buttons and links. The 8px field (white, --gl-border-control, 16px text so iOS does not zoom), the 52px pill for the one main action.
export const AUTH_INPUT_CLASS = [
  'h-12 rounded-lg border-[var(--gl-border-control)] bg-white text-base text-[var(--gl-text)]', 'placeholder:text-[var(--gl-text-placeholder)]',
].join(' ');
export const AUTH_LABEL_CLASS = 'text-sm font-medium text-[var(--pub-ink)]';
export const AUTH_PRIMARY_BUTTON_CLASS = [
  'h-[52px] w-full rounded-full bg-[var(--pub-ink)] px-7 text-[17px] font-medium text-white', 'hover:bg-[var(--pub-action-hover)]',
  // The home page's dark gradient pill (dawn-l.module.css values, set on the shell), the plain ink where they are not set.
  '[background:var(--j-pill-bg,var(--pub-ink))] hover:[background:var(--j-pill-bg-hover,var(--pub-action-hover))] shadow-[var(--j-pill-shadow,none)]',
].join(' ');
export const AUTH_SECONDARY_BUTTON_CLASS = [
  'h-12 rounded-full border-[var(--pub-line)] bg-white px-5 text-[15px] font-medium text-[var(--pub-ink)]', 'hover:bg-[var(--gl-surface-subtle)]',
].join(' ');
export const AUTH_LINK_CLASS = 'text-[var(--pub-ink)] underline underline-offset-4 hover:text-[var(--pub-action-hover)]';
