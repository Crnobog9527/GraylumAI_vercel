/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { RuntimeTool } from '../agent/runner';

/*
 * CONTENT-CONVERSATION-2 PR3b (Owner 2026-10-03 item 45: "用户在聊天框里发送了'帮我整理一下聊天纪要'，也可以触发这个整理功能"). A
 * signal only: no argument, nothing read or written, no Graylum charge of its own. The model calls it when the user clearly asks for
 * the minutes of this conversation (ENGINEERING 6: the model judges the intent, never a keyword); the step it leaves on the reply
 * ("整理纪要") is what the page reads to start the same minutes turn as the button, with a request id derived from this turn, so a
 * reload never starts a second one. The minutes are their own turn, charged on their own (turn/minutes.ts); this reply is charged as
 * any reply, by its usage.
 */
export const REQUEST_MINUTES_TOOL = 'request_minutes';
/** The step label the page reads (sse 'other' kind; turn_chat_steps_apply keeps labels up to 80 characters). */
export const REQUEST_MINUTES_LABEL = '整理纪要';
export const REQUEST_MINUTES_CALLS = 1;
const parameters = z.object({}).strict();

const DESCRIPTION = 'Start the minutes of this conversation, the same as the user pressing 整理纪要 (整理本选题 in a topic window). '
  + 'Takes no arguments, reads nothing and returns at once; the minutes are written after your reply, by the host, and charged on '
  + 'their own.';
export const REQUEST_MINUTES_INSTRUCTIONS = '\n\nMinutes: when the user clearly asks you to summarize or take the minutes of this '
  + 'conversation (for example 帮我整理一下聊天纪要, 总结一下我们聊的), call request_minutes once, then say in one short sentence that the '
  + 'minutes are being written in the panel on the right; never write the minutes in your reply. A request to tidy up, rewrite or '
  + 'summarize one piece of text is not a minutes request: answer it as usual. When the conversation has reached clear conclusions '
  + 'and the user has not asked, you may end your reply with one sentence saying they can press 整理纪要 on the right; at most once '
  + 'every ten replies, and never claim the minutes were made.';

/** The bytes the tool's definition adds to a request (planned before the turn opens). */
export function requestMinutesToolBytes(): number {
  return Buffer.byteLength(JSON.stringify({ type: 'function', function: { name: REQUEST_MINUTES_TOOL, description: DESCRIPTION, strict: true,
    parameters: z.toJSONSchema(parameters) } }));
}

/** Answered by the host at once; the page starts the minutes from the step this call leaves. */
export function requestMinutesTool(input: { usable: boolean; onCall: () => void }): RuntimeTool {
  let calls = 0;
  return { name: REQUEST_MINUTES_TOOL, description: DESCRIPTION, parameters, enabled: () => calls < REQUEST_MINUTES_CALLS,
    async execute() {
      if (!input.usable || calls >= REQUEST_MINUTES_CALLS) return JSON.stringify({ status: 'not_supported', reason: 'TOOL_UNAVAILABLE_THIS_TURN' });
      calls++; input.onCall();
      return JSON.stringify({ status: 'ok', note: 'The host starts the minutes after this reply. Say so in one short sentence; do not write them.' });
    } };
}
