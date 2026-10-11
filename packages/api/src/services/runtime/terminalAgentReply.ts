/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {ASK_QUESTION_TOOL} from '../../shared/agentTurn';

const object=(value:unknown):value is Record<string,unknown>=>
  Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const terminalFinishes=new Set(['stop','length','tool_calls','content_filter']);

/** Called only after durable receipt, model identity and single-choice checks.
 * Missing/unknown finish reasons remain pending; replay cannot repair a known
 * terminal response whose message has a malformed protocol shape. A mentor
 * turn offered no card tool (a host-opened turn) cannot run any tool call. */
export function terminalAgentReplyFailure(response:unknown,organizer=false,cardOffered=true,skillFileOffered=false):boolean {
  if(!object(response)||!Array.isArray(response.choices)||response.choices.length!==1)return false;
  const choice=response.choices[0];
  if(!object(choice)||typeof choice.finish_reason!=='string'||!terminalFinishes.has(choice.finish_reason))return false;
  const message=choice.message;
  if(!object(message)||typeof message.content!=='string'&&message.content!==null||
    'tool_calls' in message&&!Array.isArray(message.tool_calls))return true;
  if(message.refusal||choice.finish_reason==='content_filter')return true;
  const calls=message.tool_calls;
  // v5 deliberately keeps only the first call. Later calls are ignored by the
  // runner, so an unknown later name must not invalidate an accepted first one.
  if(Array.isArray(calls)&&calls.length)return organizer||
    !(cardOffered&&calls[0]?.function?.name===ASK_QUESTION_TOOL||skillFileOffered&&calls[0]?.function?.name==='read_skill_file');
  return organizer&&choice.finish_reason==='stop'&&
    (message.content===null||typeof message.content==='string'&&!message.content.trim());
}
