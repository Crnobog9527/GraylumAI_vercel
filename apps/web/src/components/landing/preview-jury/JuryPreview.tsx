/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Pause, Play, RotateCcw } from 'lucide-react';
import light from '@/components/design/light-tokens.module.css';
import { cn } from '@/lib/utils';
import { resolveSeatNames, SAMPLE_PANEL, type JurySeatNames } from './jury-events';
import { findScenario, JURY_SCENARIOS, type JuryScenario, type JuryScenarioId } from './jury-scripts';
import { deriveView, formatElapsed, playbackLength, scheduleReveals } from './jury-timeline';
import { Outcome, RecordFeed, StaticReplay } from './JuryRecord';
import { Bench, DecisionBoard, Podium, StageRail } from './JuryStage';
import { useJuryPlayback, usePrefersReducedMotion } from './use-jury-playback';
import styles from './jury.module.css';

const SPEEDS = [1, 3] as const;

/**
 * FUSION-REVIEW prototype: how the jury's work could look while a real review runs (2–4 minutes). It replays mock
 * events of the §2.2a contract at their simulated arrival times; nothing is shown before it has "arrived", and
 * the only numbers are the clock and counts of what was shown. Not linked anywhere and never indexed.
 */
export function JuryPreview() {
  const [scenarioId, setScenarioId] = useState<JuryScenarioId>('full');
  const [sampleNames, setSampleNames] = useState(false);
  const scenario = findScenario(scenarioId);
  const names = resolveSeatNames(sampleNames ? SAMPLE_PANEL : undefined);

  return (
    <div className={cn(light.light, styles.page)}>
      <nav aria-label="原型说明" className={styles.sampleBar}>
        <span>不公开的评审团动画原型：模拟数据，按真实评审的事件顺序和等待时长播放</span>
        <Link href="/landing/preview/g">样稿 G</Link>
      </nav>

      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>评审团正在审阅你的定位报告</h1>
          <p className={styles.subtitle}>
            三位评审先各自独立判断，再互相挑刺；意见不一的地方辩论一轮，最后由{names.S}逐条裁决、写出修订稿。
          </p>
        </div>
        <div className={styles.controls}>
          <div role="radiogroup" aria-label="选择评审结局" className={styles.scenarios}>
            {JURY_SCENARIOS.map(item => (
              <button key={item.id} type="button" role="radio" aria-checked={item.id === scenarioId} title={item.hint}
                onClick={() => setScenarioId(item.id)}>{item.label}</button>
            ))}
          </div>
          <label className={styles.switch}>
            <input type="checkbox" role="switch" checked={sampleNames} onChange={event => setSampleNames(event.target.checked)} />
            <span aria-hidden="true" />
            示例名字（管理员可改）
          </label>
        </div>
      </header>

      <Player key={scenario.id} scenario={scenario} names={names} />
    </div>
  );
}

function Player({ scenario, names }: { scenario: JuryScenario; names: JurySeatNames }) {
  const reduced = usePrefersReducedMotion();
  const timed = useMemo(() => scheduleReveals(scenario.arrivals), [scenario]);
  const length = playbackLength(timed);
  const playback = useJuryPlayback(length, !reduced);
  const view = deriveView(timed, reduced ? length : playback.clock);

  if (reduced) {
    return <main className={styles.main}><StaticReplay timed={timed} view={view} names={names} /></main>;
  }

  return (
    <main className={styles.main}>
      <div className={styles.transport}>
        <p className={styles.hint}>{scenario.hint}</p>
        <div className={styles.transportActions}>
          <span className={styles.elapsed} aria-label="评审已进行">已进行 {formatElapsed(playback.clock)}</span>
          <button type="button" onClick={playback.toggle} aria-label={playback.playing ? '暂停' : '继续播放'}>
            {playback.playing ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
            {playback.playing ? '暂停' : playback.finished ? '再看一遍' : '继续'}
          </button>
          <button type="button" onClick={playback.restart}><RotateCcw size={15} aria-hidden="true" />从头播放</button>
          <div role="radiogroup" aria-label="播放速度" className={styles.speeds}>
            {SPEEDS.map(speed => (
              <button key={speed} type="button" role="radio" aria-checked={playback.speed === speed} onClick={() => playback.setSpeed(speed)}>
                {speed}×
              </button>
            ))}
          </div>
        </div>
      </div>

      <StageRail view={view} />

      <div className={styles.layout}>
        <div className={styles.floor}>
          <Bench view={view} names={names} now={playback.clock} />
          <Podium view={view} names={names} />
          <Outcome view={view} names={names} />
        </div>
        <aside className={styles.side} aria-label="评审进展">
          <DecisionBoard view={view} names={names} />
          <RecordFeed view={view} names={names} />
        </aside>
      </div>
    </main>
  );
}
