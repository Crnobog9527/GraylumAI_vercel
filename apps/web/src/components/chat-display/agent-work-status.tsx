/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { BarChart3, BookOpen, Check, CircleAlert, Clock3, Compass, FileSearch, Loader2, Search, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { STATE_LABELS, workItemLine, type WorkItem, type WorkKind, type WorkState } from './agent-work-model';
import styles from './agent-work-status.module.css';

const KIND_ICONS: Record<WorkKind, typeof Check> = {
  positioning: Compass, library_search: FileSearch, library_read: BookOpen,
  my_posts: BarChart3, my_benchmarks: Users, research: Search,
};
const STATE_ICONS: Record<Exclude<WorkState, 'running'>, typeof Check> = { done: Check, missing: CircleAlert, pending: Clock3 };

/**
 * What the coach did before answering (CHAT-AUTO-CONTEXT §4): one compact row per step, e.g. "正在查资料库…"
 * while it runs, then "在资料库里找到 3 篇相关内容" with the file names. Display only: rows come in as props,
 * built by the page from the turn stream or by the landing page from the shared samples.
 */
export function AgentWorkStatus({ items }: { items: readonly WorkItem[] }) {
  if (items.length === 0) return null;
  return (
    <ul aria-label="AI 教练的工作记录" className={styles.list}>
      {items.map(item => {
        const running = item.state === 'running';
        const Icon = running ? Loader2 : KIND_ICONS[item.kind];
        const StateIcon = running ? null : STATE_ICONS[item.state as Exclude<WorkState, 'running'>];
        return (
          <li key={item.id} className={styles.row} data-work-kind={item.kind} data-work-state={item.state}>
            <Icon aria-hidden size={14} className={cn(styles.icon, running && styles.spin)}/>
            <div className={styles.body}>
              <p className={styles.line}>{workItemLine(item)}</p>
              {(item.detail || !running || item.credits) && (
                <p className={styles.meta}>
                  {item.detail && <span className={styles.detail}>{item.detail}</span>}
                  {StateIcon && item.state !== 'done' && (
                    <span className={cn(styles.chip, styles[`state_${item.state}`])}>
                      <StateIcon aria-hidden size={11}/>{STATE_LABELS[item.state as Exclude<WorkState, 'running'>]}
                    </span>
                  )}
                  {item.credits && <span className={styles.credits}>扣 {item.credits}</span>}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
