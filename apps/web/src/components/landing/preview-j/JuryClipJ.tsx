/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useMemo } from 'react';
import { JuryDesk } from '@/components/landing/preview-jury/JuryDesk';
import { deskAt } from '@/components/landing/preview-jury/jury-desk';
import { resolveSeatNames } from '@/components/landing/preview-jury/jury-events';
import { failedSeatsAt } from '@/components/landing/preview-jury/jury-progress';
import { buildScenes, playbackLength, sceneAt } from '@/components/landing/preview-jury/jury-scenes';
import { findScenario } from '@/components/landing/preview-jury/jury-scripts';
import styles from './takeover-j.module.css';

const noop = () => undefined;

/**
 * The review panel at work on a finished report, compressed: the jury prototype's own desk (#995's wide visual) and
 * its full scenario, but its clock is the scroll — the whole review passes in one short stretch of scrolling.
 * Nothing here can be clicked (the takeover marks the picture inert). `progress` is 0 → 1.
 */
export function JuryClipJ({ progress }: { progress: number }) {
  const scenario = findScenario('full');
  const scenes = useMemo(() => buildScenes(scenario.arrivals), [scenario]);
  const names = resolveSeatNames(undefined);
  // Stop just short of the end: the last scene is the revision on the page, not the result view.
  const clock = Math.min(1, Math.max(0, progress)) * playbackLength(scenes) * 0.985;
  return (
    <div className={styles.jury}>
      <JuryDesk scene={sceneAt(scenes, clock)} view={deskAt(scenes, clock)} names={names} clock={clock}
        failed={failedSeatsAt(scenes, clock)} selected={null} onPeek={noop} onPick={noop} />
    </div>
  );
}
