/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { ReportChapter } from "./report-outline";

/** How far below the top of the scrolling area a chapter's title may sit and still count as the one being read. */
const READING_LINE = 96;

/**
 * The chapters of the rendered report: the shallowest heading level (h1–h3) used at least twice, so a single
 * report title above `##` chapters is not taken as the only chapter. Headings hidden from view (a closed
 * "show latest" box while editing) do not count. Only reads the page; the report text itself is not changed.
 */
export function findReportChapters(body: HTMLElement): HTMLElement[] {
  const visible = Array.from(body.querySelectorAll<HTMLElement>("h1,h2,h3"))
    .filter(heading => !heading.closest("details:not([open])") && heading.textContent?.trim());
  for (const level of ["H1", "H2", "H3"]) {
    const found = visible.filter(heading => heading.tagName === level);
    if (found.length >= 2) return found;
  }
  return [];
}

const sameChapters = (a: ReportChapter[], b: ReportChapter[]) =>
  a.length === b.length && a.every((chapter, index) => chapter.id === b[index].id && chapter.title === b[index].title);

/**
 * Keeps the chapter list of a report dialog in step with its text: chapters are read from the rendered
 * headings (also while the report is being written), the one at the top of `scrollRef` is the active one,
 * and selecting one scrolls it into view. Pass `bodyRef` to `ReportWithOutline`.
 */
export function useReportOutline(scrollRef: RefObject<HTMLElement | null>) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const headings = useRef<HTMLElement[]>([]);
  /** A chapter picked from the list stays highlighted until the reader scrolls by hand (it may sit too low to reach the top). */
  const picked = useRef<string | null>(null);
  const [chapters, setChapters] = useState<ReportChapter[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const track = useCallback(() => {
    const scroller = scrollRef.current;
    const list = headings.current;
    if (!scroller || list.length === 0) return setActiveId(null);
    if (picked.current && Number(picked.current.replace("chapter-", "")) < list.length) return setActiveId(picked.current);
    // At the very bottom the last chapter is the one being read, even when its title cannot reach the top.
    if (scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2)
      return setActiveId("chapter-" + (list.length - 1));
    const line = scroller.getBoundingClientRect().top + READING_LINE;
    let index = 0;
    list.forEach((heading, at) => { if (heading.getBoundingClientRect().top <= line) index = at; });
    setActiveId("chapter-" + index);
  }, [scrollRef]);

  useEffect(() => {
    const body = bodyRef.current;
    const scroller = scrollRef.current;
    if (!body || !scroller) return;
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; track(); }); };
    const scan = () => {
      headings.current = findReportChapters(body);
      const next = headings.current.map((heading, index) => ({ id: "chapter-" + index, title: heading.textContent!.trim() }));
      setChapters(old => sameChapters(old, next) ? old : next);
      schedule();
    };
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["open"] });
    const byHand = () => { picked.current = null; };
    scroller.addEventListener("scroll", schedule, { passive: true });
    for (const name of ["wheel", "touchstart", "keydown", "pointerdown"]) scroller.addEventListener(name, byHand, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", schedule);
      for (const name of ["wheel", "touchstart", "keydown", "pointerdown"]) scroller.removeEventListener(name, byHand);
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
    };
  }, [scrollRef, track]);

  const select = useCallback((id: string) => {
    const heading = headings.current[Number(id.replace("chapter-", ""))];
    if (!heading) return;
    const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    picked.current = id;
    setActiveId(id);
    heading.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
  }, []);

  return { bodyRef, chapters, activeId, select };
}
