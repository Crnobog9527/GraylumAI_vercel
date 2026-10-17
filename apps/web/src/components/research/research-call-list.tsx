/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Check, CircleAlert, Clock3, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { CALL_STATE_LABELS, describeCall, type CallState, type ResearchCall } from "./research-model";
import styles from "./research.module.css";

const ICONS: Record<CallState, typeof Check> = { running: Loader2, success: Check, missing: CircleAlert, pending: Clock3 };

/**
 * Every research call of a reply, one compact row each: what was searched, which kind of data, and the result
 * (成功 / 未取到 / 待核) with the credits it settled at, from the stream's `research_call` events. No supplier
 * names or supplier costs.
 */
export function ResearchCallList({ calls }: { calls: readonly ResearchCall[] }) {
  const rows = calls.map(call => ({ id: call.callId, view: describeCall(call) }));
  if (rows.length === 0) return null;
  return (
    <ul aria-label="搜索记录" className={styles.calls}>
      {rows.map(({ id, view }) => {
        const Icon = ICONS[view.state];
        return (
          <li key={id} className={styles.call} data-research-call={view.state}>
            <Icon aria-hidden size={14} className={cn(styles.callIcon, styles[`state_${view.state}`],
              view.state === "running" && styles.spin)} />
            <div className={styles.callBody}>
              <p className={styles.callLine}>
                <span className={styles.callVerb}>{view.state === "running" ? CALL_STATE_LABELS.running : "搜索"}</span>
                <span className={styles.callQuery}>{view.query || "（未提供）"}</span>
              </p>
              <p className={styles.callMeta}>
                <span>{view.line}</span>
                {view.state !== "running" && (
                  <span className={cn(styles.chip, styles[`state_${view.state}`])}>{CALL_STATE_LABELS[view.state]}</span>
                )}
                {view.credits && <span className={styles.callCredits}>扣 {view.credits}</span>}
              </p>
              {view.detail && <p className={styles.callDetail}>{view.detail}</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
