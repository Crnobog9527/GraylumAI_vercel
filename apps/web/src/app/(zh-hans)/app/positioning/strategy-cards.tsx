/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import styles from './start-work.module.css';

/**
 * The two "策略" cards of the start page: 做一批新选题 and 找到你的内容定位. For a user who has no confirmed
 * positioning yet (`startHere`), positioning comes first and carries the mark "从这里开始": topics and writing for the
 * user's own account wait for it (Owner 2026-11-12, MASTER_PLAN §2.1: no onboarding dialog, only this). Everyone else
 * keeps the usual order without a mark.
 */
export function StrategyCards({ startHere, onTopics, onPosition }: { startHere: boolean; onTopics: () => void; onPosition: () => void }) {
  const topics = <button key="topics" onClick={onTopics}>
    <span className={`${styles.moduleVisual} ${styles.artTopics}`}><span className={styles.big}>让好想法<br />接着发生。</span>
      <span className={styles.mini}>IDEAS, INTO STORIES.</span></span>
    <strong>做一批新选题</strong><small>选定规划，找到值得写的方向</small></button>;
  const position = <button key="position" onClick={onPosition} data-start-here={startHere || undefined}>
    <span className={`${styles.moduleVisual} ${styles.artPosition}`}><span className={styles.targetRings} /><b>找到<br />你的坐标</b></span>
    <strong>找到你的内容定位</strong><small>定位分析，明确受众与价值</small>
    {/* Over the art's corner on a wide screen; on a phone the art has no free corner, so the mark sits under the text. */}
    {startHere && <em className={styles.startHere}>从这里开始</em>}</button>;
  return <>{startHere ? [position, topics] : [topics, position]}</>;
}
