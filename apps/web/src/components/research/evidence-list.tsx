/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Library view of fetched evidence (RESEARCH_TOOLS_PLAN.md §4.3 "资料库展示"): every research lookup kept as
// evidence, with what was looked up, when, how it ended and its public source links. No new library table: rows
// come from the research operations the host already stores (0065 / 0263). Supplier names and costs never appear.
import type { ReactNode } from "react";
import type { ResearchToolName } from "../../../../../packages/api/src/services/research/tools/schemas";
import { CALL_STATE_LABELS, describeRequest, type CallState } from "./research-model";
import styles from "./research.module.css";

/** Operation states of `research_operations` that reach the library. */
export type EvidenceState = "succeeded" | "failed" | "unknown";

export interface EvidenceEntry {
  evidenceId: string;
  tool: ResearchToolName;
  args: unknown;
  state: EvidenceState;
  /** Absent when nothing came back. */
  fetchedAt: string | null;
  /** Items kept as evidence; null when nothing came back. */
  itemCount: number | null;
  truncated: boolean;
  /** Public source links of the kept items, as stored. */
  sourceUrls: string[];
  conversationTitle: string;
  /** Link back to the conversation the lookup belongs to, when the page knows its route. */
  conversationHref?: string;
}

const STATE: Record<EvidenceState, CallState> = { succeeded: "success", failed: "missing", unknown: "pending" };
const SOURCES_SHOWN = 3;

/** Only plain public http(s) links are rendered as links. */
export function publicLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password
      ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Fetch time in the viewer's own time zone, e.g. "2026-10-17 02:00". */
export function formatEvidenceTime(value: string | null, timeZone?: string): string {
  const ms = value === null ? Number.NaN : Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString("sv-SE", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    ...(timeZone ? { timeZone } : {}),
  });
}

export function EvidenceList({ entries, children }: { entries: EvidenceEntry[]; children?: ReactNode }) {
  const rows = entries.flatMap(entry => {
    const request = describeRequest(entry.tool, entry.args);
    return request ? [{ entry, request }] : [];
  });
  return (
    <section aria-label="取数记录" className={styles.card}>
      <p className={styles.head}>取数记录</p>
      <p className={styles.hint}>AI 教练在对话里查过的公开数据都留在这里，方便核对来源。删除对话后，对应的记录会一起删除。</p>
      {rows.length === 0 ? <p className={styles.hint}>还没有取数记录。</p> : (
        <ul className={styles.evidenceList}>
          {rows.map(({ entry, request }) => {
            const state = STATE[entry.state];
            const links = entry.sourceUrls.map(publicLink).filter((url): url is string => url !== null);
            return (
              <li key={entry.evidenceId} className={styles.evidence}>
                <div className={styles.evidenceTop}>
                  <span className={styles.callQuery}>{request.query || "（未提供）"}</span>
                  <span className={`${styles.chip} ${styles[`state_${state}`]}`}>{CALL_STATE_LABELS[state]}</span>
                </div>
                <p className={styles.callMeta}>
                  <span>{request.line}</span>
                  <span>取数时间 {formatEvidenceTime(entry.fetchedAt)}</span>
                  {entry.itemCount !== null && <span>{entry.itemCount} 条{entry.truncated ? "（已截取）" : ""}</span>}
                  <span>编号 {entry.evidenceId}</span>
                </p>
                {links.length > 0 && (
                  <ul className={styles.sourceLinks} aria-label="来源链接">
                    {links.slice(0, SOURCES_SHOWN).map(url => (
                      <li key={url}><a href={url} target="_blank" rel="noopener noreferrer nofollow">{url}</a></li>
                    ))}
                    {links.length > SOURCES_SHOWN && <li className={styles.callMeta}>另有 {links.length - SOURCES_SHOWN} 个来源</li>}
                  </ul>
                )}
                {entry.conversationHref
                  ? <a className={styles.evidenceBack} href={entry.conversationHref}>所在对话：{entry.conversationTitle}</a>
                  : <span className={styles.evidenceBack}>所在对话：{entry.conversationTitle}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {children}
    </section>
  );
}
