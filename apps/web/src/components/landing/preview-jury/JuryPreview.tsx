/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, FastForward, Pause, Play, RotateCcw } from 'lucide-react';
import light from '@/components/design/light-tokens.module.css';
import { cn } from '@/lib/utils';
import { resolveSeatNames, SAMPLE_PANEL, type JurySeatNames, type SeatCode } from './jury-events';
import { buildScenes, formatElapsed, playbackLength, sceneAt, skippedStages, stageIndex } from './jury-scenes';
import { findScenario, JURY_SCENARIOS, type JuryScenario } from './jury-scripts';
import { arrivedAt, speakerOf } from './jury-progress';
import { canvasAt } from './jury-canvas';
import { remainingMs, remainingText, totalText } from './jury-eta';
import { JuryCanvas } from './JuryCanvas';
import { JuryEmbedDemo } from './JuryEmbedDemo';
import { JuryAway, JuryIntro } from './JuryIntro';
import { JuryReader } from './JuryReader';
import { JuryRecords } from './JuryRecords';
import { JuryStatic } from './JuryStatic';
import { JuryStepsRail } from './JuryStepsRail';
import { useJuryPlayback, usePrefersReducedMotion } from './use-jury-playback';
import { useRestoredStep, useReviewAddress } from './use-review-address';
import styles from './jury.module.css';
import layout from './jury-layout.module.css';

const SPEEDS = [1, 3] as const;
/** The account the report is for, as the breadcrumb back to the positioning analysis names it. */
const MOCK_ACCOUNT = '小林下班做饭';

/**
 * FUSION-REVIEW prototype v5: a start card saying how long the review takes; then the steps on the left, the canvas
 * in the middle and each person's record on the right; then the result as the whole report made easy to read, where
 * the user picks the revision or the original chapter by chapter. Mock data in the shapes of FUSION-REVIEW.md §2.2a
 * (events, detail, adopt). Not linked anywhere and never indexed.
 */
export function JuryPreview() {
  const { scenarioId, setScenarioId, resolved } = useReviewAddress('full');
  const [sampleNames, setSampleNames] = useState(false);
  const [embed, setEmbed] = useState(false);
  const [background, setBackground] = useState(false);
  const scenario = findScenario(scenarioId);
  const names = resolveSeatNames(sampleNames ? SAMPLE_PANEL : undefined);

  const toggle = (label: string, title: string, checked: boolean, onChange: (value: boolean) => void) => (
    <label className={styles.switch} title={title}>
      <input type="checkbox" role="switch" checked={checked} onChange={event => onChange(event.target.checked)} />
      <span aria-hidden="true" />
      {label}
    </label>
  );
  const settings = (
    <>
      <nav aria-label="面包屑" className={styles.crumbs}>
        <a href="#positioning" title="原型：真实页面会回到这份定位分析">
          <ArrowLeft size={15} aria-hidden="true" />返回：我的定位分析 · {MOCK_ACCOUNT}
        </a>
      </nav>
      <h1 className={styles.title}>评审团正在审阅你的定位报告</h1>
      <div role="radiogroup" aria-label="选择评审结局" className={styles.scenarios}>
        {JURY_SCENARIOS.map(item => (
          <button key={item.id} type="button" role="radio" aria-checked={item.id === scenarioId} title={item.hint}
            onClick={() => setScenarioId(item.id)}>{item.label}</button>
        ))}
      </div>
      {toggle('示例名字', '管理员可改', sampleNames, setSampleNames)}
      {toggle('后台推进', '原型：FUSION-BACKGROUND 做完后，评审在服务端推进，可以离开页面', background, setBackground)}
      {toggle('嵌入版', '落地页用的嵌入版', embed, setEmbed)}
    </>
  );

  return (
    <div className={cn(light.light, styles.page)}>
      {!resolved ? null : embed ? (
        <>
          <Toolbar>{settings}</Toolbar>
          <main className={styles.main}><JuryEmbedDemo scenario={scenario.id} names={names} /></main>
        </>
      ) : <Player key={`${scenario.id}-${background}`} scenario={scenario} names={names} background={background} settings={settings} />}
      <footer className={styles.sampleBar}>
        <p>
          三位评审各自读完、提出意见；意见不一的地方辩论一轮，再由{names.S}逐条裁决、写出修订稿。用不用修订稿，由你逐章决定。
        </p>
        <p>
          不公开的评审团动画原型（第 5 版）：模拟数据，按真实评审的事件顺序播放；剩余时间按 staging 实测的分段时长估算。
          <Link href="/landing/preview/g">样稿 G</Link>
        </p>
      </footer>
    </div>
  );
}

