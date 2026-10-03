/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useId } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { QuestionCard } from "@repo/api/src/shared/agentTurn";
import styles from "./question-card.module.css";

/** Label of the fixed last entry; the message box placeholder uses the same wording. */
export const OTHER_LABEL = "其他";
export const OTHER_PLACEHOLDER = "其他：自己补充";

/**
 * One open mentor question with suggested answers, docked above the message box
 * like an attachment preview (`docked`). A clicked option is sent as the next
 * turn's plain user input; the option the mentor recommends carries a small
 * "推荐" tag and the mentor's reason directly under it. The fixed "其他" entry
 * sends nothing: it moves focus to the message box, where the user answers in
 * their own words. The card never locks that box.
 *
 * Only an unanswered question is ever shown. Once answered the card simply
 * disappears: the answer is an ordinary user message, and the question and
 * answer stay stored and in the Agent's context as before.
 */
export function QuestionCardView({
  card,
  disabled = false,
  onAnswer,
  onOther,
  docked = false,
  onDismiss,
}: {
  card: QuestionCard;
  /** Temporarily not sendable, for example while another reply is running. */
  disabled?: boolean;
  onAnswer?: (input: string, optionIndex: number) => void;
  /** Called by the fixed "其他" entry; the page focuses its message box. */
  onOther?: () => void;
  /** Shown attached above the message box. */
  docked?: boolean;
  /** Folds a docked card away; a one-line placeholder in the conversation shows it again. */
  onDismiss?: () => void;
}) {
  const reasonId = useId();
  const reasonIndex = card.recommendationReason ? card.recommended : null;
  return (
    <section aria-label="导师提问" data-question-card="open" className={cn(styles.card, docked && styles.docked)}>
      <p className={styles.head}>导师提问</p>
      <p className={styles.question}>{card.question}</p>
      <div role="group" aria-label="建议选项" className={styles.options}>
        {card.options.map((option, index) => (
          <div key={option} className={styles.optionItem}>
            <button type="button" className={styles.option} disabled={disabled}
              aria-describedby={index === reasonIndex ? reasonId : undefined} onClick={() => onAnswer?.(option, index)}>
              {option}
              {index === card.recommended && <span className={styles.tag}>推荐</span>}
            </button>
            {index === reasonIndex && <p id={reasonId} className={styles.reason}>{card.recommendationReason}</p>}
          </div>
        ))}
        <button type="button" className={cn(styles.option, styles.other)} disabled={disabled} onClick={() => onOther?.()}>
          {OTHER_LABEL}
        </button>
      </div>
      {/* Last in reading order so the options come first; drawn top-right. */}
      {docked && onDismiss && (
        <button type="button" className={styles.dismiss} aria-label="收起提问" onClick={onDismiss}><X size={15}/></button>
      )}
    </section>
  );
}

/** One-line placeholder in the conversation while an unanswered docked card is folded away. */
export function OpenQuestionRecord({ card, onShow }: { card: QuestionCard; onShow?: () => void }) {
  return (
    <section aria-label="导师提问记录" data-question-card="folded" className={styles.folded}>
      <span className={styles.foldedText}><span className={styles.head}>导师提问 · 待回答</span>{card.question}</span>
      <button type="button" className={styles.show} onClick={onShow}>显示选项</button>
    </section>
  );
}
