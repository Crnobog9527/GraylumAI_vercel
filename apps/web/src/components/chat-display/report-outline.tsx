/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { useState, type ReactNode, type Ref } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import styles from "./report-outline.module.css";

/**
 * Display-only chapter list of the report dialog: chapters, the current one, and a callback. No queries and
 * no scrolling of its own, so the product dialog and the landing page render the same markup. Wide screens
 * show it as a left column; narrow screens fold it into a bar above the text that opens the list.
 */

export type ReportChapter = { id: string; title: string };

/** Fewer chapters than this is not worth a table of contents: the dialog stays as it was. */
export const REPORT_OUTLINE_MIN_CHAPTERS = 2;

export const REPORT_OUTLINE_LABEL = "报告目录";

export function ReportOutline({ chapters, activeId, onSelect }: {
  chapters: ReportChapter[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = chapters.find(chapter => chapter.id === activeId) ?? chapters[0];
  return (
    <nav aria-label={REPORT_OUTLINE_LABEL} className={styles.outline}>
      <button type="button" className={styles.toggle} aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span className={styles.toggleLabel}>目录</span>
        <span className={styles.toggleCurrent}>{active?.title}</span>
        <ChevronDown size={16} aria-hidden="true" className={cn(styles.chevron, open && styles.chevronOpen)} />
      </button>
      <p className={styles.heading}>目录</p>
      <ol className={styles.list} data-open={open ? "" : undefined}>
        {chapters.map(chapter => (
          <li key={chapter.id}>
            <button type="button" aria-current={chapter.id === active?.id ? "location" : undefined}
              onClick={() => { setOpen(false); onSelect(chapter.id); }}>
              {chapter.title}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * The report text with its chapter list beside it. `bodyRef` always points at the text, so a reader can find
 * the chapters in it; with too few chapters the list is left out and the text renders as before.
 */
export function ReportWithOutline({ chapters, activeId, onSelect, bodyRef, children }: {
  chapters: ReportChapter[];
  activeId: string | null;
  onSelect: (id: string) => void;
  bodyRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  const shown = chapters.length >= REPORT_OUTLINE_MIN_CHAPTERS;
  // The text keeps its element when the list appears (chapters arrive while it is written), so `bodyRef` stays valid.
  return (
    <div className={shown ? styles.layout : undefined}>
      {shown && <ReportOutline chapters={chapters} activeId={activeId} onSelect={onSelect} />}
      <div ref={bodyRef} className={shown ? styles.body : undefined}>{children}</div>
    </div>
  );
}
