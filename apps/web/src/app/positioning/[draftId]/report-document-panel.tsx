/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { useRef, useState } from "react";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { ChatNoticeList, type ChatNotice } from "@/components/chat/ChatInlineNotice";
import resultStyles from "@/components/opc/positioning-result.module.css";
import {
  canFinalize, canSave, finalizedNotice, REPORT_DOC_TEXT, REPORT_MAX_CHARACTERS, reportDocumentError, reportLength, requestFor,
  type PendingRequest, type ReportDocument,
} from "./report-document";

type Props = {
  executionId: string;
  /** The generated text from `reportStatus`, shown until the document is read. */
  fallbackBody: string;
  /** `reportStatus` already said the generated report is complete (its own notices cover the other cases). */
  generatedComplete: boolean;
  busy: boolean;
  /** 定稿 succeeded with a next step: the page asks, explicitly, whether to start the first-week topics. */
  onTopics: () => void;
};

/** Codes after which the shown document is out of date: read it again, keep the user's text. */
const REREAD = new Set(["REPORT_VERSION_CONFLICT", "REPORT_ALREADY_FINALIZED", "REPORT_SOURCE_CONFLICT", "REPORT_NOT_COMPLETE"]);

/**
 * The finished report (R5): read the current version, edit it as a manual version, and 定稿 it into the
 * official positioning version. Nothing here calls a model or charges; the server checks every step.
 */
export function ReportDocumentPanel({ executionId, fallbackBody, generatedComplete, busy, onTopics }: Props) {
  const utils = trpc.useUtils();
  const read = trpc.runtime.reportDocument.useQuery({ executionId }, { retry: 1 });
  const save = trpc.runtime.reportSave.useMutation();
  const finalize = trpc.runtime.reportFinalize.useMutation();
  /** The text being edited; null while reading. Kept on every failure. */
  const [draft, setDraft] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const pending = useRef<PendingRequest | null>(null);
  const doc = read.data as ReportDocument | undefined;
  const working = save.isPending || finalize.isPending;

  if (!doc) return <>
    <MessageMarkdown className="mt-4" text={fallbackBody} />
    {read.isError && <ChatNoticeList className="mt-4" notices={[{ id: "report-doc-load", tone: "warning", text: REPORT_DOC_TEXT.loadFailed }]} />}
  </>;

  const settle = (next: ReportDocument) => {
    pending.current = null;
    setProblem(null);
    utils.runtime.reportDocument.setData({ executionId }, next as never);
  };
  const fail = async (cause: unknown) => {
    const error = reportDocumentError(cause);
    // The server answered: this request is over, the next click is a new one. Unknown: retry the same request.
    if (error.known) pending.current = null;
    setProblem(error.text);
    if (REREAD.has(error.code)) await read.refetch();
  };
  const submitSave = async () => {
    if (draft === null || !canSave(doc, draft) || working) return;
    const request = pending.current = requestFor(pending.current, [executionId, "save", doc.revision, draft], () => crypto.randomUUID());
    try {
      settle(await save.mutateAsync({ executionId, requestId: request.requestId, expectedRevision: doc.revision, body: draft }) as ReportDocument);
      setDraft(null);
    } catch (cause) { await fail(cause); }
  };
  const submitFinalize = async () => {
    if (!canFinalize(doc, draft !== null) || working) return;
    const request = pending.current = requestFor(pending.current, [executionId, "finalize", doc.revision, doc.bodyHash],
      () => crypto.randomUUID());
    try {
      const next = await finalize.mutateAsync({ executionId, requestId: request.requestId, expectedRevision: doc.revision,
        expectedBodyHash: doc.bodyHash }) as ReportDocument;
      settle(next);
      setAsking(false);
      if (next.next) onTopics();
    } catch (cause) { setAsking(false); await fail(cause); }
  };

  const notices: ChatNotice[] = [];
  if (doc.finalized) notices.push({ id: "report-finalized", tone: "success", text: finalizedNotice(doc.version),
    ...(doc.next ? { actions: [{ label: REPORT_DOC_TEXT.topics, onClick: onTopics, disabled: busy }] } : {}) });
  if (doc.manuallyEdited) notices.push({ id: "report-edited", tone: "status", text: `${REPORT_DOC_TEXT.edited}。${REPORT_DOC_TEXT.editedScope}` });
  // The generated report was complete; only the edited text can make it not finalizable.
  if (!doc.finalized && !doc.candidate && generatedComplete && draft === null)
    notices.push({ id: "report-not-final", tone: "warning", text: REPORT_DOC_TEXT.notFinalizable });
  if (problem) notices.push({ id: "report-doc-problem", tone: "warning", text: problem });
  const length = draft === null ? 0 : reportLength(draft);
  return <>
    {draft === null ? <MessageMarkdown className="mt-4" text={doc.body} />
      : <div className="mt-4 space-y-1">
        <Textarea aria-label="报告正文" rows={18} value={draft} disabled={working} onChange={event => setDraft(event.target.value)} />
        <p className="text-xs text-[var(--text-secondary)]" aria-live="polite">
          {length} / {REPORT_MAX_CHARACTERS} 字{length > REPORT_MAX_CHARACTERS ? "，超出上限，删减后才能保存" : ""}</p>
      </div>}
    <ChatNoticeList className="mt-4" notices={notices} />
    {!doc.finalized && <div className={resultStyles.consentActions}>
      {asking ? <>
        <p>{REPORT_DOC_TEXT.finalizeAsk}</p>
        <Button disabled={busy || working} onClick={() => void submitFinalize()}>{REPORT_DOC_TEXT.finalizeConfirm}</Button>
        <Button variant="outline" disabled={working} onClick={() => setAsking(false)}>{REPORT_DOC_TEXT.finalizeBack}</Button>
      </> : draft !== null ? <>
        <Button disabled={busy || working || !canSave(doc, draft)} onClick={() => void submitSave()}>{REPORT_DOC_TEXT.save}</Button>
        <Button variant="outline" disabled={working} onClick={() => { setDraft(null); setProblem(null); }}>{REPORT_DOC_TEXT.cancel}</Button>
      </> : <>
        <Button disabled={busy || working || !canFinalize(doc, false)} onClick={() => { setProblem(null); setAsking(true); }}>
          {REPORT_DOC_TEXT.finalize}</Button>
        <Button variant="outline" disabled={busy || working} onClick={() => { setProblem(null); setDraft(doc.body); }}>
          {REPORT_DOC_TEXT.edit}</Button>
      </>}
    </div>}
  </>;
}
