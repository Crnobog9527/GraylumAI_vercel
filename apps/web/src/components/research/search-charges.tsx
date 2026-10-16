/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Credit record wording for the search calls inside one reply (RESEARCH_TOOLS_PLAN.md §3.3, RT-2 / 0255): what
// each search was, and what it cost the user. Only searches the user paid for show an amount; every other
// settlement says plainly that it was free. Supplier names and supplier costs never appear here.
import type { ResearchToolName } from "../../../../../packages/api/src/services/research/tools/schemas";
import { describeRequest } from "./research-model";
import styles from "./research.module.css";

/** The tool settlement sources of 0255 (`erasure_ledger_metadata`): how the user side of one call was settled. */
export type ToolSettlement = "tool_usage" | "tool_no_usage" | "tool_failed" | "tool_failed_charged" | "tool_unknown";

export interface SearchCharge {
  callId: string;
  tool: ResearchToolName;
  args: unknown;
  /** Null while the call is not settled yet. */
  settlement: ToolSettlement | null;
  /** Credits charged to the user for this call before the reply is rounded once (decimal text, e.g. "0.3"). */
  userCredits: string | null;
}

/** One line of outcome text per settlement. */
export function chargeText(charge: SearchCharge): string {
  switch (charge.settlement) {
    case "tool_usage":
      return charge.userCredits !== null && /^\d+(\.\d+)?$/.test(charge.userCredits)
        ? `${charge.userCredits.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")} 积分` : "已计费";
    case "tool_no_usage": return "不收费（这次没有拿到用量记录）";
    case "tool_failed":
    case "tool_failed_charged": return "没取到数据，不收费";
    case "tool_unknown": return "结果待核，不收费";
    case null: return "结算中";
  }
}

/**
 * Under one reply's spend entry: each search with its own charge. The reply is rounded up once in total, so the
 * lines can add up to a little less than the entry's amount.
 */
export function SearchCharges({ charges }: { charges: SearchCharge[] }) {
  const rows = charges.flatMap(charge => {
    const request = describeRequest(charge.tool, charge.args);
    return request ? [{ charge, request }] : [];
  });
  if (rows.length === 0) return null;
  return (
    <section aria-label="本次回复里的搜索" className={styles.charges}>
      <p className={styles.head}>其中搜索 {rows.length} 次</p>
      <ul className={styles.chargeList}>
        {rows.map(({ charge, request }) => (
          <li key={charge.callId} className={styles.chargeRow}>
            <span className={styles.chargeWhat}>
              <span>{request.query || "（未提供）"}</span>
              <span className={styles.callMeta}>{request.line}</span>
            </span>
            <span className={styles.chargeAmount} data-charged={charge.settlement === "tool_usage"}>{chargeText(charge)}</span>
          </li>
        ))}
      </ul>
      <p className={styles.hint}>整次回复的费用合计后统一向上取整一次，所以各项相加可能比这条记录略少。</p>
    </section>
  );
}
