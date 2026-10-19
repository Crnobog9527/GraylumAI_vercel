/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BENCHMARK-SHORTFALL (Owner 2026-10-20, choice B): after at least two searches the session still has fewer
// qualified benchmarks than the report needs. The host offers this card (0320); the user answers it once, and only
// "generate" lets the report start with the benchmarks found so far. The text is fixed here, never model-written.
import { useState } from "react";
import { cn } from "@/lib/utils";
import { cardErrorText } from "./selection-card-model";
import styles from "./research.module.css";

export type ShortfallChoice = "continue" | "generate";
export interface ShortfallCard {
  cardId: string; required: number; offeredQualified: number; offeredRounds: number;
  choice: ShortfallChoice | null; chosenQualified: number | null;
}

/** What the page sends to the coach after the choice, in the user's words. */
export function shortfallChoiceInput(choice: ShortfallChoice, qualified: number): string {
  return choice === "generate"
    ? `我选择先用现有的 ${qualified} 个对标账号生成报告`
    : "我选择继续找对标账号";
}

export const shortfallChoiceText = (choice: ShortfallChoice, qualified: number) => choice === "generate"
  ? `用现有 ${qualified} 个对标先生成报告` : "继续找对标";

const errorCode = (error: unknown) => {
  const message = error && typeof error === "object" && "message" in error ? String(error.message) : "";
  return message.match(/RESEARCH_[A-Z_]+/)?.[0];
};

export function ShortfallCardView({ card, disabled = false, onChoose }: {
  card: ShortfallCard;
  disabled?: boolean;
  onChoose: (choice: ShortfallChoice) => Promise<void>;
}) {
  const [picked, setPicked] = useState<ShortfallChoice>("continue");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = card.offeredQualified;
  if (card.choice) {
    const qualified = card.chosenQualified ?? n;
    return (
      <section aria-label="对标不足时怎么办" data-selection-card="shortfall-confirmed" className={styles.card}>
        <p className={styles.head}>对标不足时怎么办 · 已确认</p>
        <ul className={styles.echo}><li className={styles.echoItem}>{shortfallChoiceText(card.choice, qualified)}</li></ul>
        {card.choice === "generate" && <p className={styles.hint}>
          报告会注明对标样本不足：只有 {qualified} 个可学账号，结论参考性有限，建议之后补找对标再核对。</p>}
      </section>
    );
  }
  const locked = disabled || pending;
  const submit = async () => {
    if (locked) return;
    setPending(true);
    setError(null);
    try { await onChoose(picked); } catch (failure) { setError(cardErrorText(errorCode(failure))); } finally { setPending(false); }
  };
  const option = (value: ShortfallChoice, title: string, detail: string) => (
    <label className={cn(styles.row, styles.pick, picked === value && styles.picked)}>
      <input type="radio" name={`shortfall-${card.cardId}`} className={styles.check} checked={picked === value}
        disabled={locked} onChange={() => setPicked(value)} />
      <span className={styles.pickText}>
        <span className={styles.pickName}>{title}</span>
        <span className={styles.pickMeta}>{detail}</span>
      </span>
    </label>
  );
  return (
    <section aria-label="对标不足时怎么办" data-selection-card="shortfall" className={styles.card}>
      <p className={styles.head}>对标账号还不够 {card.required} 个</p>
      <p className={styles.title}>已经找了 {card.offeredRounds} 轮，目前有 {n} 个可以照着学的对标账号</p>
      <div role="radiogroup" aria-label="接下来怎么做" className={styles.list}>
        {option("continue", "继续找对标（推荐）", "换关键词再找，或贴你知道的账号主页链接。凑够后报告更可靠。")}
        {option("generate", `用现有 ${n} 个对标先生成报告`,
          `报告会注明对标样本不足：只有 ${n} 个可学账号，结论参考性有限，建议之后补找对标再核对。`)}
      </div>
      <div className={styles.footer}>
        <span className={styles.count}>选好后确认，只能选一次。</span>
        <button type="button" className={styles.primary} disabled={locked} onClick={() => void submit()}>
          {pending ? "正在确认…" : "确认选择"}
        </button>
      </div>
      {error && <p className={styles.problem} role="alert">{error}</p>}
    </section>
  );
}
