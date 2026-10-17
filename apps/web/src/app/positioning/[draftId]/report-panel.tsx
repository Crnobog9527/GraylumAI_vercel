/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { useRef, useState } from "react";
import { X } from "lucide-react";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { CHAT_ACTION, ChatNoticeList, type ChatNotice } from "@/components/chat/ChatInlineNotice";
import { profileTabHref } from "@/lib/profile-tabs";
import { ReportPaywallDialog } from "@/components/paywall/ReportPaywallDialog";
import resultStyles from "@/components/opc/positioning-result.module.css";
import {
  REPORT_ACTION, REPORT_INTRO, REPORT_TITLE, REPORT_WRITING_NOTICE, reportActionLabel, reportFeeText, reportView,
} from "./report-gen";
import { useReportGen } from "./use-report-gen";
import { useReportPaywallMemory } from "./report-paywall-memory";
import { STOP_SAVING_NOTICE, STOP_UNCONFIRMED_NOTICE } from "./stop-reply";
export { PublishFootnote, PublishNext, reportPublishes } from "./report-publish";
import { ReportDocumentPanel } from "./report-document-panel";
import { REPORT_DOC_TEXT } from "./report-document";
import { JuryEntry } from "@/components/fusion-review/JuryEntry";
import { REPORT_OUTLINE_MIN_CHAPTERS, ReportWithOutline } from "@/components/chat-display/report-outline";
import { useReportOutline } from "@/components/chat-display/use-report-outline";
import { ReportView } from "@/components/chat-display/report-view/report-view";
import { savedFormalReport, type FormalReport } from "./saved-report";

type Props = {
  draftId: string; sessionId: string; projectId: string; roundId: string; confirmed: boolean; busy: boolean;
  /** The formal version's report (opc.read): the jury entry next to this one, and its saved text (savedFormalReport). */
  report?: FormalReport;
  /** This round is published (a formal version), not a revision in progress. */
  published?: boolean;
  /** After 定稿: refresh the page and ask, explicitly, whether to start the first-week topics. */
  onTopics: () => void;
};

/**
 * The report entry of the positioning footer. A saved report of this round stays readable whatever
 * the switch or membership is now; a new paid start needs the switch on and every step confirmed.
 * With the switch off and no saved report, nothing renders, so the page is unchanged.
 */
export function ReportEntry(props: Props) {
  // A new round (修订) is a new report: remount so no state of the old round's report survives.
  return <RoundReportEntry key={props.projectId + ":" + props.roundId} {...props} />;
}

function RoundReportEntry(props: Props) {
  const available = trpc.runtime.reportAvailable.useQuery(undefined, { enabled: props.confirmed, staleTime: 60_000 });
  // A published round with a saved formal report (e.g. adopted from the jury) shows it; it never offers a new paid one.
  const saved = savedFormalReport(Boolean(props.published), props.report);
  const canGenerate = props.confirmed && available.data?.enabled === true && !saved;
  const report = useReportGen({ ...props, canGenerate: canGenerate, price: available.data?.priceCredits });
  const [open, setOpen] = useState(false);
  // A first start refused for membership opens the paywall (design v25 scene 1), also after leaving
  // and coming back in this tab. A saved report of this round keeps its own dialog.
  const paywall = useReportPaywallMemory({ draftId: props.draftId, roundId: props.roundId,
    refusedForMembership: Boolean(report.refusal?.membership), hasReport: Boolean(report.executionId || saved) });
  // The jury (FUSION-REVIEW) sits next to it: it reviews the report of the formal version, whatever this entry shows.
  const jury = <JuryEntry draftId={props.draftId} report={props.report} busy={props.busy} />;
  if (!report.executionId && !saved && (!canGenerate || report.refusal?.hideEntry)) return jury;
  return (
    <>
      <Button variant="outline" disabled={props.busy} onClick={() => setOpen(true)}>
        {report.executionId || saved ? REPORT_TITLE : reportActionLabel(REPORT_ACTION.start, available.data?.priceCredits)}
      </Button>
      {jury}
      {open && (paywall ? <ReportPaywallDialog onClose={() => setOpen(false)} />
        : <ReportDialog report={report} savedBody={report.executionId ? null : saved} busy={props.busy}
          price={available.data?.priceCredits} onClose={() => setOpen(false)}
          onTopics={() => { setOpen(false); props.onTopics(); }} />)}
    </>
  );
}

