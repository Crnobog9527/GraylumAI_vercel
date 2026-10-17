/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import styles from "./research-table.module.css";

/** Plain sentence for the refresh grant errors of RT-3b (`research_refresh_create`). */
export function refreshErrorText(error: unknown): string {
  const text = error && typeof error === "object" ? String((error as { message?: unknown }).message ?? "") : "";
  if (text.includes("RESEARCH_REFRESH_INVALID")) return "这个账号现在不能刷新，可能正在读取中，请稍后再试。";
  if (text.includes("RESEARCH_SCOPE_DENIED")) return "这个账号不属于当前对话。";
  return "刷新没有成功，请稍后再试。";
}

type State = { kind: "idle" } | { kind: "pending" } | { kind: "done" } | { kind: "error"; text: string };

/**
 * "刷新" for one fetched benchmark account (plan §1.2 step 6). A click only asks the host for a one-time refresh
 * grant; the coach then reads the account again, which counts as a new lookup. One request per click, locked
 * while it runs; after success the button stays done for this row.
 */
export function RefreshButton({ account, onRefresh, disabled = false }: { account: string; onRefresh: () => Promise<void>; disabled?: boolean }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const click = async () => {
    if (state.kind === "pending" || state.kind === "done") return;
    setState({ kind: "pending" });
    try {
      await onRefresh();
      setState({ kind: "done" });
    } catch (error) {
      setState({ kind: "error", text: refreshErrorText(error) });
    }
  };
  return (
    <span className={styles.refresh}>
      <button type="button" className={styles.refreshButton} aria-label={`刷新 ${account} 的数据`}
        disabled={disabled || state.kind === "pending" || state.kind === "done"} onClick={() => void click()}>
        <RefreshCw size={12} aria-hidden />
        {state.kind === "pending" ? "正在申请…" : state.kind === "done" ? "已申请刷新" : "刷新"}
      </button>
      {state.kind === "error" && <span role="alert" className={styles.refreshError}>{state.text}</span>}
    </span>
  );
}
