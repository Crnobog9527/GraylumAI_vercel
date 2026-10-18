/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { BarChart3, BookOpen, Lightbulb, PenLine, Send, type LucideIcon } from 'lucide-react';
import { J_WORK } from '@/lib/landing/landing-copy-j-work';
import { visibleItems, type LandingFlags } from '@/lib/landing/landing-flags';
import { K_RHYTHM } from '@/lib/landing/landing-copy-k';
import styles from './k.module.css';

const ICONS: Record<string, LucideIcon> = {
  周一给选题: Lightbulb, 按你的文风写稿: PenLine, 一键发多平台: Send, 周末复盘告诉你改什么: BarChart3, 资料库记得你: BookOpen,
};

/**
 * Region 5, "改成一行每周节奏" (Owner 2026-10-17): sample J's title and closing line over one still row of what the coach
 * does each week; an item whose capability is off is left out. No player, no demos.
 */
export function RhythmK({ flags }: { flags: LandingFlags }) {
  const items = visibleItems(flags, K_RHYTHM);
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="rhythm-title" className={styles.section} data-zone="work" data-region="每周节奏">
      <div className={styles.wrap}>
        <h2 id="rhythm-title" className={styles.minor}>{J_WORK.groups[0]}</h2>
        <p className={styles.minorLede}>{J_WORK.close}</p>
        <ol className={styles.rhythm}>
          {items.map(item => {
            const Icon = ICONS[item.text] ?? Lightbulb;
            return <li key={item.text}><Icon size={20} strokeWidth={1.8} aria-hidden="true" />{item.text}</li>;
          })}
        </ol>
      </div>
    </section>
  );
}
