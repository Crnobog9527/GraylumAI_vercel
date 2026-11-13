'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useRef, useState } from 'react';
import { List, X } from 'lucide-react';
import styles from './legal-document.module.css';

type Section = { id: string; title: string };
/** Fewer sections than this and the document is short enough to scroll: no button. */
const MIN_SECTIONS = 4;

/**
 * A phone's way round a long legal document (under 640px; Owner 2026-11-12, phone plan A). The terms and the privacy policy
 * run to tens of screens, and their own table of contents is at the top only. A button that stays in the corner opens the
 * list of sections as a sheet on the bottom edge; a section in it jumps there, and the first row goes back to the top.
 * The list is the document's own numbered headings, read from the page: nothing of the text is rewritten or kept twice.
 * A native <dialog>, so these static pages load no dialog library for it.
 */
export function LegalDocNav() {
  const sheet = useRef<HTMLDialogElement>(null);
  const [sections, setSections] = useState<Section[]>([]);
  useEffect(() => {
    const headings = document.querySelectorAll<HTMLElement>('[data-legal-doc] h2[id]');
    setSections([...headings].map(heading => ({ id: heading.id, title: (heading.textContent ?? '').trim() })));
  }, []);
  if (sections.length < MIN_SECTIONS) return null;
  const close = () => sheet.current?.close();
  const go = (id: string | null) => {
    close();
    if (!id) { window.scrollTo({ top: 0 }); return; }
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
    // The address names the section, as the document's own links do; nothing is added to the history for each jump.
    window.history.replaceState(window.history.state, '', `#${id}`);
  };
  return <>
    <button type="button" className={styles.navButton} aria-haspopup="dialog" onClick={() => sheet.current?.showModal()}>
      <List size={18} aria-hidden="true" />目录</button>
    <dialog ref={sheet} className={styles.navSheet} aria-label="目录"
      // A press on the dimmed page around the sheet (the dialog's own box is the sheet; the rest is its backdrop) closes it.
      onClick={event => { if (event.target === sheet.current) close(); }}>
      <header><strong>目录</strong><button type="button" aria-label="关闭" onClick={close}><X size={20} aria-hidden="true" /></button></header>
      <ol lang="en">
        <li><button type="button" lang="zh-Hans" onClick={() => go(null)}>回到顶部</button></li>
        {sections.map(section => <li key={section.id}>
          <a href={`#${section.id}`} onClick={event => { event.preventDefault(); go(section.id); }}>{section.title}</a></li>)}
      </ol>
    </dialog>
  </>;
}
