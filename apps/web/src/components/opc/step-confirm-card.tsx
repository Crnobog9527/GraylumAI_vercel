/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { Button } from "@/components/ui/button";
import styles from "./capture-checklist.module.css";
import { editedLocally, fieldMeta, fieldState, hasContent, needsLook, shownValue, stepProgress, type FieldValue, type StepInformation } from "./capture-state";

export type ConfirmCardRow = { id: string; title: string; text: string; look: boolean; state: ReturnType<typeof fieldState> };
/** The server's per-step confirmation signal (opc.read `stepConfirmation`, #713). Display only, never a permission. */
export type StepSignal = { requiredComplete: boolean; stepConfirmed: boolean; stepReady: boolean; needsLookFieldIds: string[] };
/** "stale": the cached values are newer than this signal (a save was applied locally; the next read refreshes it). */
export function readStepSignal(raw: unknown): StepSignal | "stale" | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (value.stale === true) return "stale";
  if (typeof value.requiredComplete !== "boolean" || typeof value.stepConfirmed !== "boolean" || typeof value.stepReady !== "boolean" ||
      !Array.isArray(value.needsLookFieldIds) || !value.needsLookFieldIds.every(id => typeof id === "string")) return undefined;
  return { requiredComplete: value.requiredComplete, stepConfirmed: value.stepConfirmed, stepReady: value.stepReady,
    needsLookFieldIds: value.needsLookFieldIds as string[] };
}

export type ConfirmCardModel = {
  ready: boolean;
  /** The shown readiness and marks are current: no local edit is newer than the server's signal. */
  current: boolean;
  rows: ConfirmCardRow[];
  /** Fields to glance at: content the AI organized or suggested, not yet confirmed. */
  look: string[];
  missing: { id: string; title: string }[];
  /** Pending "根据对话整理的更新" in this step; they are not part of a confirmation. */
  updates: number;
};


/**
 * What the step's confirmation card shows, every filled value in full. The server's signal (#713) decides readiness and
 * the fields to look at; while a local edit is newer than that signal, or for a server without it, the same rules are
 * derived locally and the card is not `current`. A field the user has edited locally reads as theirs.
 */
export function confirmCardModel(info: StepInformation | undefined, edits?: Record<string, FieldValue>,
  signal?: StepSignal | "stale"): ConfirmCardModel {
  const progress = stepProgress(info, edits);
  const edited = (info?.schema ?? []).some(field => editedLocally(info, edits, field.id));
  const server = signal && signal !== "stale" && !edited ? signal : undefined;
  const rows = (info?.schema ?? []).filter(field => hasContent(shownValue(info, edits, field.id))).map(field => {
    const value = shownValue(info, edits, field.id);
    // A stale signal's provenance may be stale too: no marks until the next read.
    const look = server ? server.needsLookFieldIds.includes(field.id) : signal !== "stale" &&
      !editedLocally(info, edits, field.id) && needsLook(value, field, fieldMeta(info, field.id));
    // The whole value: one click confirms exactly what the card shows, never an unseen remainder.
    return { id: field.id, title: field.title, text: value.value.trim(), look, state: fieldState(value) };
  });
  return { ready: server ? server.stepReady : progress.ready, current: Boolean(server) || (!signal && !edited),
    rows, look: rows.filter(row => row.look).map(row => row.id),
    missing: progress.missingRequired.map(field => ({ id: field.id, title: field.title })), updates: progress.updates };
}

export type StepConfirmCardProps = {
  title: string;
  info: StepInformation | undefined;
  /** The step's unsaved local edits. */
  edits?: Record<string, FieldValue>;
  /** opc.read `stepConfirmation[stepId]`, unparsed. */
  signal?: unknown;
  /** A step confirmation already started; the button continues it. */
  resuming: boolean;
  disabled: boolean;
  /** An account revision confirms the edited step and stays on it; the button must not promise the next step. */
  revision?: boolean;
  /** The step may be confirmed now: upstream steps confirmed, no reply running. */
  canConfirm: boolean;
  /** One click: confirm exactly what is shown (snapshot and upstream checks still apply). */
  onConfirm: () => void;
  /** Highlight the fields to change in the right checklist. */
  onEdit: (fieldIds: string[]) => void;
  /** The full review: edit everything, or defer a required item with a written reason. Locked like the confirmation. */
  onReview: () => void;
};

/** The one confirmation card of a step, pinned above the message box until the step is confirmed. */
export function StepConfirmCard({ title, info, edits, signal, resuming, disabled, revision, canConfirm, onConfirm, onEdit, onReview }:
  StepConfirmCardProps) {
  const model = confirmCardModel(info, edits, readStepSignal(signal));
  // Never confirm from a stale signal: wait for the edit to save and the read to refresh.
  const confirmNow = canConfirm && (resuming || model.current);
  // Nothing recorded yet: the conversation has just started, no card.
  if (!model.ready && !model.rows.length && !resuming) return null;
  if (!model.ready && !resuming) return (
    <section className={styles.confirmCard} aria-label="本步确认">
      <p>“{title}”还差：{model.missing.map(field => field.title).join("、")}。可以继续和导师聊，或在右侧直接填写。</p>
      <div>
        <Button variant="outline" disabled={disabled} onClick={() => onEdit(model.missing.map(field => field.id))}>去右侧补充</Button>
        <button type="button" className={styles.linkButton} disabled={disabled || !canConfirm} onClick={onReview}>暂时无法确定，写原因暂缓</button>
      </div>
    </section>
  );
  return (
    <section className={styles.confirmCard} aria-label="本步确认">
      <p>{resuming ? `“${title}”的确认还没完成，点一下继续。` : `“${title}”的信息齐了，请看一眼再确认：`}</p>
      <ul>{model.rows.map(row => <li key={row.id} data-look={row.look || undefined}><span>{row.title}</span>
        {row.state === "deferred" ? "（暂缓）" : ""}{row.text}</li>)}</ul>
      {model.look.length > 0 && <p>标出“请看一眼”的是根据对话整理或导师建议的内容，你自己填写的不用再看。</p>}
      {!model.current && !resuming && <p>刚改过的内容正在保存和刷新，完成后就可以确认。</p>}
      {model.updates > 0 && <p>还有 {model.updates} 条“根据对话整理的更新”没处理，它们不会被确认，确认后仍可采用。</p>}
      <div>
        <Button disabled={disabled || !confirmNow} onClick={onConfirm}>{resuming ? "继续完成确认" : revision ? "没问题，确认这一步的修改" : "没问题，进入下一步"}</Button>
        <Button variant="outline" disabled={disabled} onClick={() => onEdit(model.look.length ? model.look : model.rows.map(row => row.id))}>我要改</Button>
        {/* Resuming runs the retained confirmation; the review would resume it too, so it is not offered. */}
        {!resuming && <button type="button" className={styles.linkButton} disabled={disabled || !canConfirm} onClick={onReview}>逐项核对或暂缓</button>}
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
