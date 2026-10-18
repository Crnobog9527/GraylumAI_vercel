/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from "react";
import { cn } from "@/lib/utils";
import { DATA_SOURCE_NOTE, platformLabel } from "./research-model";
import { ConfirmedItems } from "./keyword-card";
import {
  buildCandidateSubmission, type CandidateCard, type CandidateSubmission, type CardConfirmation,
} from "./selection-card-model";
import { useCardConfirm } from "./use-card-confirm";
import styles from "./research.module.css";

const accountText = (item: { platform: string; account: string }) => `${platformLabel(item.platform)} · ${item.account}`;

/**
 * Candidate selection card (plan §1.2 step 5), first card and follow-up cards alike: tick accounts only, no
 * editing or adding. Head references are listed but cannot be ticked. Limits come from the host (a first card
 * asks for at least 3; a follow-up card for what is still missing). Confirmed once, then a read-only echo.
 */
export function CandidateCardView({ card, confirmation: saved, disabled = false, onConfirm }: {
  card: CandidateCard;
  confirmation?: CardConfirmation | null;
  disabled?: boolean;
  onConfirm: (submission: CandidateSubmission) => Promise<CardConfirmation>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const { confirmation, pending, error, submit } = useCardConfirm(saved, onConfirm);
  const title = card.followUp ? "补选对标账号" : "对标候选账号";
  if (confirmation?.kind === "candidates") return <ConfirmedItems title={title} items={confirmation.items.map(accountText)} />;

  const built = buildCandidateSubmission(card, selected);
  const locked = disabled || pending;
  const full = selected.length >= card.maxSelect;
  const toggle = (id: string) => setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  const selectable = card.options.filter(option => option.selectable);
  const references = card.options.filter(option => !option.selectable);

  return (
    <section aria-label={title} data-selection-card="candidates" className={styles.card}>
      <p className={styles.head}>{title}</p>
      <p className={styles.title}>{card.followUp ? "再选几个账号补上" : "选出你想对标的账号"}</p>
      <p className={styles.hint}>至少选 {card.minSelect} 个，最多 {card.maxSelect} 个。选好后会读取这些账号的资料和近期作品。</p>
      <div role="group" aria-label="候选账号" className={styles.list}>
        {selectable.map(option => {
          const checked = selected.includes(option.id);
          return (
            <label key={option.id} className={cn(styles.row, styles.pick, checked && styles.picked)}>
              <input type="checkbox" className={styles.check} checked={checked} disabled={locked || (!checked && full)}
                onChange={() => toggle(option.id)} />
              <span className={styles.pickText}>
                <span className={styles.pickName}>{option.label || option.account}</span>
                <span className={styles.pickMeta}>{accountText(option)}</span>
              </span>
            </label>
          );
        })}
      </div>
      {references.length > 0 && (
        <div role="group" aria-label="头部账号" className={styles.list}>
          <p className={styles.subhead}>头部账号</p>
          {references.map(option => (
            <div key={option.id} className={cn(styles.row, styles.pick, styles.reference)} aria-disabled="true">
              <input type="checkbox" className={styles.check} checked={false} disabled aria-label={`${option.account} 只作参考，不能选`} readOnly />
              <span className={styles.pickText}>
                <span className={styles.pickName}>{option.label || option.account}</span>
                <span className={styles.pickMeta}>{accountText(option)}</span>
              </span>
              <span className={styles.refTag}>只作参考</span>
            </div>
          ))}
        </div>
      )}
      <p className={styles.note}>{DATA_SOURCE_NOTE}</p>
      <div className={styles.footer}>
        <span className={styles.count}>已选 {selected.length} 个</span>
        <button type="button" className={styles.primary} disabled={locked || !built.ok}
          onClick={() => { if (built.ok) void submit(built.submission); }}>
          {pending ? "正在确认…" : "确认选择"}
        </button>
      </div>
      {!built.ok && selected.length > 0 && <p className={styles.problem} role="status">{built.problem}</p>}
      {error && <p className={styles.problem} role="alert">{error}</p>}
    </section>
  );
}