export function ReportDialog({ report, savedBody, busy, price, onClose, onTopics }:
  { report: ReturnType<typeof useReportGen>; savedBody?: string | null; busy: boolean; price?: number | null; onClose: () => void;
    onTopics: () => void }) {
  // Unsaved report edits live in the panel: closing asks first instead of dropping them silently.
  const unsaved = useRef(false);
  const [trackUnsaved] = useState(() => (value: boolean) => { unsaved.current = value; });
  // The card scrolls; the chapter list beside the text follows it (Owner 2026-10-17: show the chapters on the left).
  const card = useRef<HTMLDivElement>(null);
  const outline = useReportOutline(card);
  const close = () => { if (!unsaved.current || window.confirm(REPORT_DOC_TEXT.closeUnsaved)) onClose(); };
  const status = report.status;
  const view = status ? reportView(status) : null;
  const working = report.starting || report.streaming;
  const body = report.live?.text || (view && (view.kind === "report" || view.kind === "progress") ? view.body : null) || savedBody;
  const notices: ChatNotice[] = [];
  if (report.stopUnconfirmed) notices.push({ id: "report-stop-unconfirmed", tone: "warning", text: STOP_UNCONFIRMED_NOTICE,
    actions: [{ label: CHAT_ACTION.stop, onClick: report.retryStop }] });
  else if (report.live?.stopped) notices.push({ id: "report-stopping", tone: "status", busy: true, text: STOP_SAVING_NOTICE });
  else if (report.live) notices.push({ id: "report-live", tone: "status", busy: true, text: REPORT_WRITING_NOTICE,
    actions: [{ label: CHAT_ACTION.stop, onClick: report.stop }] });
  else if (report.starting) notices.push({ id: "report-starting", tone: "status", busy: true, text: REPORT_WRITING_NOTICE });
  else if (view?.kind === "progress") notices.push({ id: "report-progress", tone: "status", busy: true, text: view.notice });
  else if (view?.kind === "report") view.notices.forEach((text, index) => notices.push({ id: "report-note-" + index, tone: "warning", text }));
  else if (view?.kind === "empty") notices.push({ id: "report-empty", tone: "warning", text: view.notice });
  const charge = !report.live && !working ? reportFeeText(status?.fee) : null;
  if (charge) notices.push({ id: "report-fee", tone: "status", text: charge });
  if (status && view?.kind === "waiting") notices.push(...report.payg.turnNotices(status, busy || working));
  // An existing report still being written already says so; the "opened" line would only repeat it.
  const repeats = report.refusal?.opened && (view?.kind === "progress" || Boolean(report.live));
  if (report.refusal && !repeats) notices.push({ id: "report-refusal", tone: "warning", text: report.refusal.text,
    ...(report.refusal.membership ? { actions: [{ label: REPORT_ACTION.membership,
      onClick: () => void window.open(profileTabHref("subscription"), "_blank", "noopener") }] } : {}) });
  const first = !report.executionId && !savedBody;
  return (
    <div role="dialog" aria-modal="true" aria-label={REPORT_TITLE} tabIndex={-1}
      onKeyDown={event => { if (event.key === "Escape") close(); }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div ref={card} className={`${resultStyles.consentCard} ${outline.chapters.length >= REPORT_OUTLINE_MIN_CHAPTERS ? "!max-w-5xl" : "!max-w-3xl"}`}>
        <header>
          <h2>{REPORT_TITLE}</h2>
          <Button className={resultStyles.consentClose} variant="ghost" aria-label={"关闭" + REPORT_TITLE} onClick={close}>
            <X size={18} aria-hidden="true" />
          </Button>
        </header>
        {first && !working && <p>{REPORT_INTRO}</p>}
        <ReportWithOutline bodyRef={outline.bodyRef} chapters={outline.chapters} activeId={outline.activeId} onSelect={outline.select}>
          {/* A finished report (R5): its current version, editing and 定稿. While writing: the live text. */}
          {view?.kind === "report" && !report.live && report.executionId
            ? <ReportDocumentPanel key={report.executionId} executionId={report.executionId} fallbackBody={view.body}
              generatedComplete={view.candidate} busy={busy || working} onTopics={onTopics} onUnsaved={trackUnsaved} />
            : body && <ReportView className="mt-4" body={body} streaming={Boolean(report.live && !report.live.stopped)} />}
          <ChatNoticeList className="mt-4" notices={notices} />
          {report.offer && !savedBody && !report.refusal?.hideEntry && (
            <div className={resultStyles.consentActions}>
              <Button disabled={busy} onClick={report.offer === "start" ? report.start : report.restart}>
                {reportActionLabel(report.offer === "start" ? REPORT_ACTION.start : REPORT_ACTION.retry, price)}
              </Button>
            </div>
          )}
        </ReportWithOutline>
      </div>
    </div>
  );
}
