/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
"use client";
import { Button } from "@/components/ui/button";
import { ShortfallCardView, type ShortfallCard, type ShortfallChoice } from "@/components/research/shortfall-card";
import { focusReply } from "./agent-turn-display";

export type ReportPreflight = {
  canGenerate: boolean; qualified: number; required: number; rounds: number; card: ShortfallCard | null;
};

/** Resolve the existing benchmark decision before showing a report's paid offer. */
export function ReportBenchmarkGate({ value, failed, busy, onRetry, onChoose }: {
  value: ReportPreflight | undefined; failed: boolean; busy: boolean; onRetry: () => void;
  onChoose: (choice: ShortfallChoice) => Promise<void>;
}) {
  if (!value) return <div role={failed ? "alert" : "status"} className="grid gap-2 text-sm">
    <p>{failed ? "暂时无法确认对标条件，报告没有开始生成。请重试。" : "正在确认对标条件…"}</p>
    {failed && <Button variant="outline" disabled={busy} onClick={onRetry}>重新确认对标条件</Button>}
  </div>;
  return <section aria-label="报告生成条件" className="grid gap-2 text-sm">
    <p>目前有 {value.qualified} 个合格对标，还未达到报告需要的 {value.required} 个。</p>
    <p>可以换关键词继续找，或在对话里贴账号主页链接。点下面的按钮后，在下方输入新的关键词或贴账号链接继续找。</p>
    <Button variant="outline" disabled={busy} onClick={focusReply}>继续找对标</Button>
    {value.qualified >= 1 && value.rounds >= 2 && value.card && !value.card.choice && value.card.required >= value.required
      ? <ShortfallCardView card={value.card} disabled={busy} onChoose={onChoose} />
      : <p>找过两轮仍不足时（贴链接核对一次，也算一轮），可在对话里的选择卡确认用现有对标先生成；报告会注明样本不足。</p>}
  </section>;
}
