/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { cn } from '@/lib/utils';
import { SEVERITY_LABEL, VERDICT_LABEL, type JurySeatNames, type SeatCode, type Severity, type Verdict } from './jury-events';
import { LOOKS } from './JuryCharacter';
import styles from './jury-board.module.css';

/** Small shared marks: a seat's colour disc with its name, a verdict stamp and a severity tag. */
export function SeatBadge({ seat, names, compact }: { seat: SeatCode; names: JurySeatNames; compact?: boolean }) {
  return (
    <span className={cn(styles.seatBadge, compact && styles.seatBadgeCompact)} title={names[seat]}>
      <span className={styles.seatDisc} style={{ background: LOOKS[seat].coat }} aria-hidden="true">{seat === 'S' ? '裁' : seat}</span>
      <span className={styles.seatName}>{names[seat]}</span>
    </span>
  );
}

export function VerdictStamp({ verdict, label }: { verdict: Verdict; label?: string }) {
  return <span className={styles.stamp} data-verdict={verdict}>{label ?? VERDICT_LABEL[verdict]}</span>;
}

export function SeverityTag({ severity }: { severity: Severity }) {
  return <span className={styles.severity} data-severity={severity}>{SEVERITY_LABEL[severity]}</span>;
}

export function ChapterTag({ children }: { children: string }) {
  return <span className={styles.chapter}>{children}</span>;
}
