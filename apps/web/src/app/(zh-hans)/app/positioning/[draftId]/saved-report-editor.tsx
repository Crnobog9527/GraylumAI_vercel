/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ChatNoticeList, type ChatNotice } from "@/components/chat/ChatInlineNotice";
import resultStyles from "@/components/opc/positioning-result.module.css";
import {
  bodyFromEditor, editorChanged, editorText, hasDataFence, REPORT_DOC_TEXT, REPORT_MAX_CHARACTERS, reportLength, requestFor,
  type PendingRequest,
} from "./report-document";
import { clearDraft, readDraft, SAVED_EDIT_TEXT, savedEditError, writeDraft } from "./saved-report-edit";

type Props = {
  draftId: string; projectId: string;
  /** The formal version being edited: R14 only accepts an edit of the current one. */
  versionId: string;
  /** The saved report text (with its data block, if any). */
  body: string;
  /** What shows while not editing: the saved report as the page draws it. */
  view: ReactNode;
  busy: boolean;
  onUnsaved?: (unsaved: boolean) => void;
};

/**
 * Edit and 定稿 a saved formal report that has no generation behind it (a jury adoption's version, Owner 2026-10-20).
 * 定稿 = R14 propose (the whole edited body, no field changes) then apply: a new formal version, no model, no charge.
 */
export function SavedReportEditor({ draftId, projectId, versionId, body, view, busy, onUnsaved }: Props) {
  const utils = trpc.useUtils();
  const propose = trpc.runtime.reportRevisionPropose.useMutation();
  const apply = trpc.runtime.reportRevisionApply.useMutation();
  const original = editorText(body);
  const [draft, setDraft] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const proposed = useRef<PendingRequest | null>(null);
  const applied = useRef<PendingRequest | null>(null);
  const working = propose.isPending || apply.isPending;
  const unsaved = working || (draft !== null && draft !== original);
  useEffect(() => { onUnsaved?.(unsaved); }, [unsaved, onUnsaved]);
  useEffect(() => () => onUnsaved?.(false), [onUnsaved]);
  // A draft of this version is offered back after a closed page. Nothing is deleted here: a stale or cached view must not erase
  // another tab's newer draft; a draft is removed only once the server says its own source is stale (below) or it is finalized.
  useEffect(() => {
    const kept = readDraft(projectId, versionId);
    if (kept !== null && kept !== original) { setDraft(kept); setRestored(true); }
  }, [projectId, versionId, original]);
  const change = (text: string) => { setDraft(text); writeDraft(projectId, versionId, text); };
  const leave = () => { setDraft(null); setRestored(false); setAsking(false); setProblem(null); clearDraft(projectId, versionId); };

  const finalize = async () => {
    if (draft === null || working || !editorChanged({ body }, draft)) return;
    const text = bodyFromEditor({ body }, draft);
    const first = proposed.current = requestFor(proposed.current, [versionId, "propose", text], () => crypto.randomUUID());
    try {
      const revision = await propose.mutateAsync({ draftId, requestId: first.requestId, sourceVersionId: versionId, body: text, fields: {} });
      const second = applied.current = requestFor(applied.current, [revision.revisionId, revision.diffHash, "apply"], () => crypto.randomUUID());
      await apply.mutateAsync({ draftId, revisionId: revision.revisionId, requestId: second.requestId, expectedDiffHash: revision.diffHash });
      proposed.current = applied.current = null;
      clearDraft(projectId, versionId);
      setDraft(null); setAsking(false); setProblem(null); setDone(true);
      await utils.opc.read.invalidate({ draftId });
    } catch (cause) {
      const error = savedEditError(cause);
      // The server answered: this request is over, the next click is a new one. Unknown: retry the same request.
      if (error.known) { proposed.current = applied.current = null; }
      if (error.stale) { clearDraft(projectId, versionId); setDraft(null); }
      setAsking(false); setProblem(error.text);
    }
  };

  const notices: ChatNotice[] = [];
  if (done) notices.push({ id: "saved-report-done", tone: "success", text: SAVED_EDIT_TEXT.done });
  if (restored && draft !== null) notices.push({ id: "saved-report-restored", tone: "status", text: SAVED_EDIT_TEXT.restored });
  if (problem) notices.push({ id: "saved-report-problem", tone: "warning", text: problem });
  const length = draft === null ? 0 : reportLength(draft);
  const canFinalize = draft !== null && !working && editorChanged({ body }, draft) && draft.trim().length > 0
    && length <= REPORT_MAX_CHARACTERS && !hasDataFence(draft);
  return <>
    {draft === null ? view : <div className="mt-4 space-y-1">
      <Textarea aria-label="报告正文" rows={18} value={draft} disabled={working} onChange={event => change(event.target.value)} />
      <p className="text-xs text-[var(--text-secondary)]" aria-live="polite">
        {length} / {REPORT_MAX_CHARACTERS} 字{length > REPORT_MAX_CHARACTERS ? "，超出上限，删减后才能定稿" : ""}</p>
      {hasDataFence(draft) && <p className="text-xs" role="alert">{REPORT_DOC_TEXT.dataFence}</p>}
    </div>}
    <ChatNoticeList className="mt-4" notices={notices} />
    <div className={resultStyles.consentActions}>
      {asking ? <>
        <p>{SAVED_EDIT_TEXT.ask}</p>
        <Button disabled={busy || working || !canFinalize} onClick={() => void finalize()}>{SAVED_EDIT_TEXT.confirm}</Button>
        <Button variant="outline" disabled={working} onClick={() => setAsking(false)}>{SAVED_EDIT_TEXT.back}</Button>
      </> : draft !== null ? <>
        <Button disabled={busy || !canFinalize} onClick={() => { setProblem(null); setAsking(true); }}>{SAVED_EDIT_TEXT.save}</Button>
        <Button variant="outline" disabled={working} onClick={leave}>{SAVED_EDIT_TEXT.cancel}</Button>
      </> : <Button variant="outline" disabled={busy} onClick={() => { setProblem(null); setDone(false); setDraft(original); }}>
        {SAVED_EDIT_TEXT.edit}</Button>}
    </div>
  </>;
}
