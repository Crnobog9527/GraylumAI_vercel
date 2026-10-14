/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { cn } from '@/lib/utils';
import { SEATS, type JurySeatNames, type SeatCode } from './jury-events';
import type { Poses } from './jury-poses';
import { JuryCharacter } from './JuryCharacter';
import styles from './jury-room.module.css';

const POSE_LINE: Record<string, string> = {
  idle: '在座', reading: '读报告', thinking: '思考中', submitted: '已交卷', speaking: '发言', listening: '在听',
  objecting: '举手反对', nodding: '点头同意', absent: '没有给出可用意见',
  watching: '旁听', writing: '汇总、写修订稿', gavel: '裁决', presenting: '交出修订稿', failed: '修订稿没通过检查',
};

/**
 * The jury room: the summary's bench at the back, the three reviewers around the table in front. Pointing at a
 * person (or tapping on a phone) opens that person's own record; the room itself only shows what they are doing.
 */
export function JuryRoom({ names, poses, selected, entering, onPeek, onPick }: {
  names: JurySeatNames; poses: Poses; selected: SeatCode | null; entering: boolean;
  onPeek: (seat: SeatCode | null) => void; onPick: (seat: SeatCode) => void;
}) {
  const seat = (code: SeatCode) => {
    const pose = code === 'S' ? poses.judge : poses.seats[code];
    const bubble = poses.bubble[code];
    return (
      <button
        key={code} type="button" className={cn(styles.person, selected === code && styles.personSelected)} data-seat={code}
        data-pose={pose} data-face={code === 'S' ? undefined : poses.face[code]} aria-pressed={selected === code}
        aria-label={`${names[code]}：${POSE_LINE[pose]}。查看这位的完整记录`}
        onMouseEnter={() => onPeek(code)} onMouseLeave={() => onPeek(null)} onFocus={() => onPeek(code)} onBlur={() => onPeek(null)}
        onClick={() => onPick(code)}
      >
        {bubble ? <span key={bubble} className={styles.bubble} data-tone={bubbleTone(bubble)}>{bubble}</span> : null}
        <JuryCharacter seat={code} pose={pose} />
        <span className={styles.nameTag}>
          <span className={styles.nameText} title={names[code]}>{names[code]}</span>
          <span className={styles.poseText}>{POSE_LINE[pose]}</span>
        </span>
      </button>
    );
  };
  return (
    <div className={cn(styles.room, entering && styles.entering)}>
      <div className={styles.wall} aria-hidden="true">
        <span className={styles.window} /><span className={styles.window} />
      </div>
      <div className={styles.benchArea}>
        {seat('S')}
        <div className={styles.bench} aria-hidden="true"><span>裁决席</span></div>
      </div>
      <div className={styles.floor} aria-hidden="true" />
      <div className={styles.circle}>
        {SEATS.map(seat)}
        <div className={styles.table} aria-hidden="true" />
      </div>
    </div>
  );
}

function bubbleTone(text: string): string {
  if (['要改', '我不同意', '不采纳'].includes(text)) return 'change';
  if (['保留', '有道理', '采纳'].includes(text)) return 'keep';
  return 'plain';
}
