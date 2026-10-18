/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LandingFlags } from '@/lib/landing/landing-flags';
import { OpsStepContext, type SceneM } from './stage-context-m';
import { StageM } from './StageM';

const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * Sample M's page root (direction H, 产品主导). No backdrop: a white page with faint grey bands. It tracks which
 * region crosses the middle of the screen (`data-scene` on the region's wrapper) and hands that scene to the fixed
 * product window, and shares the week's current step between region 3 and that window. Like sample J's MotionJ, once
 * mounted and when motion is welcome it marks each `data-row` as it scrolls in (the voice wall's notes and the
 * comparison's typing play from that); without JavaScript or with reduced motion nothing is hidden.
 */
export function RootM({ className, flags, children }: { className?: string; flags: LandingFlags; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<SceneM>('ask');
  const [step, setStep] = useState(0);
  const ops = useMemo(() => ({ step, setStep }), [step]);

  useEffect(() => {
    const root = ref.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      const hit = entries.find(entry => entry.isIntersecting);
      const next = (hit?.target as HTMLElement | undefined)?.dataset.scene as SceneM | undefined;
      if (next) setScene(next);
    }, { rootMargin: '-50% 0px -50% 0px' });
    root.querySelectorAll<HTMLElement>('[data-scene]').forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const root = ref.current;
    if (!root || reducedMotion() || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      // Rows that come into view together still play one after another, top to bottom.
      entries.filter(entry => entry.isIntersecting).forEach((entry, order) => {
        const node = entry.target as HTMLElement;
        node.style.setProperty('--stagger', `${order * 220}ms`);
        node.dataset.in = '';
        observer.unobserve(node);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.15 });
    root.querySelectorAll<HTMLElement>('[data-row]').forEach(node => observer.observe(node));
    root.dataset.motion = 'on';
    return () => { observer.disconnect(); delete root.dataset.motion; };
  }, []);

  return (
    <OpsStepContext.Provider value={ops}>
      <div ref={ref} className={className}>
        {children}
        <StageM scene={scene} flags={flags} />
      </div>
    </OpsStepContext.Provider>
  );
}
