/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { useMemo, useState } from "react";
import { REPORT_DATA_CHAPTER, REPORT_DATA_FIELDS, type ReportDataField } from "@repo/api/src/shared/reportDataSpec";
import { parseReportBody, type ReportData, type SanitizedReportData } from "@repo/api/src/shared/reportData";
import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { cn } from "@/lib/utils";
import { AudienceCards, FirstStepCard, FunnelChart, Plan30Timeline, ThisWeekList } from "./report-charts";
import { BenchmarkChart } from "./report-benchmarks";
import { ReportDataBlock, ReportDataFallback } from "./report-data-table";
import { placeFields, presentFields, reportChapterName, splitChapters, splitReasons } from "./report-sections";
import { REPORT_FIXED_NOTES, REPORT_VIEW_TEXT as T } from "./report-text";
import styles from "./report-view.module.css";

/**
 * The report as people read it (REPORT-VISUAL §4): "30 秒看懂" on top, then each `##` chapter with its
 * conclusion, its charts and tables from the strategy data, its reasons folded, and the page's fixed notes.
 * A report without strategy data (older Skills, or a data block that did not survive) renders exactly as
 * before: the whole text. Display only: no queries, so the product dialog and the landing page share it.
 * Chapter titles are `h2`, so the chapter list beside it (use-report-outline) finds them as it always did.
 */

type Props = {
  /** The stored report body, data block included (it is never shown as text). */
  body: string;
  /** The text is still arriving. */
  streaming?: boolean;
  /** Data the server already checked (and filled with benchmark numbers); omitted: checked here from `body`. */
  data?: SanitizedReportData | null;
  /** Fields whose chapter text the user changed after it was written: their charts say so. */
  editedFields?: readonly string[];
  className?: string;
};

/** Chapters that get a chart: while the data is still being written they say "整理中". */
const CHART_FIELDS: ReportDataField[] = ["thisWeek", "audience", "benchmarks", "funnel", "plan30"];

export function ReportView({ body, streaming = false, data, editedFields, className }: Props) {
  const parsed = useMemo(() => parseReportBody(body), [body]);
  const checked = data === undefined ? parsed.data : data;
  const { preamble, chapters } = useMemo(() => splitChapters(parsed.text), [parsed.text]);
  if ((!checked && !parsed.pending) || chapters.length === 0)
    return <MessageMarkdown className={className} text={parsed.text} streaming={streaming} />;

  const values = checked?.data ?? {};
  const fallback = checked?.fallback ?? {};
  const present = [...new Set([...presentFields(values), ...(Object.keys(fallback) as ReportDataField[])])]
    .filter(field => field !== "summary");
  const { byChapter, unplaced } = placeFields(values, chapters.map(chapter => chapter.title), present);
  const field = (name: ReportDataField) => <ReportField key={name} name={name} data={values} fallback={fallback[name]} />;
  const edited = new Set(editedFields);
  return (
    <div className={cn(styles.view, className)}>
      <QuickLook data={values} />
      {preamble && <MessageMarkdown text={preamble} />}
      {chapters.map((chapter, index) => {
        const fields = byChapter.get(index) ?? [];
        const name = reportChapterName(chapter.title);
        const { main, reasons } = splitReasons(chapter.body);
        const last = index === chapters.length - 1;
        const charted = name ? CHART_FIELDS.some(item => REPORT_DATA_CHAPTER[item] === name) : false;
        return (
          <section key={index} className={styles.chapter}>
            <h2 className={styles.chapterTitle}>{chapter.title}</h2>
            {main && <MessageMarkdown text={main} streaming={streaming && last && !reasons} />}
            {fields.some(item => edited.has(item)) && <p className={styles.note}>{T.edited}</p>}
            {parsed.pending && charted && <p className={styles.note}>{T.preparing}</p>}
            {fields.map(field)}
            {reasons && <Reasons text={reasons} streaming={streaming && last} />}
            {checked && name && REPORT_FIXED_NOTES[name] && (
              <aside className={styles.fixedNote}>
                <p className={styles.blockTitle}>{REPORT_FIXED_NOTES[name].title}</p>
                <p className={styles.plain}>{REPORT_FIXED_NOTES[name].text}</p>
              </aside>
            )}
          </section>
        );
      })}
      {unplaced.length > 0 && (
        <section className={styles.chapter}>
          <h2 className={styles.chapterTitle}>{T.more}</h2>
          {unplaced.map(field)}
        </section>
      )}
    </div>
  );
}

function ReportField({ name, data, fallback }: { name: ReportDataField; data: ReportData; fallback?: string[] }) {
  const spec = REPORT_DATA_FIELDS[name];
  if (data[name] === undefined)
    return fallback ? <ReportDataFallback label={spec.label} texts={fallback} note={T.fallback} /> : null;
  switch (name) {
  case "thisWeek": return <ThisWeekList steps={data.thisWeek!} />;
  case "audience": return <AudienceCards audience={data.audience!} />;
  case "benchmarks": return <BenchmarkChart benchmarks={data.benchmarks!} />;
  case "funnel": return <FunnelChart layers={data.funnel!} />;
  case "plan30": return <Plan30Timeline plan={data.plan30!} />;
  default: return <ReportDataBlock spec={spec} value={data[name]} />;
  }
}

/** "30 秒看懂": the conclusion, this week's first step, the main platform, the positioning and the funnel in one line. */
function QuickLook({ data }: { data: ReportData }) {
  const first = data.thisWeek?.[0];
  const main = data.platforms?.filter(platform => platform.role === "main").map(platform => platform.platform).join("、");
  const funnel = data.funnel?.map(layer => `${layer.layer}（${layer.offer}）`).join(" → ");
  if (!data.summary && !first) return null;
  return (
    <section aria-label={T.quickLook} className={styles.quickLook}>
      <p className={styles.quickTitle}>{T.quickLook}</p>
      {data.summary && <p className={styles.summary}>{data.summary}</p>}
      {first && <FirstStepCard step={first} />}
      <dl className={styles.pairs}>
        {main && <div><dt>{T.mainPlatform}</dt><dd>{main}</dd></div>}
        {data.positioning && <div><dt>{T.positioning}</dt><dd>{data.positioning.statement}</dd></div>}
        {funnel && <div className={styles.pairWide}><dt>{T.funnel}</dt><dd>{funnel}</dd></div>}
      </dl>
    </section>
  );
}

/** A chapter's reasons, folded until asked for. */
function Reasons({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.reasons}>
      <button type="button" className={styles.reasonsToggle} aria-expanded={open} onClick={() => setOpen(value => !value)}>
        {open ? T.hideReasons : T.showReasons}
      </button>
      {open && <MessageMarkdown className={styles.reasonsBody} text={text} streaming={streaming} />}
    </div>
  );
}
