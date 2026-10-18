/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";

import { useState } from "react";
import { trpc } from "@/trpc/client";
import { QueryNotice } from "@/components/opc/query-notice";
import { EvidenceList } from "./evidence-list";
import { toEvidenceEntries } from "./research-api";
import styles from "./research.module.css";

const PAGE_SIZE = 20;
type Cursor = { createdAt: string; operationId: string };

/**
 * The library's "搜索记录" tab: the signed-in user's research evidence, newest first, 20 at a time
 * (`research.evidence`). Pages are explicit cursor queries: the endpoint's input is strict, so tRPC's infinite
 * query (which adds `direction`) cannot be used.
 */
export function LibraryEvidence() {
  const [cursors, setCursors] = useState<Cursor[]>([]);
  const pages = trpc.useQueries(t => [undefined, ...cursors].map(cursor =>
    t.research.evidence(cursor ? { limit: PAGE_SIZE, cursor } : { limit: PAGE_SIZE })));
  const first = pages[0]!;
  if (!first.data) {
    return <QueryNotice error={first.error} loading={first.isPending} label="搜索记录" retry={() => first.refetch()} />;
  }
  const last = pages[pages.length - 1]!;
  const rows = pages.flatMap(page => page.data?.items ?? []);
  const next = last.data?.nextCursor;
  return (
    <EvidenceList entries={toEvidenceEntries(rows)}>
      {last.isPending && <p className={styles.hint}>正在加载…</p>}
      {last.error && (
        <p role="alert" className={styles.problem}>加载更多没有成功。
          <button type="button" className={styles.linkButtonLight} onClick={() => void last.refetch()}>重试</button>
        </p>
      )}
      {next && (
        <button type="button" className={styles.secondary} onClick={() => setCursors(current => [...current, next])}>
          加载更多
        </button>
      )}
    </EvidenceList>
  );
}
