/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { FastForward, Pause, Play, RotateCcw } from 'lucide-react';
import light from '@/components/design/light-tokens.module.css';
import { cn } from '@/lib/utils';
import { resolveSeatNames, SAMPLE_PANEL, type JurySeatNames, type SeatCode } from './jury-events';
import { posesAt } from './jury-poses';
import { buildScenes, formatElapsed, playbackLength, sceneAt, skippedStages } from './jury-scenes';
import { findScenario, JURY_SCENARIOS, type JuryScenario, type JuryScenarioId } from './jury-scripts';
import { arrivedAt, failedSeatsAt, speakerOf } from './jury-progress';
import { JuryBoard } from './JuryBoard';
import { JuryDossier } from './JuryDossier';
import { JuryRail } from './JuryRail';
import { JuryResults } from './JuryResults';
import { JuryRoom } from './JuryRoom';
import { JuryStatic } from './JuryStatic';
import { useJuryPlayback, usePrefersReducedMotion } from './use-jury-playback';
import styles from './jury.module.css';

const SPEEDS = [1, 3] as const;

/**
 * FUSION-REVIEW prototype v2: the review as a small jury room. One stage at a time, each person with their own
 * record, and a result page where the user picks the revision or the original chapter by chapter. Mock data in the
 * shapes of FUSION-REVIEW.md §2.2a (events, detail, adopt). Not linked anywhere and never indexed.
 */
export function JuryPreview() {
  const [scenarioId, setScenarioId] = useState<JuryScenarioId>('full');
  const [sampleNames, setSampleNames] = useState(false);
  const scenario = findScenario(scenarioId);
  const names = resolveSeatNames(sampleNames ? SAMPLE_PANEL : undefined);

  return (
    <div className={cn(light.light, styles.page)}>
      <nav aria-label="原型说明" className={styles.sampleBar}>
        <span>不公开的评审团动画原型（第 2 版）：模拟数据，按真实评审的事件顺序和等待时长播放</span>
        <Link href="/landing/preview/g">样稿 G</Link>
      </nav>

      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>评审团正在审阅你的定位报告</h1>
          <p className={styles.subtitle}>
            三位评审各自独立判断，再互相挑刺；意见不一的地方辩论一轮，最后由{names.S}逐条裁决、写出修订稿，由你逐章决定用不用。
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
  const scenes = useMemo(() => buildScenes(scenario.arrivals), [scenario]);
  const length = playbackLength(scenes);
  const playback = useJuryPlayback(length, !reduced);
  const [peek, setPeek] = useState<SeatCode | null>(null);
  const [pinned, setPinned] = useState<SeatCode | null>(null);
  const dossierRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const skipped = skippedStages(scenes);

  const openRecord = useCallback((seat: SeatCode) => {
    setPinned(seat);
    setPeek(null);
    const target = dossierRef.current;
    if (target && window.matchMedia('(max-width: 1023px)').matches) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  if (reduced) {
    const openStatic = (seat: SeatCode) => document.getElementById(`record-${seat}`)?.scrollIntoView({ block: 'start' });
    return (
      <main className={styles.main}>
        <JuryStatic scenes={scenes} detail={scenario.detail} names={names} skipped={skipped} onOpenRecord={openStatic} />
      </main>
    );
  }

  const clock = playback.clock;
  const ended = playback.finished;
  const scene = sceneAt(scenes, clock);
  const poses = posesAt(scene, clock, failedSeatsAt(scenes, clock));
  // Pointing only counts while the room is on screen: once it is gone no leave event may come to clear it.
  const seat = (ended ? null : peek) ?? pinned ?? speakerOf(scene) ?? 'A';
  const arrived = arrivedAt(scenario.arrivals, ended ? Infinity : clock);

  return (
    <main className={styles.main}>
      <div className={styles.transport}>
        <p className={styles.hint}>{scenario.hint}</p>
        <div className={styles.transportActions}>
          <span className={styles.elapsed} aria-label="评审已进行">已进行 {formatElapsed(clock)}</span>
          <button type="button" onClick={playback.toggle} aria-label={playback.playing ? '暂停' : '继续播放'}>
            {playback.playing ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
            {playback.playing ? '暂停' : ended ? '再看一遍' : '继续'}
          </button>
          <button type="button" onClick={playback.restart}><RotateCcw size={15} aria-hidden="true" />从头播放</button>
          {ended ? null : (
            <button type="button" onClick={playback.skipToEnd}><FastForward size={15} aria-hidden="true" />跳到结果（原型）</button>
          )}
          <div role="radiogroup" aria-label="播放速度" className={styles.speeds}>
            {SPEEDS.map(speed => (
              <button key={speed} type="button" role="radio" aria-checked={playback.speed === speed} onClick={() => playback.setSpeed(speed)}>
                {speed}×
              </button>
            ))}
          </div>
        </div>
      </div>

      <JuryRail stage={scene?.stage ?? null} skipped={skipped} ended={ended}
        onJump={key => playback.seek(scenes.find(item => item.stage === key)?.start ?? 0)} />

      <div className={styles.layout}>
        <div className={styles.floor} ref={stageRef}>
          {ended ? (
            <JuryResults detail={scenario.detail} names={names} onOpenRecord={openRecord} />
          ) : (
            <div className={styles.stage}>
              <JuryRoom names={names} poses={poses} selected={peek ?? pinned} entering={scene?.kind === 'seated'}
                onPeek={setPeek} onPick={code => (pinned === code ? setPinned(null) : openRecord(code))} />
              {scene ? <JuryBoard scene={scene} names={names} clock={clock} /> : null}
            </div>
          )}
        </div>
        <aside className={styles.side} ref={dossierRef} aria-label="评审记录">
          <p className={styles.sideHint}>
            指向（手机上点一下）评审室里的人，看这位的完整记录
            <button type="button" className={styles.backToRoom} onClick={() => stageRef.current?.scrollIntoView({ behavior: 'smooth' })}>
              回到评审室
            </button>
          </p>
          <JuryDossier detail={scenario.detail} names={names} seat={seat} arrived={arrived} live={!ended}
            onSelect={openRecord} />
        </aside>
      </div>
    </main>
  );
}
