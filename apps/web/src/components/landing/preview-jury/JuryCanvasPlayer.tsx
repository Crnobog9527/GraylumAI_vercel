/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useMemo } from 'react';
import { DEFAULT_SEAT_NAMES, type JurySeatNames, type SeatCode } from './jury-events';
import { briefScenes } from './jury-brief';
import { canvasAt } from './jury-canvas';
import { buildScenes, playbackLength } from './jury-scenes';
import { findScenario, type JuryScenarioId } from './jury-scripts';
import { JuryCanvas } from './JuryCanvas';
import { useJuryPlayback, usePrefersReducedMotion } from './use-jury-playback';

/**
 * The canvas on its own, for embedding (the landing page): plays a mock review once with no toolbar, records or
 * result page. `speed` (read once, at mount) multiplies playback, 1 being reading pace; `brief` keeps every stage but
 * drops the minor steps (see briefScenes). With reduced motion it shows the last frame. `onPick` is called when a
 * person or card is clicked. On a computer the canvas fills its parent's height, so give the parent one.
 */
export function JuryCanvasPlayer({ scenario = 'full', speed = 1, brief = false, names = DEFAULT_SEAT_NAMES, onPick }: {
  scenario?: JuryScenarioId; speed?: number; brief?: boolean; names?: JurySeatNames; onPick?: (seat: SeatCode) => void;
}) {
  const reduced = usePrefersReducedMotion();
  const scenes = useMemo(() => {
    const full = buildScenes(findScenario(scenario).arrivals);
    return brief ? briefScenes(full) : full;
  }, [scenario, brief]);
  const length = playbackLength(scenes);
  const playback = useJuryPlayback(length, !reduced, speed);
  const clock = reduced ? length - 1 : Math.min(playback.clock, length - 1);
  return (
    <JuryCanvas view={canvasAt(scenes, clock, names)} names={names} selected={null}
      onPeek={() => {}} onPick={seat => onPick?.(seat)} />
  );
}
