/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { useRef, useState } from "react";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { finalizedNotice, REPORT_DOC_TEXT, type ReportDocument } from "./report-document";
import { downloadReport, REPORT_EXPORT_TEXT as T, reportExportMarkdown, type ReportExportSource } from "./report-export";

type Props =
  /** A generated report: its current version (edits included) is read from the server when the button is clicked. */
  | { executionId: string; notes: string[]; saved?: undefined }
  /** A saved formal version with no generation behind it (a jury adoption): exported as shown. */
  | { executionId?: undefined; notes?: undefined; saved: ReportExportSource };

/**
 * 导出报告 next to the report (MASTER_PLAN §2.1 item 50). No membership check and no charge: a saved report stays
 * exportable whatever the membership is now. The download is built in the browser from the server's own read.
 */
export function ReportExport(props: Props) {
  const utils = trpc.useUtils();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  const exportNow = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice("");
    try {
      let source = props.saved;
      if (!source) {
        // Always the server's current version, never a cached one: an edit saved in another tab is included.
        const doc = await utils.client.runtime.reportDocument.query({ executionId: props.executionId! }) as ReportDocument;
        source = { body: doc.body, strategy: doc.strategy, notes: [...(props.notes ?? []),
          ...(doc.finalized ? [finalizedNotice(doc.version)] : []), ...(doc.manuallyEdited ? [REPORT_DOC_TEXT.edited] : [])] };
      }
      downloadReport(reportExportMarkdown(source));
      setNotice(T.done);
    } catch {
      setNotice(T.failed);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return <div className="mt-4 flex flex-wrap items-center gap-2">
    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void exportNow()}>
      {busy ? T.reading : T.action}
    </Button>
    {notice && <span role="status" className="text-sm">{notice}</span>}
  </div>;
}
