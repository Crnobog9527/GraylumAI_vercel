/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import styles from './j.module.css';

const PHONE = '(max-width: 767px)';

/**
 * On a phone, the voice wall's answer folds to its heading with a button that opens the full answer (sample L, Owner
 * 2026-10-17: all seven notes stay, set tighter on a phone). The server HTML and larger screens show it open.
 */
export function FoldOnPhoneJ({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const id = useId();
  useEffect(() => { if (window.matchMedia?.(PHONE).matches) setOpen(false); }, []);
  return (
    <>
      <div id={id} hidden={!open}>{children}</div>
      {open ? null : (
        <button type="button" className={styles.foldButton} aria-expanded="false" aria-controls={id} onClick={() => setOpen(true)}>
          {label}<ChevronDown size={15} aria-hidden="true" />
        </button>
      )}
    </>
  );
}
