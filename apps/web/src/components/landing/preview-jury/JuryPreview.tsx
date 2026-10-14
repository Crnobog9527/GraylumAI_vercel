/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { FastForward, Pause, Play, RotateCcw, X } from 'lucide-react';
import light from '@/components/design/light-tokens.module.css';
import { cn } from '@/lib/utils';
import { resolveSeatNames, SAMPLE_PANEL, type JurySeatNames, type SeatCode } from './jury-events';
import { buildScenes, formatElapsed, playbackLength, sceneAt, skippedStages } from './jury-scenes';
import { findScenario, JURY_SCENARIOS, type JuryScenario, type JuryScenarioId } from './jury-scripts';
import { arrivedAt, failedSeatsAt, speakerOf } from './jury-progress';
import { deskAt } from './jury-desk';
import { JuryDesk } from './JuryDesk';
import { JuryDossier } from './JuryDossier';
import { JuryRail } from './JuryRail';
import { JuryResults } from './JuryResults';
import { JuryStatic } from './JuryStatic';
import { useJuryPlayback, usePrefersReducedMotion } from './use-jury-playback';
import { useRecordDrawer } from './use-record-drawer';
import styles from './jury.module.css';

const SPEEDS = [1, 3] as const;
/** Below this width the records sit under the stage instead of sliding out over it. */
const STACKED = '(max-width: 1023px)';

/**
 * FUSION-REVIEW prototype v3: the review as annotations on the user's report. One stage at a time, each person with
 * their own record, and a result page where the user picks the revision or the original chapter by chapter. Mock data in the
 * shapes of FUSION-REVIEW.md §2.2a (events, detail, adopt). Not linked anywhere and never indexed.
 */
export function JuryPreview() {
  const [scenarioId, setScenarioId] = useState<JuryScenarioId>('full');
  const [sampleNames, setSampleNames] = useState(false);
  const scenario = findScenario(scenarioId);
  const names = resolveSeatNames(sampleNames ? SAMPLE_PANEL : undefined);

  const settings = (
    <>
      <h1 className={styles.title}>评审团正在审阅你的定位报告</h1>
      <div role="radiogroup" aria-label="选择评审结局" className={styles.scenarios}>
        {JURY_SCENARIOS.map(item => (
          <button key={item.id} type="button" role="radio" aria-checked={item.id === scenarioId} title={item.hint}
            onClick={() => setScenarioId(item.id)}>{item.label}</button>
        ))}
      </div>
      <label className={styles.switch} title="管理员可改">
        <input type="checkbox" role="switch" checked={sampleNames} onChange={event => setSampleNames(event.target.checked)} />
        <span aria-hidden="true" />
        示例名字
      </label>
    </>
  );

  return (
    <div className={cn(light.light, styles.page)}>
      <Player key={scenario.id} scenario={scenario} names={names} settings={settings} />
      <footer className={styles.sampleBar}>
        <p>
          三位评审各自读完、在页边批注；意见不一的地方辩论一轮，再由{names.S}逐条裁决、写出修订稿。用不用修订稿，由你逐章决定。
        </p>
        <p>
          不公开的评审团动画原型（第 3 版）：模拟数据，按真实评审的事件顺序和等待时长播放。
          <Link href="/landing/preview/g">样稿 G</Link>
        </p>
      </footer>
    </div>
  );
}

