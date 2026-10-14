/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import type { JurySeatNames } from './jury-events';
import { mockCase } from './jury-case';
import type { JuryScenarioId } from './jury-scripts';
import { JuryCanvasPlayer } from './JuryCanvasPlayer';
import styles from './jury.module.css';

/**
 * Prototype only: the embeddable canvas as the landing page will use it, with the short-version switch and a slider
 * standing in for the page's scrolling.
 */
export function JuryEmbedDemo({ scenario, names }: { scenario: JuryScenarioId; names: JurySeatNames }) {
  const [brief, setBrief] = useState(true);
  const [driven, setDriven] = useState(true);
  const [progress, setProgress] = useState(0);
  const data = mockCase(scenario);
  return (
    <section className={styles.embed} aria-label="嵌入版预览">
      <div className={styles.embedControls}>
        <label><input type="checkbox" checked={brief} onChange={event => setBrief(event.target.checked)} />精简版</label>
        <label><input type="checkbox" checked={driven} onChange={event => setDriven(event.target.checked)} />按进度（代替页面滚动）</label>
        {driven ? (
          <input type="range" min={0} max={100} value={Math.round(progress * 100)} aria-label="进度"
            onChange={event => setProgress(Number(event.target.value) / 100)} />
        ) : null}
      </div>
      <div className={styles.embedStage}>
        <JuryCanvasPlayer key={`${scenario}-${brief}-${driven}`} data={data} brief={brief} names={names}
          progress={driven ? progress : undefined} speed={brief ? 1 : 3} />
      </div>
    </section>
  );
}
