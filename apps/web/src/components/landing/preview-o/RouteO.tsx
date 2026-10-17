/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import styles from './o.module.css';

type Point = { x: number; y: number };
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
/** Where on the screen the route's pen sits while scrolling: a little below the middle. */
const PEN = 0.62;
/** Between two stations farther apart than this, the route bends once into the rail (desktop only). */
const BEND_AFTER = 260;

/** One smooth leg from a to b, leaving and arriving straight down. */
const leg = (a: Point, b: Point) => {
  const half = (b.y - a.y) / 2;
  return ` C${a.x} ${a.y + half} ${b.x} ${b.y - half} ${b.x} ${b.y}`;
};

/** The route through every station, top to bottom; long legs bow out by `sway` so it reads as a drawn way, not a ruler. */
export function routePath(points: readonly Point[], sway: number): string {
  if (points.length < 2) return '';
  let d = `M${points[0].x} ${points[0].y}`;
  points.slice(1).forEach((point, index) => {
    const from = points[index];
    if (sway && point.y - from.y > BEND_AFTER) {
      const bend = { x: Math.max(from.x, point.x) + sway, y: (from.y + point.y) / 2 };
      d += leg(from, bend) + leg(bend, point);
    } else d += leg(from, point);
  });
  return d;
}

/**
 * Sample O's page track (direction C, "路线图", Owner 2026-10-17): the faint dot grid of the content column, and one
 * route from station 0 on the first screen to station 10 at the close, drawn along the rail as the page scrolls (its
 * dash offset follows the scroll; each station's number appears as the pen reaches it). It also does what sample L's
 * MotionJ did for the rows (`data-row` → `data-in`: the comparison's typing, the voice cards), without its backdrop.
 * Server HTML and reduced motion: the whole route stands finished and every station shows.
 */
export function RouteO({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const drawn = useRef<SVGPathElement>(null);
  const [route, setRoute] = useState({ d: '', width: 0, height: 0 });
  const [moving, setMoving] = useState(false);

  // Rows that come into view play once, one after another (sample J's MotionJ, minus the backdrop).
  useEffect(() => {
    const root = ref.current;
    if (!root || reducedMotion() || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      entries.filter(entry => entry.isIntersecting).forEach((entry, order) => {
        const node = entry.target as HTMLElement;
        node.style.setProperty('--stagger', `${order * 160}ms`);
        node.dataset.in = '';
        observer.unobserve(node);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.15 });
    root.querySelectorAll<HTMLElement>('[data-row]').forEach(node => observer.observe(node));
    root.dataset.motion = 'on';
    return () => { observer.disconnect(); delete root.dataset.motion; };
  }, []);

  // The route: measured from the stations, rebuilt whenever the page's height or width changes.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const build = () => {
      const box = root.getBoundingClientRect();
      const points = Array.from(root.querySelectorAll<HTMLElement>('[data-station]'))
        .filter(node => node.getClientRects().length > 0)
        .map(node => {
          const rect = node.getBoundingClientRect();
          return { x: rect.left + rect.width / 2 - box.left, y: rect.top + rect.height / 2 - box.top };
        });
      const sway = window.innerWidth >= 1024 ? 22 : 0;
      setRoute({ d: routePath(points, sway), width: Math.round(box.width), height: Math.round(box.height) });
    };
    build();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(build);
    observer?.observe(root);
    window.addEventListener('resize', build);
    return () => { observer?.disconnect(); window.removeEventListener('resize', build); };
  }, []);

  // The pen: how much of the route is drawn follows the scroll; stations light up as it passes them.
  useEffect(() => {
    const root = ref.current;
    const path = drawn.current;
    if (!root || !path || !route.d || reducedMotion()) return;
    setMoving(true);
    const total = path.getTotalLength();
    const samples: Point[] = [];
    for (let at = 0; at <= total; at += 6) samples.push({ x: at, y: path.getPointAtLength(at).y });
    samples.push({ x: total, y: path.getPointAtLength(total).y });
    const box = root.getBoundingClientRect();
    const stations = Array.from(root.querySelectorAll<HTMLElement>('[data-station]')).map(node => {
      const rect = node.getBoundingClientRect();
      return { node, y: rect.top + rect.height / 2 - box.top };
    });
    path.style.strokeDasharray = `${total}`;
    let frame = 0;
    const update = () => {
      frame = 0;
      const pen = window.innerHeight * PEN - root.getBoundingClientRect().top;
      // The last sample above the pen (the route only ever runs downwards).
      let low = 0;
      let high = samples.length - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (samples[mid].y <= pen) low = mid; else high = mid - 1;
      }
      const length = samples[0].y > pen ? 0 : samples[low].x;
      path.style.strokeDashoffset = `${total - length}`;
      for (const station of stations) station.node.toggleAttribute('data-reached', pen >= station.y - 2);
    };
    const onScroll = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); if (frame) window.cancelAnimationFrame(frame); };
  }, [route]);

  return (
    <div ref={ref} className={styles.track} data-route={moving ? 'on' : undefined}>
      <div className={styles.dots} aria-hidden="true" />
      {route.d ? (
        <svg className={styles.route} width={route.width} height={route.height} viewBox={`0 0 ${route.width} ${route.height}`} aria-hidden="true">
          <path className={styles.routeAhead} d={route.d} />
          <path ref={drawn} className={styles.routeDrawn} d={route.d} />
        </svg>
      ) : null}
      {children}
    </div>
  );
}

/**
 * A station on the route: a round mark in the rail with its number (monospace), and, for the named ones, a short line
 * above the heading ("你现在在这", "别人走到了这", "从这里出发"). The mark sits in the rail whatever the column holds.
 */
export function StationO({ n, label }: { n: string; label?: string }) {
  return (
    <>
      <span className={styles.station} data-station={n} aria-hidden="true"><b>{n}</b></span>
      {label ? <p className={styles.stationLabel}>{label}</p> : null}
    </>
  );
}
