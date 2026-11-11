/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { CtaK } from '@/components/landing/preview-k/CtaK';
import k from '@/components/landing/preview-k/k.module.css';
import { HOW_IT_WORKS } from '@/lib/landing/landing-copy';
import { L_STEPS } from '@/lib/landing/landing-copy-l-steps';
import { visibleItems, type LandingFlags } from '@/lib/landing/landing-flags';
import { cn } from '@/lib/utils';
import { FlowModuleL, FlowStepL } from './FlowModuleL';
import { JuryModuleL } from './JuryModuleL';
import { LaterStepsL } from './LaterStepsL';
import { STEP_ONE_PICTURES } from './StepOneFlowL';
import styles from './steps-l.module.css';

/**
 * Region 3 (Owner 2026-10-17): 第一步/第二步/第三步. Owner 2026-11-11: "现在是做视差滚动，用户必须要全程看完所有流程才能继续
 * 往下看……信息获取的效率太低了，而是应该把每一块步骤……拆开……每个模块做成自动循环播放的动画。中间的过程可以加速甚至简略
 * 一点……文字也太多了". So nothing holds the scroll any more: each stage of a step is a module of its own (FlowModuleL),
 * a name, one line and a short picture on the product's own components that plays by itself in a loop while on screen;
 * the page scrolls freely past them. This replaces round eight's scroll-driven stage (U1, 2026-10-18) and with it the
 * progress bar and the "看过了，跳过这段" button of step one. Server HTML and reduced motion: every picture finished, still.
 */
export function StepsL({ flags, juryHref }: {
  flags: LandingFlags;
  /** The jury's link (JuryModuleL): null on the public home page until a public jury page exists. */
  juryHref?: string | null;
}) {
  const stages = visibleItems(flags, L_STEPS.one.stages);
  return (
    <section id="how-it-works" aria-labelledby="steps-title" data-zone="takeover" data-region="三步">
      <div className={cn(k.wrap, styles.intro)}><h2 id="steps-title" className={k.lead}>{HOW_IT_WORKS.title}</h2></div>
      <div className={k.wrap}>
        <FlowStepL id="step-one-title" title={L_STEPS.one.title} first>
          {stages.map((stage, index) => (
            <FlowModuleL key={stage.label} number={index + 1} name={stage.label} line={stage.note} picture={STEP_ONE_PICTURES[stage.moment]} />
          ))}
        </FlowStepL>
        {/* Round twelve: the jury hangs under step one, its last beat. */}
        <JuryModuleL flags={flags} href={juryHref} />
      </div>
      <div className={cn(k.wrap, styles.after)}><CtaK /></div>
      <LaterStepsL flags={flags} />
    </section>
  );
}
