/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './s5.module.css';

/** The film and its cover (local preview only, not in the repository: the Owner's AI-generated stills, rendered). */
const FILM = { webm: '/landing-s/s5-film.webm', mp4: '/landing-s/s5-film.mp4', cover: '/landing-s/s-1.webp' };
/** Set once the rendered film is in public/landing-s/; until then only the cover shows (no requests for missing files). */
const FILM_READY = false;
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * S5's first-screen film ("众生百态", made with OpenFilm outside the repository): a muted, looping video laid exactly
 * under the first screen's inset frame, which keeps the grade, grain, vignette and words above it. It plays only while
 * the first screen is on screen and the page is visible; with reduced motion only the cover shows. Until the film is
 * rendered, the cover stands in (the sources simply do not load).
 */
export function FilmS5() {
  const frame = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [still, setStill] = useState(false);
  useEffect(() => {
    const node = frame.current;
    const hero = document.querySelector<HTMLElement>('[data-region="首屏"]');
    if (!node || !hero) return;
    const place = () => {
      const rect = hero.getBoundingClientRect();
      const root = node.offsetParent?.getBoundingClientRect();
      if (!root) return;
      Object.assign(node.style, { top: `${rect.top - root.top}px`, left: `${rect.left - root.left}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    };
    place();
    const resize = new ResizeObserver(place);
    resize.observe(hero);
    window.addEventListener('resize', place);
    if (reducedMotion()) { setStill(true); return () => { resize.disconnect(); window.removeEventListener('resize', place); }; }
    let seen = true;
    const sync = () => {
      const player = video.current;
      if (!player) return;
      if (seen && document.visibilityState === 'visible') void player.play().catch(() => undefined);
      else player.pause();
    };
    const watch = new IntersectionObserver(([entry]) => { seen = Boolean(entry?.isIntersecting); sync(); });
    watch.observe(hero);
    document.addEventListener('visibilitychange', sync);
    return () => {
      resize.disconnect(); watch.disconnect();
      window.removeEventListener('resize', place); document.removeEventListener('visibilitychange', sync);
    };
  }, []);
  return (
    <div ref={frame} className={styles.film}>
      {still || !FILM_READY ? <img src={FILM.cover} alt="" /> : (
        <video ref={video} muted loop playsInline autoPlay preload="auto" poster={FILM.cover}>
          <source src={FILM.webm} type="video/webm" />
          <source src={FILM.mp4} type="video/mp4" />
        </video>
      )}
    </div>
  );
}