/** One toolbar for everything: the stage below it fills the rest of the window, so its height is published as --j-bar. */
function Toolbar({ children, rail }: { children: ReactNode; rail?: ReactNode }) {
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = bar.current;
    const page = node?.parentElement;
    if (!node || !page) return;
    const publish = () => page.style.setProperty('--j-bar', `${Math.ceil(node.getBoundingClientRect().height)}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div className={styles.toolbar} ref={bar}>
      <div className={styles.toolRow}>{children}</div>
      {rail}
    </div>
  );
}

function Player({ scenario, names, settings }: { scenario: JuryScenario; names: JurySeatNames; settings: ReactNode }) {
  const reduced = usePrefersReducedMotion();
  const scenes = useMemo(() => buildScenes(scenario.arrivals), [scenario]);
  const length = playbackLength(scenes);
  const playback = useJuryPlayback(length, !reduced);
  const drawer = useRecordDrawer();
  const { peek, pinned, pin } = drawer;
  const dossierRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const skipped = skippedStages(scenes);

  const openRecord = useCallback((seat: SeatCode) => {
    pin(seat);
    const target = dossierRef.current;
    if (target && window.matchMedia(STACKED).matches) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [pin]);

  if (reduced) {
    const openStatic = (seat: SeatCode) => document.getElementById(`record-${seat}`)?.scrollIntoView({ block: 'start' });
    return (
      <>
        <Toolbar>{settings}</Toolbar>
        <main className={styles.main}>
          <JuryStatic scenes={scenes} detail={scenario.detail} names={names} skipped={skipped} onOpenRecord={openStatic} />
        </main>
      </>
    );
  }

  const clock = playback.clock;
  const ended = playback.finished;
  const scene = sceneAt(scenes, clock);
  const failed = failedSeatsAt(scenes, clock);
  // Pointing only counts while the desk is on screen: once it is gone no leave event may come to clear it.
  const pointed = ended ? null : peek;
  const seat = pointed ?? pinned ?? speakerOf(scene) ?? 'A';
  const open = Boolean(pointed ?? pinned);
  const arrived = arrivedAt(scenario.arrivals, ended ? Infinity : clock);
  const leaveDrawer = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) drawer.setPeek(null);
  };

  const rail = (
    <JuryRail stage={scene?.stage ?? null} skipped={skipped} ended={ended}
      onJump={key => playback.seek(scenes.find(item => item.stage === key)?.start ?? 0)} />
  );

  return (
    <>
      <Toolbar rail={rail}>
        {settings}
        <div className={styles.transport}>
          <span className={styles.elapsed} aria-label="评审已进行">已进行 {formatElapsed(clock)}</span>
          <button type="button" onClick={playback.toggle} aria-label={playback.playing ? '暂停' : '继续播放'}>
            {playback.playing ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
            {playback.playing ? '暂停' : ended ? '再看一遍' : '继续'}
          </button>
          <button type="button" onClick={playback.restart}><RotateCcw size={15} aria-hidden="true" />从头播放</button>
          {ended ? null : (
            <button type="button" onClick={playback.skipToEnd} title="原型专用"><FastForward size={15} aria-hidden="true" />跳到结果</button>
          )}
          <div role="radiogroup" aria-label="播放速度" className={styles.speeds}>
            {SPEEDS.map(speed => (
              <button key={speed} type="button" role="radio" aria-checked={playback.speed === speed} onClick={() => playback.setSpeed(speed)}>
                {speed}×
              </button>
            ))}
          </div>
        </div>
      </Toolbar>

      <main className={styles.main}>
        <div className={cn(styles.floor, !ended && styles.floorLive)} ref={stageRef}>
          {ended ? (
            <JuryResults detail={scenario.detail} names={names} onOpenRecord={openRecord} />
          ) : (
            <JuryDesk scene={scene} view={deskAt(scenes, clock)} names={names} clock={clock} failed={failed} selected={pointed ?? pinned}
              onPeek={drawer.setPeek} onPick={code => (pinned === code ? drawer.close() : openRecord(code))} />
          )}
        </div>
        <aside className={styles.side} data-open={open} ref={dossierRef} aria-label="评审记录"
          onMouseEnter={drawer.hold} onMouseLeave={() => drawer.setPeek(null)} onFocus={drawer.hold} onBlur={leaveDrawer}>
          <p className={styles.sideHint}>
            <span>指向（手机上点一下）评审或页边批注，看这位的完整记录{pinned ? '' : '；点一下可以固定'}</span>
            <button type="button" className={styles.backToRoom} onClick={() => stageRef.current?.scrollIntoView({ behavior: 'smooth' })}>
              回到报告
            </button>
            <button type="button" className={styles.closeDrawer} onClick={drawer.close} aria-label="收起记录">
              <X size={15} aria-hidden="true" />收起
            </button>
          </p>
          <JuryDossier detail={scenario.detail} names={names} seat={seat} arrived={arrived} live={!ended}
            onSelect={openRecord} />
        </aside>
      </main>
    </>
  );
}
