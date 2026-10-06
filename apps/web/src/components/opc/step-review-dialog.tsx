/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ChatInlineNotice } from "@/components/chat/ChatInlineNotice";
import styles from "./capture-checklist.module.css";
import { EMPTY_VALUE, type ChecklistField, type ReviewProblem, type VisibleStep } from "./capture-state";

export type StepReviewProps = {
  title: string;
  schema: readonly ChecklistField[];
  /** Exactly what this confirmation compares and writes: the review baseline plus the user's edits. */
  reviewed: VisibleStep;
  /** Text of each update the user saw when the review opened. */
  updates: Record<string, string>;
  deferred: ReadonlySet<string>;
  problems: readonly ReviewProblem[];
  /** The content changed after the review opened; the user has to look again. */
  changed: boolean;
  busy: boolean;
  onEdit: (fieldId: string, value: string) => void;
  onDefer: (fieldId: string, deferred: boolean) => void;
  onConfirm: () => void;
  onClose: () => void;
};

const problemText: Record<ReviewProblem["reason"], string> = {
  required: "这是必需信息：请补充；暂时无法确定时，勾选暂缓并写明原因。",
  reason_required: "请写下暂缓的原因。",
  non_answer: "「好的」「不知道」这类回应本身不是这一项的内容，请写下实际内容或暂缓。",
};

/**
 * The whole-step review ("核对并确认"): every field is editable through the normal
 * autosave, a required field can be deferred with a written reason, and pending
 * updates are shown so the user knows they are not part of this confirmation.
 */
export function StepReviewDialog(props: StepReviewProps) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => { dialog.current?.focus(); }, []);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onMouseDown={event => { if (event.target === event.currentTarget && !props.busy) props.onClose(); }}>
      <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`核对并确认：${props.title}`}
        className={styles.dialog} onKeyDown={event => { if (event.key === "Escape" && !props.busy) props.onClose(); }}>
        <header><h2>核对并确认：{props.title}</h2>
          <button type="button" aria-label="关闭核对" disabled={props.busy} onClick={props.onClose}>×</button></header>
        <p>确认的是下面你看到的这一版内容。还没处理的“根据对话整理的更新”不会被确认，确认后仍可采用。</p>
        {props.changed && <ChatInlineNotice tone="warning" alert>
          内容刚刚有变化（整理结果、另一个窗口的修改或新的更新），已刷新为最新内容。请重新核对后再确认。
        </ChatInlineNotice>}
        {props.schema.map(field => {
          const value = props.reviewed.values[field.id] ?? EMPTY_VALUE;
          const deferred = props.deferred.has(field.id);
          const problem = props.problems.find(item => item.fieldId === field.id);
          const update = props.updates[field.id];
          return (
            <div key={field.id} className={styles.reviewField}>
              <label htmlFor={`review-${field.id}`}>{field.title}{field.required ? "（必需）" : "（选填）"}</label>
              <Textarea id={`review-${field.id}`} aria-label={`核对：${field.title}`} maxLength={400} disabled={props.busy}
                placeholder={deferred ? "写下暂时无法确定的原因" : field.required ? "请补充这一项" : "选填，可以留空"}
                value={value.value} onChange={event => props.onEdit(field.id, event.target.value)}/>
              <label className={styles.defer}>
                <input type="checkbox" checked={deferred} disabled={props.busy}
                  onChange={event => props.onDefer(field.id, event.target.checked)}/>
                暂时无法确定，写明原因后暂缓（确认正式定位前需要补上）
              </label>
              {update && <p className={styles.note}>有一条根据对话整理的更新尚未处理：{update}</p>}
              {problem && <p className={styles.problem} role="alert">{problemText[problem.reason]}</p>}
            </div>
          );
        })}
        <footer>
          <Button variant="outline" disabled={props.busy} onClick={props.onClose}>返回继续补充</Button>
          <Button disabled={props.busy} onClick={props.onConfirm}>确认这一步</Button>
        </footer>
      </section>
    </div>
  );
}

/** Host-authored summary card in the chat once a step's required items all have content. No model call. */
export function StepSummaryCard({ title, disabled, onReview, onMore }: {
  title: string; disabled: boolean; onReview: () => void; onMore: () => void;
}) {
  return (
    <div className={styles.summary} role="group" aria-label="本步小结">
      <p>“{title}”的信息已经齐了：请在右侧核对，或继续补充。</p>
      <div>
        <Button disabled={disabled} onClick={onReview}>核对并确认</Button>
        <Button variant="outline" onClick={onMore}>我还要补充</Button>
      </div>
    </div>
  );
}
