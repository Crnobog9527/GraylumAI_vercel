/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ChatInlineNotice, CHAT_ACTION } from "@/components/chat/ChatInlineNotice";
import styles from "./capture-checklist.module.css";
import {
  editedLocally, fieldMeta, fieldOrigin, fieldState, fieldStateLabel, needsReview, shownValue, stepProgress,
  type CaptureSuggestion, type FieldValue, type StepInformation,
} from "./capture-state";

type Step = { id: string; title: string };
export type ConfirmationState = "none" | "valid" | "malformed";
export type ResolveAction = "accept" | "ignore" | "dismiss";

export type CaptureChecklistProps = {
  steps: readonly Step[];
  information: Record<string, StepInformation>;
  valid: Record<string, boolean>;
  edits: Record<string, Record<string, FieldValue>>;
  selectedStepId: string;
  /** The round is still a draft: fields can be edited and updates resolved. */
  editable: boolean;
  /** Structured entry without the mentor: explain each field's kind. */
  manual: boolean;
  /** Something else is running; every action waits. */
  locked: boolean;
  /** The step may be confirmed now (its dependencies are confirmed). */
  confirmable: (stepId: string) => boolean;
  confirmation: (stepId: string) => ConfirmationState;
  saveState: Record<string, "idle" | "saving" | "saved" | "error">;
  conflicts: Record<string, { current: Record<string, FieldValue>; fields: string[] }>;
  /** Field ids the confirmation card asked the user to look at (“我要改”). */
  highlight?: { stepId: string; fieldIds: readonly string[] };
  /** `stepId:fieldId` of the update being adopted or ignored. */
  resolving: string | null;
  onEdit: (stepId: string, fieldId: string, value: string) => void;
  onComposition: (stepId: string, composing: boolean) => void;
  onResolve: (stepId: string, fieldId: string, suggestion: CaptureSuggestion, action: ResolveAction) => void;
  onReview: (stepId: string) => void;
  onRecoverConfirmation: (stepId: string) => void;
  onKeepConflict: (stepId: string) => void;
  onRetrySave: (stepId: string) => void;
};

function stepStatus(props: CaptureChecklistProps, step: Step) {
  const info = props.information[step.id];
  if (props.valid[step.id]) return "已确认";
  if (needsReview(info, false)) return "需要复核";
  if (step.id === props.selectedStepId) return "进行中";
  const captured = stepProgress(info).captured;
  return captured ? `已从对话里记下 ${captured} 项` : "未开始";
}

function SuggestionBox({ props, step, fieldId, current, suggestion }: {
  props: CaptureChecklistProps; step: Step; fieldId: string; current: FieldValue; suggestion: CaptureSuggestion;
}) {
  const busy = props.locked || !props.editable || props.confirmation(step.id) !== "none" ||
    props.resolving === step.id + ":" + fieldId;
  return (
    <div className={styles.update} role="group" aria-label="根据对话整理的更新">
      <p className={styles.updateTitle}>根据对话整理的更新</p>
      <dl>
        <dt>原来</dt><dd>{current.value.trim() || "（空）"}</dd>
        <dt>更新</dt><dd>{suggestion.value}</dd>
      </dl>
      <div className={styles.updateActions}>
        <Button disabled={busy} onClick={() => props.onResolve(step.id, fieldId, suggestion, "accept")}>采用</Button>
        <Button variant="outline" disabled={busy} onClick={() => props.onResolve(step.id, fieldId, suggestion, "ignore")}>忽略</Button>
      </div>
      <p className={styles.note}>
        {props.valid[step.id] ? "这一步已确认：采用后这一步会回到草稿，需要重新确认。" : "采用前原内容保持不变。"}
      </p>
    </div>
  );
}

/** The mentor withdrew a pending update after the user rejected it; the field's own content never changed. */
function WithdrawnBox({ props, step, fieldId, withdrawn }: {
  props: CaptureChecklistProps; step: Step; fieldId: string; withdrawn: CaptureSuggestion;
}) {
  const busy = props.locked || !props.editable || props.resolving === step.id + ":" + fieldId;
  return (
    <div className={styles.update} data-withdrawn role="group" aria-label="导师已撤回建议">
      <p className={styles.updateTitle}>导师已撤回建议</p>
      <p className={styles.withdrawnValue}>{withdrawn.value}</p>
      <p className={styles.note}>你在对话里否定了这条建议，正式内容没有改动。</p>
      <div className={styles.updateActions}>
        <Button variant="outline" disabled={busy} onClick={() => props.onResolve(step.id, fieldId, withdrawn, "dismiss")}>知道了</Button>
      </div>
    </div>
  );
}

