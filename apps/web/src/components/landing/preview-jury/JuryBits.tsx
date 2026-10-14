/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { cn } from '@/lib/utils';
import {
  SEATS, SEVERITY_LABEL, VERDICT_LABEL, type JurySeatNames, type SeatCode, type Severity, type Verdict,
} from './jury-events';
import styles from './jury-bits.module.css';

/**
 * Each person's mark: the first character of their display name (upper-cased for Latin names) on a muted colour.
 * When two reviewers would share a mark (the default names all start with "评"), reviewers fall back to their seat
 * letter. The summary always gets the square seal, so it never reads as a fourth reviewer.
 */
export function seatInitials(names: JurySeatNames): Record<SeatCode, string> {
  const first = (name: string) => (Array.from(name.trim())[0] ?? '').toUpperCase();
  const marks = SEATS.map(seat => first(names[seat]));
  const unique = new Set(marks).size === SEATS.length && marks.every(Boolean);
  return {
    A: unique ? marks[0] : 'A', B: unique ? marks[1] : 'B', C: unique ? marks[2] : 'C', S: first(names.S) || '汇',
  };
}

export function SeatMark({ seat, names, size = 'md' }: { seat: SeatCode; names: JurySeatNames; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={styles.mark} data-seat={seat} data-size={size} aria-hidden="true">{seatInitials(names)[seat]}</span>
  );
}

/** The mark with the name beside it; long names are cut with an ellipsis and kept whole in the tooltip. */
export function SeatBadge({ seat, names, compact }: { seat: SeatCode; names: JurySeatNames; compact?: boolean }) {
  return (
    <span className={cn(styles.badge, compact && styles.badgeCompact)} title={names[seat]}>
      <SeatMark seat={seat} names={names} size={compact ? 'sm' : 'md'} />
      <span className={styles.name}>{names[seat]}</span>
    </span>
  );
}

export function VerdictStamp({ verdict, label }: { verdict: Verdict; label?: string }) {
  return <span className={styles.verdict} data-verdict={verdict}>{label ?? VERDICT_LABEL[verdict]}</span>;
}

export function SeverityTag({ severity }: { severity: Severity }) {
  return <span className={styles.severity} data-severity={severity}>{SEVERITY_LABEL[severity]}</span>;
}

export function ChapterTag({ children }: { children: string }) {
  return <span className={styles.chapter}>{children}</span>;
}

/** The summary's ruling mark on a note: a small square seal, adopted in ink, not adopted in grey. */
export function RulingSeal({ adopted, large }: { adopted: boolean; large?: boolean }) {
  return (
    <span className={cn(styles.seal, large && styles.sealLarge)} data-adopted={adopted}>{adopted ? '采纳' : '不采纳'}</span>
  );
}
