/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { BellRing, Clock3, LayoutGrid, Loader2 } from 'lucide-react';
import styles from './jury-layout.module.css';
import { DisplayHeading } from '@/components/chat-display/display-heading';

/**
 * The card over the canvas when a review starts. Today the review only moves while this page is open (the browser
 * drives it), so the card says so and has one button. Once FUSION-BACKGROUND moves it to the server, the user may
 * leave: two buttons, and a status tag in the corner of the workbench. The prototype switches between the two.
 */
export function JuryIntro({ total, background, onStay, onLeave }: {
  total: string; background: boolean; onStay: () => void; onLeave: () => void;
}) {
  return (
    <div className={styles.introLayer}>
      <section className={styles.intro} role="dialog" aria-labelledby="jury-intro-title" aria-modal="false">
        <Clock3 size={22} aria-hidden="true" className={styles.introIcon} />
        <DisplayHeading as="h2" id="jury-intro-title">{background ? `评审在后台进行，${total}` : `评审进行中，大约 ${total.replace(/^约 /, '')}`}</DisplayHeading>
        <p>
          {background
            ? '你可以先去忙别的，做完会在工作台提醒你；也可以留在这里看。'
            : '请保持这个页面打开，你可以看评审过程，也可以先做别的标签页的事。'}
        </p>
        <div className={styles.introActions}>
          {background ? (
            <>
              <button type="button" className={styles.introSecondary} onClick={onLeave}>先去忙别的</button>
              <button type="button" className={styles.introPrimary} onClick={onStay}>留下来看</button>
            </>
          ) : <button type="button" className={styles.introPrimary} onClick={onStay}>好的</button>}
        </div>
      </section>
    </div>
  );
}

/**
 * Prototype only: the workbench the user went back to, with the review's status in the corner. The tag takes the
 * user back to the canvas, or to the result once the review is done.
 */
export function JuryAway({ step, ended, onBack }: { step: string; ended: boolean; onBack: () => void }) {
  return (
    <div className={styles.away}>
      <div className={styles.workbench}>
        <LayoutGrid size={22} aria-hidden="true" />
        <DisplayHeading as="h2">工作台</DisplayHeading>
        <p>原型示意：这里是你平时的工作台，可以继续写选题、改草稿。评审在后台照常进行。</p>
      </div>
      <button type="button" className={styles.statusTag} data-done={ended} onClick={onBack}>
        {ended ? <BellRing size={16} aria-hidden="true" /> : <Loader2 size={16} aria-hidden="true" className={styles.spin} />}
        {ended ? '评审完成，去看结果' : `评审进行中 · ${step}`}
      </button>
    </div>
  );
}
