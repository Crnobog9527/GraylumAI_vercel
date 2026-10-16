/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FastForward } from 'lucide-react';
import type { JuryCaseReport } from '@/components/landing/preview-jury/jury-case';
import type { JuryDetail, JuryEvent, JurySeatNames, SeatCode } from '@/components/landing/preview-jury/jury-events';
import { buildScenes, playbackLength, sceneAt, skippedStages } from '@/components/landing/preview-jury/jury-scenes';
import { arrivedAt, speakerOf } from '@/components/landing/preview-jury/jury-progress';
import { canvasAt } from '@/components/landing/preview-jury/jury-canvas';
import { remainingMs, remainingText, totalText } from '@/components/landing/preview-jury/jury-eta';
import { JuryCanvas } from '@/components/landing/preview-jury/JuryCanvas';
import { JuryIntro } from '@/components/landing/preview-jury/JuryIntro';
import { JuryRecords } from '@/components/landing/preview-jury/JuryRecords';
import { JuryStepsRail } from '@/components/landing/preview-jury/JuryStepsRail';
import { useJuryPlayback, usePrefersReducedMotion } from '@/components/landing/preview-jury/use-jury-playback';
import { useRestoredStep } from '@/components/landing/preview-jury/use-review-address';
import layout from '@/components/landing/preview-jury/jury-layout.module.css';
import { appendArrival } from './review-adapter';
import styles from './review-page.module.css';

/**
 * The review while it runs: the steps on the left, the canvas in the middle, each person's record on the right, as in
 * the prototype; but it plays only what the server has returned. Each poll's new events arrive at the playback time
 * they came in, so a waiting scene holds the stage until real answers arrive. A refresh comes back to the same step.
 * Once the review has ended and the replay has caught up, `result` takes the stage.
 */
export function ReviewLive({ reviewId, events, detail, names, report, ended, frame, onLeave, result }: {
  reviewId: string; events: readonly JuryEvent[]; detail: JuryDetail; names: JurySeatNames; report: JuryCaseReport;
  /** The review has ended (nothing more will run). */
  ended: boolean;
  /** The page around the stage: extra toolbar controls, then the body. */
  frame: (extra: ReactNode, body: ReactNode) => ReactNode;
  onLeave: () => void;
  result: ReactNode;
}) {
  const reduced = usePrefersReducedMotion();
  const clockNow = useRef(0);
  const [arrivals, setArrivals] = useState(() => appendArrival([], events, 0));
  const scenes = useMemo(() => buildScenes(arrivals), [arrivals]);
  const length = playbackLength(scenes);
  const playback = useJuryPlayback(length, !reduced);
  // Reduced motion: no replay, everything received is shown at once.
  const clock = reduced ? length : playback.clock;
  // The playback time new events arrive at; kept current before the events effect reads it.
  useEffect(() => { clockNow.current = clock; }, [clock]);
  useEffect(() => { setArrivals(list => appendArrival(list, events, clockNow.current)); }, [events]);
  const caughtUp = reduced || playback.finished;
  const [intro, setIntro] = useState<'shown' | 'stay'>('shown');
  const [picked, setPicked] = useState<SeatCode | null>(null);
  const scene = sceneAt(scenes, clock);
  const seek = playback.seek;
  useRestoredStep(reviewId, ended && caughtUp ? 'end' : scene?.stage ?? 'start', clock, saved => { seek(saved); setIntro('stay'); });

  if (ended && caughtUp) return frame(null, <main className={styles.main}>{result}</main>);

  const skipped = skippedStages(scenes);
  const left = remainingText(remainingMs(scenes, clock));
  const skip = ended ? (
    <button type="button" className={styles.toolButton} onClick={playback.skipToEnd}>
      <FastForward size={15} aria-hidden="true" />评审已完成，直接看结果
    </button>
  ) : null;
  return frame(skip, (
      <main className={styles.main}>
        <div className={layout.live}>
          <JuryStepsRail stage={scene?.stage ?? null} skipped={skipped} ended={false} left={left} />
          <div className={layout.stage}>
            <JuryCanvas view={canvasAt(scenes, clock, names)} names={names} report={report} selected={picked}
              onPeek={() => {}} onPick={setPicked} />
            {intro === 'shown' && !ended ? (
              <JuryIntro total={totalText(scenes)} background onStay={() => setIntro('stay')} onLeave={onLeave} />
            ) : null}
          </div>
          <JuryRecords detail={detail} names={names} arrived={arrivedAt(arrivals, ended ? Infinity : clock)} live={!ended}
            following={speakerOf(scene) ?? 'A'} picked={picked} onPick={setPicked} onFollow={() => setPicked(null)} />
        </div>
      </main>
  ));
}