/** One toolbar for everything: the stage below it fills the rest of the window, so its height is published as --j-bar. */
function Toolbar({ children }: { children: ReactNode }) {
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
    </div>
  );
}

function Player({ scenario, names, background, settings }: {
  scenario: JuryScenario; names: JurySeatNames; background: boolean; settings: ReactNode;
}) {
  const reduced = usePrefersReducedMotion();
  const scenes = useMemo(() => buildScenes(scenario.arrivals), [scenario]);
  const length = playbackLength(scenes);
  const playback = useJuryPlayback(length, !reduced);
  const [intro, setIntro] = useState<'shown' | 'stay' | 'away'>('shown');
  const [picked, setPicked] = useState<SeatCode | null>(null);
  const skipped = skippedStages(scenes);
  const restoreAt = playback.seek;
  const stepNow = playback.finished ? 'end' : sceneAt(scenes, playback.clock)?.stage ?? 'start';
  useRestoredStep(scenario.detail.reviewId, stepNow, playback.clock, clock => {
    restoreAt(clock);
    setIntro('stay');
  });

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
  const arrived = arrivedAt(scenario.arrivals, ended ? Infinity : clock);
  const left = remainingText(remainingMs(scenes, clock));
  const step = scene ? `第 ${stageIndex(scene.stage) + 1} 步/共 8 步` : '第 1 步/共 8 步';
  const pick = (seat: SeatCode) => setPicked(seat);

  const transport = (
    <div className={styles.transport}>
      <span className={styles.elapsed} aria-label="评审已进行">已进行 {formatElapsed(clock)}</span>
      <button type="button" onClick={playback.toggle} aria-label={playback.playing ? '暂停' : '继续播放'}>
        {playback.playing ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
        {playback.playing ? '暂停' : ended ? '再看一遍' : '继续'}
      </button>
      <button type="button" onClick={() => { playback.restart(); setIntro('shown'); }}>
        <RotateCcw size={15} aria-hidden="true" />从头播放
      </button>
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
  );

  if (intro === 'away') {
    return (
      <>
        <Toolbar>{settings}{transport}</Toolbar>
        <main className={styles.main}><JuryAway step={step} ended={ended} onBack={() => setIntro('stay')} /></main>
      </>
    );
  }

  const records = (
    <JuryRecords detail={scenario.detail} names={names} arrived={arrived} live={!ended}
      following={speakerOf(scene) ?? (ended ? 'S' : 'A')} picked={picked} onPick={pick} onFollow={() => setPicked(null)} />
  );

  return (
    <>
      <Toolbar>{settings}{transport}</Toolbar>
      <main className={styles.main}>
        {ended ? (
          <div className={layout.results}>
            <JuryReader detail={scenario.detail} names={names} />
            {records}
          </div>
        ) : (
          <div className={layout.live}>
            <JuryStepsRail stage={scene?.stage ?? null} skipped={skipped} ended={ended} left={left}
              onJump={key => playback.seek(scenes.find(item => item.stage === key)?.start ?? 0)} />
            <div className={layout.stage}>
              <JuryCanvas view={canvasAt(scenes, clock, names)} names={names} selected={picked} onPeek={() => {}} onPick={pick} />
              {intro === 'shown' ? (
                <JuryIntro total={totalText(scenes)} background={background} onStay={() => setIntro('stay')}
                  onLeave={() => setIntro('away')} />
              ) : null}
            </div>
            {records}
          </div>
        )}
      </main>
    </>
  );
}
