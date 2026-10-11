/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * How a positioning draft starts. "mentor": 从头分析. "manual": 我已有定位 (AGENT-CORE R15) — the same Agent
 * workspace; the mentor first asks the user to paste or describe the existing positioning, then checks it
 * step by step with the confirmation cards. The mode is frozen in the draft by `opc.start`.
 */
export type StartMode = "mentor" | "manual";

const INTENT = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A one-click entry from another page. The intent id becomes the start request id, so a reload never starts twice. */
export function startEntryHref(mode: StartMode, intent: string) {
  return `/positioning?start=${mode}&intent=${intent}`;
}

/** The entry named by the URL, or null. `intent` is null when the URL carries none or an unusable one. */
export function readStartEntry(search: string): { mode: StartMode; intent: string | null } | null {
  const params = new URLSearchParams(search);
  const mode = params.get("start");
  if (mode !== "mentor" && mode !== "manual") return null;
  const intent = params.get("intent");
  return { mode, intent: intent && INTENT.test(intent) ? intent : null };
}

const OTHER_PENDING = "上次还有一个没完成的开始请求，方式和这次不同。请先点「恢复上次开始请求」完成它，再选择其他方式。";
export const START_TEXT = {
  mentor: { title: "开始定位分析", action: "从头分析新定位", otherPending: OTHER_PENDING },
  manual: { title: "核对已有定位", action: "我已有定位", otherPending: OTHER_PENDING },
} as const;

/** A retained start may be resumed by an entry only when it is the same kind of start. */
export const retainedMatches = (retained: StartMode | undefined, chosen: StartMode) => (retained ?? "mentor") === chosen;

/** Shown in a 我已有定位 workspace until the mentor's own opening arrives. */
export const EXISTING_WELCOME =
  "把你已有的定位粘贴或描述给我就好，比如账号介绍、目标受众、内容方向。我会整理到右侧清单的对应栏目，再一步一步和你核对确认，不会从头重新提问。";
