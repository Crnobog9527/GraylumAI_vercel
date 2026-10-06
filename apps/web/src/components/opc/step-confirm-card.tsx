/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { Button } from "@/components/ui/button";
import styles from "./capture-checklist.module.css";
import { editedLocally, fieldMeta, fieldState, hasContent, needsLook, shownValue, stepProgress, type FieldValue, type StepInformation } from "./capture-state";

export type ConfirmCardRow = { id: string; title: string; text: string; look: boolean; state: ReturnType<typeof fieldState> };
export type ConfirmCardModel = {
  ready: boolean;
  rows: ConfirmCardRow[];
  /** Fields to glance at: content the AI organized or suggested, not yet confirmed. */
  look: string[];
  missing: { id: string; title: string }[];
  /** Pending "根据对话整理的更新" in this step; they are not part of a confirmation. */
  updates: number;
};


/**
 * What the step's confirmation card shows, every filled value in full. A field the user has edited locally reads as theirs,
 * whatever the server recorded before. Uses existing data only (status, source, Skill role); the
 * server's own readiness signal can replace `ready` later without changing the card.
 */
export function confirmCardModel(info: StepInformation | undefined, edits?: Record<string, FieldValue>): ConfirmCardModel {
  const progress = stepProgress(info, edits);
  const rows = (info?.schema ?? []).filter(field => hasContent(shownValue(info, edits, field.id))).map(field => {
    const value = shownValue(info, edits, field.id);
    const look = !editedLocally(info, edits, field.id) && needsLook(value, field, fieldMeta(info, field.id));
    // The whole value: one click confirms exactly what the card shows, never an unseen remainder.
    return { id: field.id, title: field.title, text: value.value.trim(), look, state: fieldState(value) };
  });
  return { ready: progress.ready, rows, look: rows.filter(row => row.look).map(row => row.id),
    missing: progress.missingRequired.map(field => ({ id: field.id, title: field.title })), updates: progress.updates };
}

export type StepConfirmCardProps = {
  title: string;
  model: ConfirmCardModel;
  /** A step confirmation already started; the button continues it. */
  resuming: boolean;
  disabled: boolean;
  /** The step may be confirmed now: upstream steps confirmed, no reply running. */
  canConfirm: boolean;
  /** One click: confirm exactly what is shown (snapshot and upstream checks still apply). */
  onConfirm: () => void;
  /** Highlight the fields to change in the right checklist. */
  onEdit: (fieldIds: string[]) => void;
  /** The full review: edit everything, or defer a required item with a written reason. */
  onReview: () => void;
};

/** The one confirmation card of a step, pinned above the message box until the step is confirmed. */
export function StepConfirmCard({ title, model, resuming, disabled, canConfirm, onConfirm, onEdit, onReview }: StepConfirmCardProps) {
  // Nothing recorded yet: the conversation has just started, no card.
  if (!model.ready && !model.rows.length && !resuming) return null;
  if (!model.ready && !resuming) return (
    <section className={styles.confirmCard} aria-label="本步确认">
      <p>“{title}”还差：{model.missing.map(field => field.title).join("、")}。可以继续和导师聊，或在右侧直接填写。</p>
      <div>
        <Button variant="outline" disabled={disabled} onClick={() => onEdit(model.missing.map(field => field.id))}>去右侧补充</Button>
        <button type="button" className={styles.linkButton} disabled={disabled} onClick={onReview}>暂时无法确定，写原因暂缓</button>
      </div>
    </section>
  );
  return (
    <section className={styles.confirmCard} aria-label="本步确认">
      <p>{resuming ? `“${title}”的确认还没完成，点一下继续。` : `“${title}”的信息齐了，请看一眼再确认：`}</p>
      <ul>{model.rows.map(row => <li key={row.id} data-look={row.look || undefined}><span>{row.title}</span>
        {row.state === "deferred" ? "（暂缓）" : ""}{row.text}</li>)}</ul>
      {model.look.length > 0 && <p>标出“请看一眼”的是根据对话整理或导师建议的内容，你自己填写的不用再看。</p>}
      {model.updates > 0 && <p>还有 {model.updates} 条“根据对话整理的更新”没处理，它们不会被确认，确认后仍可采用。</p>}
      <div>
        <Button disabled={disabled || !canConfirm} onClick={onConfirm}>{resuming ? "继续完成确认" : "没问题，进入下一步"}</Button>
        <Button variant="outline" disabled={disabled} onClick={() => onEdit(model.look.length ? model.look : model.rows.map(row => row.id))}>我要改</Button>
        <button type="button" className={styles.linkButton} disabled={disabled} onClick={onReview}>逐项核对或暂缓</button>
      </div>
    </section>
  );
}

/** Bring the first field to change into view in the right checklist and put the cursor in it. */
export function focusChecklistField(stepId: string, fieldId: string | undefined) {
  if (!fieldId || typeof document === "undefined") return;
  requestAnimationFrame(() => {
    const field = document.getElementById(`${stepId}-${fieldId}`);
    field?.scrollIntoView({ block: "center", behavior: "smooth" });
    field?.focus({ preventScroll: true });
  });
}
