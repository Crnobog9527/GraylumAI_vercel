/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import {AGENT_TURN_MESSAGE_LIMIT,ASK_QUESTION_TOOL,MAX_OPTIONS,MIN_OPTIONS,OPTION_MAX_CHARS,QUESTION_MAX_CHARS} from '../../shared/agentTurn';
import {parseQuestionCard,questionCardSchema,questionToolCardSchema,questionMessageSchema,type QuestionCard} from '../../shared/agentTurn';
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
export const AGENT_STREAM_TOOLS=Object.freeze({toolNames:AGENT_TOOL_NAMES,maxCalls:8,retainUnknownNames:true});

/** Parameters the model sees. Kept to plain JSON Schema limits (the locked
 * SDK sends strict schemas, so `recommended` is required and may be null). It
 * carries no bounds: the SDK would send zod's integer check as safe-integer
 * minimum/maximum, and a provider may reject an unsupported keyword (AC-0).
 * The stricter card rules, including an integer in-range index, apply on execution. */
export const askQuestionParameters=z.object({
 question:z.string().min(1).max(QUESTION_MAX_CHARS),
 options:z.array(z.string().min(1).max(OPTION_MAX_CHARS)).min(MIN_OPTIONS).max(MAX_OPTIONS),
 recommended:z.number().nullable(),
}).strict();

export const LEGACY_QUESTION_CONTRACT = 'five-fields-v1';
// v2 changes only host fallback; provider schema and description bytes are identical.
export const QUESTION_CONTRACT = 'five-fields-v2';
export const QUESTION_CONTRACT_INSTRUCTIONS = [
 'Question tool contract: when using a card, put the complete public prose in message,',
 'not in separate assistant text. This replaces only the separate-prose delivery rule.',
 'Use question and options for the same question and choices. Set recommendationReason',
 'to the nonempty reason for recommended, or null when recommended is null.',
 'Without a card, keep replying in public natural-language text.',
].join(' ');
export const questionParameters = askQuestionParameters.extend({
 message:z.string().min(1).max(AGENT_TURN_MESSAGE_LIMIT),
 recommendationReason:z.string().min(1).max(AGENT_TURN_MESSAGE_LIMIT).nullable(),
}).strict();

/** The tool result for a card the host refuses to show (arguments outside
 * the card rules). The turn still ends there: the already paid reply keeps its
 * text and is shown without a card. */
export const INVALID_CARD_RESULT=JSON.stringify({card:'invalid'});

/** Read only independently valid prose from complete, retained tool arguments.
 * The invalid tool result itself stays unchanged for deterministic Session replay. */
export function questionMessageFromArguments(arguments_:unknown):string|null{
 if(typeof arguments_!=='string')return null;
 try{
  const value:unknown=JSON.parse(arguments_);
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const message=questionMessageSchema.safeParse((value as {message?:unknown}).message);
  return message.success?message.data:null;
 }catch{return null;}
}

/** The result the SDK stores for a shown card; history replays the same text. */
export function questionCardToolResult(value:unknown,fiveFields=false):string{
 const card=(fiveFields?questionToolCardSchema:questionCardSchema).safeParse(value);
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
export function askQuestionTool(fiveFields=false):RuntimeTool{
 return {name:ASK_QUESTION_TOOL,parameters:fiveFields?questionParameters:askQuestionParameters,
  description:'Show the user one question card with 2 to 5 short suggested answers. recommended is the index of '+
   'the option you recommend, or null for neutral ranges or categories. The host adds an Other entry. Ends your turn.'+
   (fiveFields?' Put the complete public reply in message. recommendationReason must be nonempty for a recommendation, otherwise null.':''),
  invalidResult:INVALID_CARD_RESULT,execute:async args=>questionCardToolResult(args,fiveFields)};
}

/** Conservative serialized-tool allowance; the full SDK request is checked again before dispatch. */
export function askQuestionToolBytes(fiveFields=false):number {
 const tool=askQuestionTool(fiveFields);
 return Buffer.byteLength(JSON.stringify([{type:'function',function:{name:tool.name,description:tool.description,
  strict:true,parameters:z.toJSONSchema(tool.parameters!)}}]));
}
