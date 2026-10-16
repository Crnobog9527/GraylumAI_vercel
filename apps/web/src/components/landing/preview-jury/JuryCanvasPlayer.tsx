/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useMemo, useState } from 'react';
import { DEFAULT_SEAT_NAMES, type JurySeatNames, type SeatCode } from './jury-events';
import { briefScenes } from './jury-brief';
import { canvasAt } from './jury-canvas';
import { mockCase, type JuryCase } from './jury-case';
import { buildScenes, playbackLength, type Scene } from './jury-scenes';
import { JuryCanvas } from './JuryCanvas';
import { useJuryPlayback, usePrefersReducedMotion } from './use-jury-playback';
import theme from './jury-theme.module.css';

export type JuryCanvasPlayerProps = {
  /** The case to play (reports and events, see jury-case.ts); the prototype's mock creator by default. Keep it stable
   * (a module constant or useMemo): the playback plan is rebuilt when it changes. */
  data?: JuryCase;
  /** 0→1: freeze the canvas at that point of the review, e.g. driven by the page's scrolling. Unset: it plays by itself. */
  progress?: number;
  /** Playback speed when it plays by itself; read once, when mounted. 1 is reading pace. */
  speed?: number;
  /** Short version: only the key moments (seated, reading, disagreement, summary, new report). */
  brief?: boolean;
  names?: JurySeatNames;
  /** A person or card was clicked. Without it the people and cards are not clickable. */
  onPick?: (seat: SeatCode) => void;
};

/**
 * The canvas on its own, for embedding (the landing page): no toolbar, records or result page. It either plays by
 * itself once, or follows `progress`. With reduced motion and no `progress` it shows the last frame. On a computer
 * the canvas fills its parent's height, so give the parent one.
 */
export function JuryCanvasPlayer({ data, brief = false, ...rest }: JuryCanvasPlayerProps) {
  const juryCase = data ?? DEFAULT_CASE;
  const scenes = useMemo(() => {
    const full = buildScenes(juryCase.arrivals);
    return brief ? briefScenes(full) : full;
  }, [juryCase.arrivals, brief]);
  // A new plan (another case, or the short version switched) starts again from the beginning.
  const [plan, setPlan] = useState({ scenes, id: 0 });
  if (plan.scenes !== scenes) setPlan({ scenes, id: plan.id + 1 });
  return <Playing key={plan.id} scenes={scenes} report={juryCase.report} brief={brief} {...rest} />;
}

const DEFAULT_CASE = mockCase('full');

function Playing({ scenes, report, brief, progress, speed = 1, names = DEFAULT_SEAT_NAMES, onPick }: Omit<JuryCanvasPlayerProps, 'data'> & {
  scenes: Scene[]; report: JuryCase['report'];
}) {
  const reduced = usePrefersReducedMotion();
  const length = playbackLength(scenes);
  const driven = progress !== undefined;
  const playback = useJuryPlayback(length, !reduced && !driven, speed);
  const last = Math.max(0, length - 1);
  const clock = driven ? Math.min(1, Math.max(0, progress)) * last : reduced ? last : Math.min(playback.clock, last);
  return (
    <div className={theme.player}>
      <JuryCanvas view={canvasAt(scenes, clock, names)} names={names} selected={null} report={report} follow={!driven} captionAbove={brief}
        onPeek={() => {}} onPick={onPick} />
    </div>
  );
}
