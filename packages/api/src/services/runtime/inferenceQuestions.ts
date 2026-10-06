/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {agentTurnBody, type QuestionCard} from '../../shared/agentTurn';

/** Render an explicitly declared hypothesis as a confirmation question. This checks
 * presentation, never attempts to infer intent or prove natural-language facts. */
export function inferenceQuestion(reason: string): string {
  const value = reason.trim().replace(/[。.!！?？]+$/u, '');
  return `我猜：${value}，对吗？`;
}
const marker = /^(\s*(?:[-*] |\d+[.)] )?)(?:我猜(?:测)?|我的推测|推测(?:，待你确认)?|猜测|假设|I guess|Hypothesis)\s*[:：,，]?\s*(.+)$/iu;
const PROSE_LIMIT = 262144;
const prefix = (text: string, limit: number) => text.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, '');
export function confirmationQuestions(text: string, complete = true, limit = PROSE_LIMIT): string {
  // A partial line may still become a declared hypothesis. Do not stream it as
  // a statement and retract it later. Completed lines keep their original order.
  const end = complete ? text.length : text.lastIndexOf('\n') + 1;
  let result = '';
  for (const [index, line] of text.slice(0, end).split('\n').entries()) {
    const match = marker.exec(line);
    const rendered = !match || /(?:对吗|是这样吗|是否如此|是否正确|是否准确|你认同吗|is that (?:right|correct)|does that sound right)[?？][”"’']?\s*$/iu.test(line)
      ? line : match[1] + inferenceQuestion(match[2]);
    const separator = index ? '\n' : '';
    const remaining = limit - result.length - separator.length;
    if (rendered.length > remaining) {
      const suffix = match ? '，对吗？' : '';
      if (remaining > suffix.length) result += separator + prefix(rendered, remaining - suffix.length) + suffix;
      break;
    }
    result += separator + rendered;
  }
  return result;
}

export function confirmProseTurn<T extends {body: string; message: string; card: QuestionCard | null}>(turn: T): T {
  if (turn.card) return turn;
  const message = confirmationQuestions(turn.message);
  const truncated = confirmationQuestions(turn.message, true, Infinity).length > PROSE_LIMIT;
  return {...turn, ...(truncated ? {truncated: true} : {}), message, body: agentTurnBody(message, null, PROSE_LIMIT)};
}
