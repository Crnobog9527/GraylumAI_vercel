/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';
import palettes from './palettes-h.module.css';
import styles from './palette-switch-h.module.css';

/*
 * Sample-only: lets the Owner compare sample H's three candidate palettes on the live page. It flips
 * `data-palette` on the page wrapper (the element carrying palettes.palette); the server HTML is the first
 * palette. The choice is kept in the address (?palette=) and, as a convenience, in this browser. Render it last
 * in the page: its block reserves room at the bottom so the pinned pill never covers the footer.
 * Remove this and the two unchosen palettes once one is picked.
 */

export const PALETTES = [
  { id: 'ivory', label: '象牙' },
  { id: 'graphite', label: '石墨' },
  { id: 'gold', label: '金点' },
] as const;
export type PaletteId = (typeof PALETTES)[number]['id'];

const STORAGE_KEY = 'graylum-sample-h-palette';

export function isPaletteId(value: unknown): value is PaletteId {
  return PALETTES.some(palette => palette.id === value);
}

function readSaved(): PaletteId | null {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('palette');
    if (isPaletteId(fromUrl)) return fromUrl;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isPaletteId(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function PaletteSwitchH() {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<PaletteId>('ivory');

  useEffect(() => {
    const saved = readSaved();
    if (saved) setActive(saved);
  }, []);

  useEffect(() => {
    const root = ref.current?.closest<HTMLElement>(`.${CSS.escape(palettes.palette)}`);
    if (!root) return;
    if (active === 'ivory') delete root.dataset.palette;
    else root.dataset.palette = active;
  }, [active]);

  const choose = (id: PaletteId) => {
    setActive(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
      const url = new URL(window.location.href);
      url.searchParams.set('palette', id);
      window.history.replaceState(window.history.state, '', url);
    } catch {
      // Storage or history unavailable: the switch still works for this view.
    }
  };

  return (
    <div ref={ref} className={styles.room}>
      <div role="group" aria-label="配色方案（样稿对比用）" className={styles.switch}>
        <span className={styles.label}>配色</span>
        {PALETTES.map(palette => (
          <button key={palette.id} type="button" aria-pressed={active === palette.id} data-swatch={palette.id}
            onClick={() => choose(palette.id)}>
            <i aria-hidden="true" />{palette.label}
          </button>
        ))}
      </div>
    </div>
  );
}
