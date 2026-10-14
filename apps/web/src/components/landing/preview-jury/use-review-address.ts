/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';
import { JURY_SCENARIOS, type JuryScenarioId } from './jury-scripts';

/**
 * Prototype stand-in for the review's own address (the product will have /positioning/<draftId>/review/<reviewId>):
 * the page keeps ?review=<id> in the address, and a refresh comes back to the same review at the same step. The
 * step is kept in this tab's session storage; when storage is unavailable the review simply starts again.
 */
export function useReviewAddress(fallback: JuryScenarioId) {
  const [scenarioId, setScenarioId] = useState<JuryScenarioId>(fallback);
  const [resolved, setResolved] = useState(false);
  useEffect(() => {
    const review = new URLSearchParams(window.location.search).get('review');
    const found = JURY_SCENARIOS.find(item => item.detail.reviewId === review);
    // Reading the address once on arrival; the server render cannot see it.
    if (found) setScenarioId(found.id);
    setResolved(true);
  }, []);
  useEffect(() => {
    if (!resolved) return;
    const reviewId = JURY_SCENARIOS.find(item => item.id === scenarioId)?.detail.reviewId;
    const url = new URL(window.location.href);
    if (reviewId && url.searchParams.get('review') !== reviewId) {
      url.searchParams.set('review', reviewId);
      window.history.replaceState(window.history.state, '', url);
    }
  }, [resolved, scenarioId]);
  return { scenarioId, setScenarioId, resolved };
}

const key = (reviewId: string) => `graylum.jury.clock.${reviewId}`;

function readClock(reviewId: string): number {
  try {
    const value = Number(window.sessionStorage.getItem(key(reviewId)));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeClock(reviewId: string, clock: number) {
  try {
    window.sessionStorage.setItem(key(reviewId), String(Math.round(clock)));
  } catch {
    // Storage blocked: a refresh starts the replay again, nothing else breaks.
  }
}

/**
 * Brings the replay back to where this review was before a refresh, and remembers the clock each time the step
 * changes. `onRestore` gets the saved clock once, when there is one.
 */
export function useRestoredStep(reviewId: string, step: string, clock: number, onRestore: (clock: number) => void) {
  const first = useRef(true);
  useEffect(() => {
    const saved = readClock(reviewId);
    if (saved > 0) onRestore(saved);
    // Only on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewId]);
  useEffect(() => {
    // Skip the first run: it would store the clock from before the restore.
    if (first.current) { first.current = false; return; }
    writeClock(reviewId, clock);
    // The step, not every tick, decides when to write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewId, step]);
}
