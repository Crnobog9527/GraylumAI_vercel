/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * 停止 for a report on the CORE-PATH-V2 turn path (V2-7a; the page switches to it in V2-10). The stop is its own request,
 * POST /api/turn/stop, with what the page showed (`stopAt`, code points as Array.from counts them). Its answers fit the
 * existing report stop controller (report-stop.ts): `confirmation_required` (the third stop within 24 hours, which then
 * charges what was generated) is asked in the dialog and resent with `confirmed: true`; `stopping` is still saving;
 * `closed` is settled. Only after the server recorded the stop does the page drop the turn's stream: the dropped stream is
 * what makes the server abort the model call, and a stream dropped without a recorded stop never stops a report.
 */
export type TurnStopRequest = { turnId: number; stopAt: number; confirmed?: boolean };
export type TurnStopAnswer = { turnId: number; state: "stopping" | "closed" | "confirmation_required"; chargeable: boolean;
  fixedCredits?: number; closeKind?: string | null; chargedCredits?: number | null; replay: boolean };

export function turnReportStop(deps: { fetch: typeof fetch; dropStream: () => void }) {
  return async (request: TurnStopRequest): Promise<TurnStopAnswer> => {
    const response = await deps.fetch("/api/turn/stop", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(request) });
    // An unanswered stop is "unconfirmed" to the controller: it keeps the shown text and offers the same stop again.
    if (!response.ok) throw new Error("TURN_STOP_FAILED");
    const answer = await response.json() as TurnStopAnswer;
    if (answer.state === "stopping") deps.dropStream();
    return answer;
  };
}

/** The third-stop notice (Owner 10-27), with the report's own fixed price; never a guessed number. */
export function reportStopChargeNotice(price: number | null | undefined) {
  return `今天已停止过 2 次，本次将按已生成部分扣费（不超过${typeof price === "number" ? ` ${price} 积分` : "报告价格"}）`;
}
