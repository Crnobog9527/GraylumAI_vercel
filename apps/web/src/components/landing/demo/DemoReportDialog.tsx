/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MessageMarkdown } from '@/components/chat/MessageMarkdown';
import result from '@/components/opc/positioning-result.module.css';
import { REPORT_BODY, REPORT_INTRO, REPORT_TITLE } from './demo-script';
import styles from './demo.module.css';

const FOCUSABLE = 'button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';

/**
 * The sample report, in the same card the positioning report dialog uses. Focus moves to the close button on open,
 * Tab stays inside, Esc closes from anywhere, and focus returns to the button that opened it.
 */
export function DemoReportDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== 'Tab' || !dialog.current) return;
      const items = Array.from(dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0], last = items[items.length - 1];
      const inside = dialog.current.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || !inside)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !inside)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); opener?.focus?.(); };
  }, []);

  return (
    <div className={styles.overlay} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={REPORT_TITLE} className={`${result.consentCard} !max-w-2xl`}>
        <header>
          <h2>{REPORT_TITLE}</h2>
          <Button ref={close} className={result.consentClose} variant="ghost" aria-label="关闭报告" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </Button>
        </header>
        <p>{REPORT_INTRO}</p>
        <MessageMarkdown text={REPORT_BODY} />
      </div>
    </div>
  );
}
