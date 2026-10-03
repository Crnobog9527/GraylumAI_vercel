/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useId } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { UNSURE_INPUT, type QuestionCard } from "@repo/api/src/shared/agentTurn";
import styles from "./question-card.module.css";

/** Label of the fixed last entry; the message box placeholder uses the same wording. */
export const OTHER_LABEL = "其他";
export const OTHER_PLACEHOLDER = "其他：自己补充";

/**
 * One mentor question with suggested answers. A clicked option is sent as the
 * next turn's plain user input. The option the mentor recommends carries a
 * "推荐" tag with the mentor's reason directly under that option. The fixed "其他" entry sends nothing: it moves focus to the
 * message box below, where the user answers in their own words. The card
 * never locks that box.
 *
 * Once answered the card is a compact history record: the question and the
 * user's reply, with the options (chosen and recommended marked) folded away.
 * Nothing in it is clickable.
 *
 * The open card is docked to the message box (`docked`), like an attachment
 * preview; the conversation shows `OpenQuestionRecord` in its place.
 */
export function QuestionCardView({
  card,
  answered,
  answer = null,
  disabled = false,
  onAnswer,
  onOther,
  docked = false,
  onDismiss,
}: {
  card: QuestionCard;
  answered: boolean;
  /** The user's reply to this card, when known. */
  answer?: string | null;
  /** Temporarily not sendable, for example while another reply is running. */
  disabled?: boolean;
  onAnswer?: (input: string, optionIndex: number) => void;
  /** Called by the fixed "其他" entry; the page focuses its message box. */
  onOther?: () => void;
  /** Shown attached above the message box instead of in the conversation. */
  docked?: boolean;
  /** Folds a docked card away; the conversation record can show it again. */
  onDismiss?: () => void;
}) {
  const reasonId = useId();
  const status = answered ? (answer === null ? "已结束" : "已回答") : null;
  const recommended = (index: number) =>
    index === card.recommended && <span className={styles.chosenTag}>推荐</span>;
  const reasonIndex = card.recommendationReason ? card.recommended : null;
  const reason = (index: number) => index === reasonIndex && (
    <p id={reasonId} className={styles.reason}>{card.recommendationReason}</p>
  );
  return (
    <section aria-label="导师提问" data-question-card={answered ? "answered" : "open"}
      className={cn(styles.card, docked && styles.docked, answered && styles.record)}>
      <div className={styles.head}>
        <span>导师提问</span>
        {status && <span className={styles.status}>{status}</span>}
      </div>
      <p className={styles.question}>{card.question}</p>
      {answered ? (
        <>
          {answer !== null && <p className={styles.answer}><span>你的回答</span>{answer}</p>}
          <details className={styles.history}>
          <summary>查看选项</summary>
          <ul className={styles.options} aria-label="建议选项">
            {card.options.map((option, index) => (
              <li key={option} className={styles.optionItem}>
                <div className={cn(styles.historyItem, option === answer && styles.chosen)}>
                  {option}
                  {recommended(index)}
                  {option === answer && <span className={styles.chosenTag}>你的选择</span>}
                </div>
                {reason(index)}
              </li>
            ))}
          </ul>
          {answer !== null && !card.options.includes(answer) && (
            <p className={cn(styles.foot, styles.hint)}>
              {answer === UNSURE_INPUT ? `你选择了“${UNSURE_INPUT}”` : "你用自己的话回答了这个问题"}
            </p>
          )}
          </details>
        </>
      ) : (
        <div role="group" aria-label="建议选项" className={styles.options}>
          {card.options.map((option, index) => (
            <div key={option} className={styles.optionItem}>
              <Button
                type="button"
                variant="outline"
                className={styles.option}
                disabled={disabled}
                aria-describedby={index === reasonIndex ? reasonId : undefined}
                onClick={() => onAnswer?.(option, index)}
              >
                {option}
                {recommended(index)}
              </Button>
              {reason(index)}
            </div>
          ))}
          <Button type="button" variant="outline" className={styles.option} disabled={disabled} onClick={() => onOther?.()}>
            {OTHER_LABEL}
          </Button>
        </div>
      )}
      {/* Last in reading order so the options come first; drawn top-right. */}
      {docked && onDismiss && (
        <button type="button" className={styles.dismiss} aria-label="收起提问" onClick={onDismiss}><X size={15}/></button>
      )}
    </section>
  );
}

/** The conversation's record of the open card while it is docked to the message box. */
export function OpenQuestionRecord({ card, hidden = false, onShow }: {
  card: QuestionCard;
  /** The docked card was folded away by the user. */
  hidden?: boolean;
  onShow?: () => void;
}) {
  return (
    <section aria-label="导师提问记录" data-question-card="docked" className={cn(styles.card, styles.record)}>
      <div className={styles.head}><span>导师提问</span><span className={styles.status}>待回答</span></div>
      <p className={styles.question}>{card.question}</p>
      {hidden ? (
        <button type="button" className={styles.show} onClick={onShow}>显示选项</button>
      ) : (
        <p className={styles.hint}>选项在下方输入框上方，也可以直接输入回答。</p>
      )}
    </section>
  );
}
