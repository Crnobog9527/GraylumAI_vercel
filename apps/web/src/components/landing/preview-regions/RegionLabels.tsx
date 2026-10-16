/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { numberRegions, pickSpot, shortName, type Box, type RegionItem } from './region-numbers';
import styles from './region-labels.module.css';

type Badge = { key: string; label: string; level: 1 | 2; top: number; left: number };
type Found = RegionItem & { node: HTMLElement };
type Spot = { dx: number; dy: number };

const FONT = "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
const visible = (node: HTMLElement) => node.getClientRects().length > 0 && !node.closest('[hidden]');

/** How many named regions enclose this one: 0 is a module, 1 a sub-block; deeper ones are not labelled. */
function depthOf(node: HTMLElement): number {
  let depth = 0;
  for (let up = node.parentElement?.closest('[data-region]'); up; up = up.parentElement?.closest('[data-region]')) depth += 1;
  return depth;
}

/** The marked regions in document order; a sample without marks falls back to main's children and the footer. */
function findRegions(): Found[] {
  const marked = Array.from(document.querySelectorAll<HTMLElement>('[data-region]'));
  if (marked.length > 0) {
    return marked.flatMap(node => {
      const depth = depthOf(node);
      return depth > 1 ? [] : [{ node, name: node.dataset.region || '模块', level: depth === 0 ? 1 : 2 } as Found];
    });
  }
  const modules = [
    ...Array.from(document.querySelectorAll<HTMLElement>('main > *')),
    ...Array.from(document.querySelectorAll<HTMLElement>('body footer')).slice(-1),
  ];
  return modules.map(node => {
    const heading = node.getAttribute('aria-label') || node.querySelector('h1, h2')?.textContent || '';
    return { node, name: node.tagName === 'FOOTER' ? '页脚' : shortName(heading), level: 1 };
  });
}

/** Text no one sees: a screen-reader-only copy, or the answer inside a closed <details>. */
function unseen(parent: Element): boolean {
  const details = parent.closest('details');
  if (details && !details.open && !parent.closest('summary')) return true;
  const box = parent.getBoundingClientRect();
  return box.width <= 1 && box.height <= 1;
}

/** Every visible line of the page's own text, in page coordinates: the labels keep clear of these. */
function textBoxes(skip: Element | null): Box[] {
  const boxes: Box[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !node.textContent?.trim() || skip?.contains(parent) || unseen(parent)) continue;
    range.selectNodeContents(node);
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width > 0) boxes.push({ left: rect.left + scrollX, top: rect.top + scrollY, width: rect.width, height: rect.height });
    }
  }
  return boxes;
}

let canvas: CanvasRenderingContext2D | null = null;
function labelSize(label: string, level: 1 | 2) {
  canvas ??= document.createElement('canvas').getContext('2d');
  const size = level === 1 ? 12 : 11;
  if (canvas) canvas.font = `600 ${size}px ${FONT}`;
  const text = canvas ? canvas.measureText(label).width : label.length * size;
  return { width: Math.ceil(text) + (level === 1 ? 19 : 15), height: level === 1 ? 23 : 20 };
}

/**
 * Measures the regions. A full pass (layout changed) also picks each label's spot clear of the text; a scroll pass
 * only moves the labels with their regions (sticky parts move while the page scrolls), keeping the spots.
 */
function measure(spots: Map<string, Spot>, full: boolean, skip: Element | null): Badge[] {
  const found = findRegions().filter(item => visible(item.node));
  const numbered = numberRegions(found);
  const taken = full ? textBoxes(skip) : [];
  if (full) spots.clear();
  return found.flatMap((item, index) => {
    const region = numbered[index];
    if (!region) return [];
    const rect = item.node.getBoundingClientRect();
    const box = { left: rect.left + scrollX, top: rect.top + scrollY, width: rect.width, height: rect.height };
    const key = `${region.number}:${region.label}`;
    let spot = spots.get(key);
    if (!spot) {
      const size = labelSize(region.label, region.level);
      spot = pickSpot(box, size, region.level, taken);
      spots.set(key, spot);
      taken.push({ left: box.left + spot.dx, top: box.top + spot.dy, ...size });
    }
    return [{ key: region.number, label: region.label, level: region.level, top: box.top + spot.dy, left: Math.max(2, box.left + spot.dx) }];
  });
}

/**
 * The region labels of the style samples, drawn over the page from outside it: the modules' own markup and layout are
 * untouched, and the labels never take a click. Mounted only by app/landing/preview/layout.tsx, so /landing never
 * loads this code. The labels follow the page as it scrolls, resizes or changes (a tab picked, a panel opened).
 */
export function RegionLabels() {
  const [badges, setBadges] = useState<Badge[]>([]);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const overlay = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHost(document.body);
    const spots = new Map<string, Spot>();
    let frame = 0;
    let full = true;
    let last = '';
    let timer = 0;
    const run = () => {
      frame = 0;
      const next = measure(spots, full, overlay.current);
      full = false;
      const key = JSON.stringify(next);
      if (key !== last) { last = key; setBadges(next); }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(run); };
    // Picking spots walks the page's text, so a change (typing demos change it all the time) does it at most every 300 ms.
    const relayout = () => {
      if (!timer) timer = window.setTimeout(() => { timer = 0; full = true; schedule(); }, 300);
    };
    // Text that slides in as it scrolls into view settles after the scroll: pick the spots again once it stops and
    // whenever an entrance animation ends.
    let still = 0;
    const onScroll = () => {
      schedule();
      window.clearTimeout(still);
      still = window.setTimeout(relayout, 500);
    };
    schedule();
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', relayout);
    window.addEventListener('transitionend', relayout, true);
    window.addEventListener('animationend', relayout, true);
    const resized = new ResizeObserver(relayout);
    resized.observe(document.body);
    const changed = new MutationObserver(records => {
      if (records.some(record => !overlay.current?.contains(record.target))) relayout();
    });
    changed.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'open'] });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      window.clearTimeout(still);
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', relayout);
      window.removeEventListener('transitionend', relayout, true);
      window.removeEventListener('animationend', relayout, true);
      resized.disconnect();
      changed.disconnect();
    };
  }, []);

  if (!host) return null;
  return createPortal(
    <div ref={overlay} className={styles.overlay} aria-hidden="true" data-region-labels="">
      {badges.map(badge => (
        <span key={badge.key} className={styles.badge} data-level={badge.level} style={{ top: badge.top, left: badge.left }}>
          {badge.label}
        </span>
      ))}
    </div>,
    host,
  );
}
