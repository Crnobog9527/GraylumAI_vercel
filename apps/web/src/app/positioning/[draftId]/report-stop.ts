/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { LiveReply } from "./agent-turn-display";
import { sendStop, stopFollowUpDelay, stopRequestFor, type StopRequest } from "./stop-reply";

/**
 * 停止 for a report (CHAT-NATIVE-OUTPUT C2 rules), without React so the rules are testable. The
 * first press on an execution fixes one stop request (stopAt/source of what was shown); a press on
 * another execution (after 重新生成) starts over with that execution's own request. A retry after an
 * unconfirmed answer resends exactly that request, never an ordinary cancel and never a new
 * generation. After every send the saved status is re-read on the bounded
 * STOP_FOLLOW_UP_DELAYS_MS schedule until it is completed or cancelled.
 */
export type ReportStopPhase = "idle" | "sending" | "saving" | "unconfirmed" | "settled";

const FINAL = ["completed", "cancelled"];

export function reportStopController(deps: {
  cancel: (request: StopRequest) => Promise<unknown>;
  /** Re-read the saved report status; resolves to its state, or null when it could not be read. */
  reread: () => Promise<string | null>;
  schedule: (delayMs: number, callback: () => void) => void;
  onChange: (phase: ReportStopPhase) => void;
}) {
  let request: StopRequest | null = null;
  let phase: ReportStopPhase = "idle";
  /** Only the latest send's follow-up keeps reading. */
  let chain = 0;
  const set = (next: ReportStopPhase) => { phase = next; deps.onChange(next); };
  const follow = (own: number, attempt: number) => {
    const delay = stopFollowUpDelay(attempt);
    if (delay === null) return;
    deps.schedule(delay, () => {
      void (async () => {
        if (own !== chain) return;
        let state: string | null = null;
        try { state = await deps.reread(); } catch { /* The next read tries again. */ }
        if (own !== chain) return;
        if (state && FINAL.includes(state)) set("settled");
        else follow(own, attempt + 1);
      })();
    });
  };
  const send = async () => {
    if (!request || phase === "sending" || phase === "settled") return;
    const sent = request;
    set("sending");
    const outcome = await sendStop(sent, deps.cancel);
    // A late answer for an earlier execution's stop never changes the current one.
    if (request !== sent) return;
    set(outcome === "unconfirmed" ? "unconfirmed" : outcome === "saving" ? "saving" : "settled");
    follow(++chain, 0);
  };
  return {
    phase: () => phase,
    request: () => request,
    /** The execution the fixed request belongs to. */
    executionId: () => request?.executionId ?? null,
    /** 停止 on the shown reply: fixes the request once per execution, then sends it. */
    stop(reply: LiveReply) {
      if (request?.executionId !== reply.executionId) {
        request = stopRequestFor(reply);
        chain++;
        set("idle");
      }
      return send();
    },
    /** 停止 again after an unconfirmed answer: the same request. */
    retry: () => (phase === "unconfirmed" ? send() : Promise.resolve()),
  };
}
