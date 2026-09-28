/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import {ASK_QUESTION_TOOL,MAX_OPTIONS,MIN_OPTIONS,OPTION_MAX_CHARS,QUESTION_MAX_CHARS} from '../../shared/agentTurn';
import {parseQuestionCard,questionCardSchema,type QuestionCard} from '../../shared/agentTurn';
import type {RuntimeTool} from './runner';

/** Interactive Agent turn tools (AC-1). Only the `agent-turn-v5-stream`
 * request format may carry them, and only when its frozen context lists them.
 * `read_skill_file` is named here for the provider and history allowlists;
 * its implementation arrives with AC1-5 and no context may list it yet. */
export const READ_SKILL_FILE_TOOL='read_skill_file';
export const AGENT_TOOL_NAMES:ReadonlySet<string>=new Set([ASK_QUESTION_TOOL,READ_SKILL_FILE_TOOL]);
/** The only tool of the older formats. */
export const SOURCE_TOOL_NAMES:ReadonlySet<string>=new Set(['read_source']);
/** At most this many tool definitions in one new-format request. */
export const MAX_AGENT_TOOLS=2;
/** Stream parsing for an Agent turn response: its tool names, and up to eight
 * indexed calls kept as evidence (the Runtime executes only the first). */
export const AGENT_STREAM_TOOLS=Object.freeze({toolNames:AGENT_TOOL_NAMES,maxCalls:8});

/** Parameters the model sees. Kept to plain JSON Schema limits (the locked
 * SDK sends strict schemas); the stricter card rules apply on execution. */
export const askQuestionParameters=z.object({
 question:z.string().min(1).max(QUESTION_MAX_CHARS),
 options:z.array(z.string().min(1).max(OPTION_MAX_CHARS)).min(MIN_OPTIONS).max(MAX_OPTIONS),
}).strict();

/** The tool result for a card the host refuses to show (arguments outside
 * the card rules). The turn still ends there: the already paid reply keeps its
 * text and is shown without a card. */
export const INVALID_CARD_RESULT=JSON.stringify({card:'invalid'});

/** The result the SDK stores for a shown card; history replays the same text. */
export function questionCardToolResult(value:unknown):string{
 const card=questionCardSchema.safeParse(value);
 if(!card.success)throw new Error('RUNTIME_QUESTION_CARD_INVALID');
 return JSON.stringify({card:'question',...card.data});
}

/** The card a turn's final tool result shows, or null. Anything else (the
 * invalid marker, the SDK's own text for unparsable arguments, plain text)
 * shows no card; the turn's text is kept either way. */
export function questionCardFromResult(output:string):QuestionCard|null{
 try{
  const value=JSON.parse(output) as unknown;
  if(!value||typeof value!=='object'||Array.isArray(value)||(value as {card?:unknown}).card!=='question')return null;
  const {card:_marker,...rest}=value as Record<string,unknown>;
  return parseQuestionCard(rest);
 }catch{return null;}
}

/** Showing a card has no external effect: its result is a pure function of
 * the arguments, so replay returns identical bytes without persistence. */
export function askQuestionTool():RuntimeTool{
 return {name:ASK_QUESTION_TOOL,parameters:askQuestionParameters,
  description:'Show the user one question card with 2 to 5 short suggested answers. Ends your turn.',
  invalidResult:INVALID_CARD_RESULT,execute:async args=>questionCardToolResult(args)};
}
