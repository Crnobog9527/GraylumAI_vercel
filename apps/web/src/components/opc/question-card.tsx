/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { UNSURE_INPUT, type QuestionCard } from "@repo/api/src/shared/agentTurn";
import styles from "./question-card.module.css";

/**
 * One mentor question with suggested answers. A choice is sent as the next
 * turn's plain user input: an option sends its own text, the fixed button
 * sends `UNSURE_INPUT`. The card never locks the message box below it; the
 * user can always type a free answer there instead.
 *
 * Once answered the card is history: the options are shown as text, the
 * chosen one marked, and nothing is clickable.
 */
export function QuestionCardView({
  card,
  answered,
  answer = null,
  disabled = false,
  onAnswer,
}: {
  card: QuestionCard;
  answered: boolean;
  /** The user's reply to this card, when known. */
  answer?: string | null;
  /** Temporarily not sendable, for example while another reply is running. */
  disabled?: boolean;
  onAnswer?: (input: string) => void;
}) {
  const status = answered ? (answer === null ? "已结束" : "已回答") : null;
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
            {card.options.map(option => (
              <li key={option} className={cn(styles.historyItem, option === answer && styles.chosen)}>
                {option}
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
        <>
          <div role="group" aria-label="建议选项" className={styles.options}>
            {card.options.map(option => (
              <Button
                key={option}
                type="button"
                variant="outline"
                className={styles.option}
                disabled={disabled}
                onClick={() => onAnswer?.(option)}
              >
                {option}
              </Button>
            ))}
          </div>
          <div className={styles.foot}>
            <Button
              type="button"
              variant="outline"
              className={styles.unsure}
              disabled={disabled}
              onClick={() => onAnswer?.(UNSURE_INPUT)}
            >
              {UNSURE_INPUT}
            </Button>
            <p className={styles.hint}>也可以在下方输入框直接回答</p>
          </div>
        </>
      )}
    </section>
  );
}
