/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {ASK_QUESTION_TOOL} from '../../shared/agentTurn';

/** A complete, persisted v5 response that replay cannot repair. Transport errors
 * and incomplete receipts must remain pending instead of entering this path. */
export function terminalAgentReplyFailure(response:unknown,organizer=false):boolean {
  const reply=response as {choices?:Array<{finish_reason?:unknown;message?:{
    refusal?:unknown;content?:unknown;tool_calls?:Array<{function?:{name?:unknown}}>;
  }}>};
  if(!Array.isArray(reply?.choices)||reply.choices.length!==1)return false;
  const choice=reply.choices[0]!,message=choice.message;
  if(!message)return false;
  if(message.refusal||choice.finish_reason==='content_filter')return true;
  const calls=message.tool_calls;
  // v5 deliberately keeps only the first call. Later calls are ignored by the
  // runner, so an unknown later name must not invalidate an accepted first one.
  if(Array.isArray(calls)&&calls.length)return organizer||calls[0]?.function?.name!==ASK_QUESTION_TOOL;
  return organizer&&choice.finish_reason==='stop'&&
    (message.content==null||typeof message.content==='string'&&!message.content.trim());
}
