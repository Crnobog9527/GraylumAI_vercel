/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {AGENT_TURN_MESSAGE_LIMIT, INVALID_REPLY_NOTICE, agentTurnBody} from '../../shared/agentTurn';
import {questionCardFromResult} from './agentTools';

/** Tool output is never public prose, including invalid-card/SDK error markers. */
export function agentTurnResult(text: string, output: string, toolCalled: boolean) {
  const card = toolCalled ? questionCardFromResult(output) : null;
  const raw = (toolCalled ? text : output || text).trim();
  const truncated = raw.length > AGENT_TURN_MESSAGE_LIMIT;
  const message = raw.slice(0, AGENT_TURN_MESSAGE_LIMIT) || (!card ? INVALID_REPLY_NOTICE : '');
  return {body: agentTurnBody(message, card), message, card, truncated};
}
