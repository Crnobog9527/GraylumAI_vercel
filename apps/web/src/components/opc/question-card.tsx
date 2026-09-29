/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
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
 * "推荐" tag. The fixed "其他" entry sends nothing: it moves focus to the
 * message box below, where the user answers in their own words. The card
 * never locks that box.
 *
 * Once answered the card is history: the options are shown as text, the
 * chosen and recommended ones marked, and nothing is clickable.
 */
export function QuestionCardView({
  card,
  answered,
  answer = null,
  disabled = false,
  onAnswer,
  onOther,
}: {
  card: QuestionCard;
  answered: boolean;
  /** The user's reply to this card, when known. */
  answer?: string | null;
  /** Temporarily not sendable, for example while another reply is running. */
  disabled?: boolean;
  onAnswer?: (input: string) => void;
  /** Called by the fixed "其他" entry; the page focuses its message box. */
  onOther?: () => void;
}) {
  const status = answered ? (answer === null ? "已结束" : "已回答") : null;
  const recommended = (index: number) =>
    index === card.recommended && <span className={styles.chosenTag}>推荐</span>;
  return (
    <section aria-label="导师提问" data-question-card={answered ? "answered" : "open"} className={styles.card}>
      <div className={styles.head}>
        <span>导师提问</span>
        {status && <span className={styles.status}>{status}</span>}
      </div>
      <p className={styles.question}>{card.question}</p>
      {answered ? (
        <>
          <ul className={styles.options} aria-label="建议选项">
            {card.options.map((option, index) => (
              <li key={option} className={cn(styles.historyItem, option === answer && styles.chosen)}>
                {option}
                {recommended(index)}
                {option === answer && <span className={styles.chosenTag}>你的选择</span>}
              </li>
            ))}
          </ul>
          {answer !== null && !card.options.includes(answer) && (
            <p className={cn(styles.foot, styles.hint)}>
              {answer === UNSURE_INPUT ? `你选择了“${UNSURE_INPUT}”` : "你用自己的话回答了这个问题"}
            </p>
          )}
        </>
      ) : (
        <div role="group" aria-label="建议选项" className={styles.options}>
          {card.options.map((option, index) => (
            <Button
              key={option}
              type="button"
              variant="outline"
              className={styles.option}
              disabled={disabled}
              onClick={() => onAnswer?.(option)}
            >
              {option}
              {recommended(index)}
            </Button>
          ))}
          <Button type="button" variant="outline" className={styles.option} disabled={disabled} onClick={() => onOther?.()}>
            {OTHER_LABEL}
          </Button>
        </div>
      )}
    </section>
  );
}