function StepFields({ props, step }: { props: CaptureChecklistProps; step: Step }) {
  const info = props.information[step.id];
  const edits = props.edits[step.id];
  const confirmation = props.confirmation(step.id);
  const progress = stepProgress(info, edits);
  const conflict = props.conflicts[step.id];
  return (
    <div className={styles.fields}>
      {(info?.schema ?? []).map(field => {
        const value = shownValue(info, edits, field.id);
        const meta = fieldMeta(info, field.id);
        const state = fieldState(value);
        return (
          <div key={field.id} className={styles.field} data-field-state={state}
            data-highlight={(props.highlight?.stepId === step.id && !props.valid[step.id] && props.highlight.fieldIds.includes(field.id)) || undefined}
            data-origin={editedLocally(info, edits, field.id) ? "user" : fieldOrigin(field, meta)}>
            <div className={styles.fieldHead}>
              <label htmlFor={`${step.id}-${field.id}`}>{field.title}<small>{field.required ? "必需" : "选填"}</small></label>
              <span className={styles.state}>
                {editedLocally(info, edits, field.id) && state === "draft" ? "草稿 · 你填写的" : fieldStateLabel(value, meta, field)}</span>
            </div>
            {props.manual && <p className={styles.hint}>{field.elicitation === "agent_proposal"
              ? "这是导师要给出的成果建议：可以先请导师提出草案，你核对、修改即可。"
              : "这是你自己的事实：请按真实情况填写，导师不会替你编造。"}</p>}
            <Textarea id={`${step.id}-${field.id}`} aria-label={field.title} maxLength={400}
              className="min-h-20 resize-none" placeholder={state === "missing" ? "还没聊到，也可以直接在这里填写" : undefined}
              disabled={!props.editable || confirmation !== "none"} value={value.value}
              onCompositionStart={() => props.onComposition(step.id, true)}
              onCompositionEnd={() => props.onComposition(step.id, false)}
              onChange={event => props.onEdit(step.id, field.id, event.target.value)}/>
            {meta.suggestion && <SuggestionBox props={props} step={step} fieldId={field.id} current={value} suggestion={meta.suggestion}/>}
            {!meta.suggestion && meta.withdrawn && <WithdrawnBox props={props} step={step} fieldId={field.id} withdrawn={meta.withdrawn}/>}
          </div>
        );
      })}
      {conflict && <div role="alert" className={styles.alert}>
        <p>其他窗口修改了相同字段。你的输入未提交，请比较后决定。</p>
        {conflict.fields.map(id => <p key={id}>{info?.schema.find(f => f.id === id)?.title ?? id}：服务器「{conflict.current[id]?.value ?? ""}」；
          你的输入「{edits?.[id]?.value ?? ""}」</p>)}
        <Button onClick={() => props.onKeepConflict(step.id)}>保留我的这些修改并重新保存</Button>
      </div>}
      {props.saveState[step.id] === "error" && <ChatInlineNotice tone="warning" label="自动保存失败"
        actions={[{ label: CHAT_ACTION.retry, disabled: confirmation !== "none", onClick: () => props.onRetrySave(step.id) }]}>
        自动保存失败，内容仍保留在本机。</ChatInlineNotice>}
      {confirmation === "malformed" && <ChatInlineNotice tone="warning"
        actions={[{ label: CHAT_ACTION.retry, disabled: props.locked, onClick: () => props.onRecoverConfirmation(step.id) }]}>
        上次的确认请求无法读取，确认结果未知。原始记录已在本机保留。重试会先读取服务器状态，再允许你重新核对这一步，不会当作已确认通过。
      </ChatInlineNotice>}
      {props.editable && <footer className={styles.stepFooter}>
        {confirmation === "valid" ? <>
          <p role="status">上次的确认还没完成。继续会复用原请求，不会重复执行或重复扣费。</p>
          <Button disabled={props.locked} onClick={() => props.onReview(step.id)}>继续完成确认</Button>
        </> : props.valid[step.id] ? <p role="status">这一步已确认。修改任何一项都会让它回到草稿，需要重新确认。</p>
          : <>
            <p role="status">{progress.ready ? "必需信息都有内容了，请核对后确认这一步。"
              : `还差 ${progress.missingRequired.length} 项必需信息：${progress.missingRequired.map(f => f.title).join("、")}`}</p>
            {progress.ready && props.confirmable(step.id) && <Button disabled={props.locked || confirmation !== "none"}
              onClick={() => props.onReview(step.id)}>确认这一步</Button>}
          </>}
      </footer>}
    </div>
  );
}

/** A light status that never blocks editing: unsaved edits read as saving until their save settles. */
export function saveLabel(state: CaptureChecklistProps["saveState"][string] | undefined, unsaved: boolean) {
  if (state === "error") return "自动保存失败";
  if (state === "saving" || unsaved) return "保存中…";
  return state === "saved" ? "已保存 ✓" : null;
}

/** The right panel: every step's checklist, filled from the conversation and confirmed once per step. */
export function CaptureChecklist(props: CaptureChecklistProps) {
  return (
    <div className={styles.list} aria-label="定位清单">
      {props.steps.map((step, index) => {
        const selected = step.id === props.selectedStepId;
        const saving = saveLabel(props.saveState[step.id], Boolean(props.edits[step.id]));
        return (
          <details key={step.id} open={selected} className={styles.step}>
            <summary>
              <span>{index + 1}. {step.title}</span>
              <small>{stepStatus(props, step)}</small>
            </summary>
            {selected && saving && <p role="status" className={styles.saving}>{saving}</p>}
            <StepFields props={props} step={step}/>
          </details>
        );
      })}
    </div>
  );
}
