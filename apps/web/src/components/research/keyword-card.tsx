/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  buildKeywordSubmission, initialKeywordDraft, KEYWORD_MAX_CHARS, keywordItems, keywordProblem,
  type CardConfirmation, type KeywordCard, type KeywordDraft, type KeywordSubmission,
} from "./selection-card-model";
import { useCardConfirm } from "./use-card-confirm";
import styles from "./research.module.css";

/** Read-only echo of a confirmed card: the final items, nothing to click. */
export function ConfirmedItems({ title, items }: { title: string; items: string[] }) {
  return (
    <section aria-label={title} data-selection-card="confirmed" className={styles.card}>
      <p className={styles.head}>{title} · 已确认</p>
      <ul className={styles.echo}>
        {items.map(item => <li key={item} className={styles.echoItem}>{item}</li>)}
      </ul>
      <p className={styles.hint}>每张卡只能确认一次。</p>
    </section>
  );
}

/**
 * Keyword selection card (plan §1.2 step 1): keep, edit or add keywords, then confirm once. No benchmark search
 * runs before this confirmation. After it the card is a read-only echo of the confirmed keywords.
 */
export function KeywordCardView({ card, confirmation: saved, disabled = false, onConfirm }: {
  card: KeywordCard;
  /** The host's stored confirmation, when the card was already confirmed. */
  confirmation?: CardConfirmation | null;
  disabled?: boolean;
  onConfirm: (submission: KeywordSubmission) => Promise<CardConfirmation>;
}) {
  const [draft, setDraft] = useState<KeywordDraft>(() => initialKeywordDraft(card));
  const [adding, setAdding] = useState("");
  const { confirmation, pending, error, submit } = useCardConfirm(saved, onConfirm);
  if (confirmation?.kind === "keywords") return <ConfirmedItems title="关键词" items={confirmation.items} />;

  const count = keywordItems(card, draft).length;
  const built = buildKeywordSubmission(card, draft);
  const locked = disabled || pending;
  const addProblem = adding.trim() ? keywordProblem(adding) : null;
  const toggle = (id: string) => setDraft(current => ({
    ...current,
    selected: current.selected.includes(id) ? current.selected.filter(item => item !== id) : [...current.selected, id],
  }));
  const add = () => {
    if (!adding.trim() || addProblem || count >= card.maxSelect) return;
    setDraft(current => ({ ...current, additions: [...current.additions, adding.trim()] }));
    setAdding("");
  };

  return (
    <section aria-label="关键词选择" data-selection-card="keywords" className={styles.card}>
      <p className={styles.head}>关键词选择</p>
      <p className={styles.title}>用哪些关键词找对标账号？</p>
      <p className={styles.hint}>勾选要用的关键词，可以直接改字，也可以补充。确认后才会开始搜索。</p>
      <div role="group" aria-label="关键词" className={styles.list}>
        {card.options.map(option => {
          const checked = draft.selected.includes(option.id);
          return (
            <div key={option.id} className={cn(styles.row, !checked && styles.rowOff)}>
              <input type="checkbox" className={styles.check} checked={checked} disabled={locked}
                aria-label={`使用关键词 ${draft.texts[option.id] ?? option.text}`} onChange={() => toggle(option.id)} />
              <input type="text" className={styles.field} value={draft.texts[option.id] ?? option.text}
                disabled={locked || !checked} maxLength={KEYWORD_MAX_CHARS * 2} aria-label="关键词文字"
                onChange={event => setDraft(current => ({ ...current, texts: { ...current.texts, [option.id]: event.target.value } }))} />
            </div>
          );
        })}
        {draft.additions.map((item, index) => (
          <div key={`${item}-${index}`} className={styles.row}>
            <span className={styles.addedTag}>补充</span>
            <span className={styles.addedText}>{item}</span>
            <button type="button" className={styles.iconButton} disabled={locked} aria-label={`删除补充的关键词 ${item}`}
              onClick={() => setDraft(current => ({ ...current, additions: current.additions.filter((_, at) => at !== index) }))}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
      <div className={styles.addRow}>
        <input type="text" className={styles.field} value={adding} placeholder="补充一个关键词" aria-label="补充关键词"
          disabled={locked || count >= card.maxSelect} maxLength={KEYWORD_MAX_CHARS * 2}
          onChange={event => setAdding(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); add(); } }} />
        <button type="button" className={styles.secondary} onClick={add}
          disabled={locked || !adding.trim() || addProblem !== null || count >= card.maxSelect}>
          <Plus size={14} aria-hidden />添加
        </button>
      </div>
      {addProblem && <p className={styles.problem}>{addProblem}</p>}
      <div className={styles.footer}>
        <span className={styles.count}>已选 {count} 个 · 最多 {card.maxSelect} 个</span>
        <button type="button" className={styles.primary} disabled={locked || !built.ok}
          onClick={() => { if (built.ok) void submit(built.submission); }}>
          {pending ? "正在确认…" : "确认关键词"}
        </button>
      </div>
      {!built.ok && <p className={styles.problem} role="status">{built.problem}</p>}
      {error && <p className={styles.problem} role="alert">{error}</p>}
    </section>
  );
}
