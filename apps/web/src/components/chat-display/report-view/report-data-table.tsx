/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { Spec } from "@repo/api/src/shared/reportDataSpec";
import { cellText } from "@repo/api/src/shared/reportDataText";
export { cellText };
import styles from "./report-view.module.css";

/**
 * Any strategy-data field as a table or a list, with column names from the shared field definitions
 * (REPORT-VISUAL §4: the tables the text no longer repeats are still all on the page). Display only;
 * values are plain text (React escapes them), never Markdown, links or HTML.
 */

function Table({ spec, rows }: { spec: Extract<Spec, { kind: "object" }>; rows: Record<string, unknown>[] }) {
  const columns = Object.entries(spec.fields);
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <thead><tr>{columns.map(([key, child]) => <th key={key} scope="col">{child.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>{columns.map(([key, child]) => <td key={key}>{cellText(child, row[key])}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A field's value laid out by its spec. `title` shows the field's label above it. */
export function ReportDataBlock({ spec, value, title = true }: { spec: Spec; value: unknown; title?: boolean }) {
  if (value === undefined || value === null) return null;
  const label = title ? <p className={styles.blockTitle}>{spec.label}</p> : null;
  if (spec.kind === "list") {
    const items = value as unknown[];
    if (items.length === 0) return null;
    if (spec.of.kind === "object")
      return <div className={styles.block}>{label}<Table spec={spec.of} rows={items as Record<string, unknown>[]} /></div>;
    return <div className={styles.block}>{label}<ul className={styles.list}>
      {items.map((item, index) => <li key={index}>{cellText(spec.of, item)}</li>)}</ul></div>;
  }
  if (spec.kind === "object") {
    const record = value as Record<string, unknown>;
    return (
      <div className={styles.block}>
        {label}
        <dl className={styles.pairs}>
          {Object.entries(spec.fields).map(([key, child]) => {
            const item = record[key];
            if (item === undefined || (Array.isArray(item) && item.length === 0)) return null;
            const nested = child.kind === "list" && child.of.kind === "object";
            return (
              <div key={key} className={nested ? styles.pairWide : undefined}>
                <dt>{child.label}</dt>
                <dd>{nested ? <ReportDataBlock spec={child} value={item} title={false} /> : cellText(child, item)}</dd>
              </div>
            );
          })}
        </dl>
      </div>
    );
  }
  return <div className={styles.block}>{label}<p className={styles.plain}>{cellText(spec, value)}</p></div>;
}

/** A field that did not pass its checks: only its text, as a plain list, with a note saying so. */
export function ReportDataFallback({ label, texts, note }: { label: string; texts: string[]; note: string }) {
  return (
    <div className={styles.block}>
      <p className={styles.blockTitle}>{label}</p>
      <p className={styles.note}>{note}</p>
      <ul className={styles.list}>{texts.map((text, index) => <li key={index}>{text}</li>)}</ul>
    </div>
  );
}
