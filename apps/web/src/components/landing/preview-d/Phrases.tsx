/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Fragment } from 'react';
import { FINAL_ACTION, HERO, HOW_IT_WORKS, VOICE_WALL } from '@/lib/landing/landing-copy';
import { SAMPLE_REPORTS_TITLE } from '@/lib/landing/landing-samples';
import styles from './d.module.css';

/**
 * Where a poster-size heading may wrap. Chinese breaks between any two characters, which at this size splits
 * words such as 自媒/体; each phrase below stays on one line. The phrases join back to the exact final copy
 * (tested), so the words never change.
 */
export const HEADING_PHRASES: Record<string, readonly string[]> = {
  [HERO.title]: ['你的', ' ', 'AI', ' ', '自媒体', '陪跑教练'],
  [VOICE_WALL.title]: ['他们抱怨的', ' ', 'vs', ' ', '教练怎么做'],
  [HOW_IT_WORKS.title]: ['AI', ' ', '教练', '怎么接手', '你的运营'],
  [HOW_IT_WORKS.timelineTitle]: ['什么时候', '拿到什么'],
  [FINAL_ACTION.title]: ['现在', '有两条路'],
  [SAMPLE_REPORTS_TITLE]: ['不同人群的', '样例报告'],
};

export function Phrases({ text }: { text: string }) {
  const phrases = HEADING_PHRASES[text];
  if (!phrases) return <>{text}</>;
  return (
    <>
      {phrases.map((phrase, index) => (phrase === ' '
        ? <Fragment key={index}> </Fragment>
        : <span key={index} className={styles.phrase}>{phrase}</span>))}
    </>
  );
}
