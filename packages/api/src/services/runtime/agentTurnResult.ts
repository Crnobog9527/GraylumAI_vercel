/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {AGENT_TURN_MESSAGE_LIMIT, INVALID_REPLY_NOTICE, agentTurnBody} from '../../shared/agentTurn';
import {questionCardFromResult} from './agentTools';

/** Tool output is never public prose, including invalid-card/SDK error markers. */
export function agentTurnResult(text: string, output: string, toolCalled: boolean, toolMessage?: string | null, native = false) {
  const card = toolCalled ? questionCardFromResult(output) : null;
  const fallback = toolMessage === undefined ? text : toolMessage ?? "";
  const raw = (card?.message ?? (toolCalled ? fallback : output || text)).trim();
  const limit = native ? 262144 : AGENT_TURN_MESSAGE_LIMIT;
  const truncated = raw.length > limit;
  const message = raw.slice(0, limit) || (!card ? INVALID_REPLY_NOTICE : '');
  return {body: agentTurnBody(message, card, limit), message, card, truncated};
}
