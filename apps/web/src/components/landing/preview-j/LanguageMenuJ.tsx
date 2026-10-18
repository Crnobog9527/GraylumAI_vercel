/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { Check, ChevronDown, Globe } from 'lucide-react';
import { J_NAV } from '@/lib/landing/landing-copy-j-chrome';
import { cn } from '@/lib/utils';
import styles from './chrome-j.module.css';

/**
 * The language switch (Owner 2026-10-15): a globe with the current language, opening a small menu of the languages,
 * the current one ticked and English greyed out as "即将推出" (no link, no hreflang until /en exists). `up` opens it
 * above the button (the footer). Keyboard: Enter or Space opens it on the first choice, the arrow keys move, Escape
 * closes it and returns to the button; a click elsewhere closes it.
 */
export function LanguageMenuJ({ up = false, full = false, className }: { up?: boolean; full?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const current = J_NAV.languages.find(item => item.current) ?? J_NAV.languages[0];
  /** The choices that can be focused: the linked languages (English is not one until /en exists). */
  const items = () => Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not([aria-disabled="true"])') ?? []);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('click', onClick);
    // Opening moves the focus to the first choice, so the arrow keys work straight away.
    items()[0]?.focus();
    return () => document.removeEventListener('click', onClick);
  }, [open]);

  const onMenuKey = (event: KeyboardEvent) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); button.current?.focus(); }
    if (event.key === 'ArrowDown') { event.preventDefault(); list[(at + 1) % list.length]?.focus(); }
    if (event.key === 'ArrowUp') { event.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus(); }
    if (event.key === 'Home') { event.preventDefault(); list[0]?.focus(); }
    if (event.key === 'End') { event.preventDefault(); list[list.length - 1]?.focus(); }
    if (event.key === 'Tab') setOpen(false);
  };

  return (
    <div ref={root} className={cn(styles.lang, className)} data-up={up || undefined}>
      <button ref={button} type="button" className={styles.langButton} aria-haspopup="menu" aria-expanded={open} aria-controls={menuId}
        aria-label={`${J_NAV.languageLabel}：${current.label}`} onClick={() => setOpen(value => !value)}
        onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } }}>
        <Globe size={16} aria-hidden="true" /><span>{full ? current.label : current.short}</span>
        <ChevronDown size={14} aria-hidden="true" className={styles.langChevron} />
      </button>
      <div id={menuId} role="menu" aria-label={J_NAV.languageLabel} className={styles.langMenu} hidden={!open} onKeyDown={onMenuKey}>
        {J_NAV.languages.map(item => (item.href ? (
          <Link key={item.lang} href={item.href} hrefLang={item.lang} lang={item.lang} role="menuitemradio" aria-checked={item.current}
            tabIndex={-1} onClick={() => setOpen(false)}>
            <span>{item.label}</span>{item.current ? <Check size={15} aria-hidden="true" /> : null}
          </Link>
        ) : (
          <span key={item.lang} lang={item.lang} role="menuitemradio" aria-checked={false} aria-disabled="true" className={styles.langSoon}>
            <span>{item.label}</span><small>{J_NAV.soon}</small>
          </span>
        )))}
      </div>
    </div>
  );
}
