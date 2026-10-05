/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { useState } from "react";
import { X } from "lucide-react";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { CHAT_ACTION, ChatNoticeList, type ChatNotice } from "@/components/chat/ChatInlineNotice";
import { profileTabHref } from "@/lib/profile-tabs";
import resultStyles from "@/components/opc/positioning-result.module.css";
import {
  REPORT_ACTION, REPORT_INTRO, REPORT_TITLE, REPORT_WRITING_NOTICE, reportCanStart, reportView,
} from "./report-gen";
import { useReportGen } from "./use-report-gen";

type Props = { draftId: string; sessionId: string; projectId: string; roundId: string; confirmed: boolean; busy: boolean };

/**
 * The report entry of the positioning footer. Hidden unless the server switch is on and every
 * step is confirmed, so with the switch off the page is unchanged.
 */
export function ReportEntry(props: Props) {
  const available = trpc.runtime.reportAvailable.useQuery(undefined, { enabled: props.confirmed, staleTime: 60_000 });
  const active = props.confirmed && available.data?.enabled === true;
  const report = useReportGen({ ...props, active });
  const [open, setOpen] = useState(false);
  if (!active || report.refusal?.hideEntry) return null;
  return (
    <>
      <Button variant="outline" disabled={props.busy} onClick={() => setOpen(true)}>
        {report.record?.executionId ? REPORT_TITLE : REPORT_ACTION.start}
      </Button>
      {open && <ReportDialog report={report} busy={props.busy} onClose={() => setOpen(false)} />}
    </>
  );
}

function ReportDialog({ report, busy, onClose }: { report: ReturnType<typeof useReportGen>; busy: boolean; onClose: () => void }) {
  const status = report.status;
  const view = status ? reportView(status) : null;
  const working = report.starting || report.streaming;
  const body = report.live?.text || (view && (view.kind === "report" || view.kind === "progress") ? view.body : null);
  const notices: ChatNotice[] = [];
  if (report.live) notices.push({ id: "report-live", tone: "status", busy: !report.live.stopped, text: REPORT_WRITING_NOTICE,
    ...(report.live.stopped ? {} : { actions: [{ label: CHAT_ACTION.stop, onClick: report.stop }] }) });
  else if (report.starting) notices.push({ id: "report-starting", tone: "status", busy: true, text: REPORT_WRITING_NOTICE });
  else if (view?.kind === "progress") notices.push({ id: "report-progress", tone: "status", busy: true, text: view.notice });
  else if (view?.kind === "report") view.notices.forEach((text, index) => notices.push({ id: "report-note-" + index, tone: "warning", text }));
  else if (view?.kind === "empty") notices.push({ id: "report-empty", tone: "warning", text: view.notice });
  if (status && view?.kind === "waiting") notices.push(...report.payg.turnNotices(status, busy || working));
  if (report.refusal) notices.push({ id: "report-refusal", tone: "warning", text: report.refusal.text,
    ...(report.refusal.membership ? { actions: [{ label: REPORT_ACTION.membership,
      onClick: () => void window.open(profileTabHref("subscription"), "_blank", "noopener") }] } : {}) });
  // A record without a saved execution is a start whose answer was lost: the same request is sent again.
  const first = !report.record?.executionId;
  const canStart = !working && (first || (status !== null && reportCanStart(status)));
  return (
    <div role="dialog" aria-modal="true" aria-label={REPORT_TITLE} tabIndex={-1}
      onKeyDown={event => { if (event.key === "Escape") onClose(); }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className={`${resultStyles.consentCard} !max-w-3xl`}>
        <header>
          <h2>{REPORT_TITLE}</h2>
          <Button className={resultStyles.consentClose} variant="ghost" aria-label="关闭完整报告" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </Button>
        </header>
        {first && !working && <p>{REPORT_INTRO}</p>}
        {body && <MessageMarkdown className="mt-4" text={body} streaming={Boolean(report.live && !report.live.stopped)} />}
        <ChatNoticeList className="mt-4" notices={notices} />
        {canStart && (
          <div className={resultStyles.consentActions}>
            <Button disabled={busy} onClick={first ? report.start : report.restart}>
              {first ? REPORT_ACTION.start : REPORT_ACTION.retry}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
