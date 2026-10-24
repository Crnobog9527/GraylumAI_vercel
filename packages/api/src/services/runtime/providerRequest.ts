/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type {z} from 'zod';
import {applyPromptCache,type PromptCachePolicy} from './promptCache';
import {decimal} from '../bill2/decimal';
import {openRouterBound} from '../bill2/openRouterPolicy';
import type {frozenCallPolicy} from '../bill2/service';
import {normalizeOpenRouterHistory} from './openRouterHistory';
import {matchesFrozenReasoning,reasoningPolicy,type ReasoningPolicy} from './reasoningPolicy';
import {AGENT_TOOL_NAMES,FREE_CHAT_TOOL_NAMES,SOURCE_TOOL_NAMES} from './agentTools';

/** The request formats a frozen Runtime context may carry. */
export const PROVIDER_REQUEST_FORMATS=['serial-tools-v1','serial-tools-v2','serial-tools-v3-stream',
 'serial-tools-v4-stream','agent-turn-v5-stream','serial-tools-v6-reasoning'] as const;
export type ProviderRequestFormat=typeof PROVIDER_REQUEST_FORMATS[number];
/** Streamed formats. */
export const STREAMING_FORMATS:ReadonlySet<string>=new Set(['serial-tools-v3-stream','serial-tools-v4-stream','agent-turn-v5-stream']);
/** Formats that must, and alone may, carry a frozen reasoning policy. */
export const REASONING_FORMATS:ReadonlySet<string>=new Set(['serial-tools-v4-stream','agent-turn-v5-stream','serial-tools-v6-reasoning']);
/** Format of new real free-chat (ordinary) turns: non-streamed, with frozen interactive reasoning. */
export const FREE_CHAT_REQUEST_FORMAT='serial-tools-v6-reasoning';
/**
 * Frozen-context marker of a plain-text turn whose primary reply streams (CHAT-NATIVE-OUTPUT).
 * It never changes the request format: a marked v2 (Skill) or v6 (free chat) turn sends the same
 * bytes plus `stream`, and an unmarked turn of any format keeps its original bytes.
 */
export const PLAIN_TEXT_STREAM='plain-text-v1';
/**
 * Where the plain-text stream marker may be frozen: native plain replies, never cards, envelopes or reports.
 * A POSITIONING-GATE fallback round streams too; roundEmitter holds its text while it may be the refusal marker.
 */
export function plainTextStreamAllowed(context:{providerRequestFormat?:string;nativeOutput?:string;envelopeOrder?:string;
 reportGeneration?:unknown;matching?:unknown;role?:string;attachedOrganizer?:unknown;positioningGate?:string}):boolean{
 return Boolean(context.nativeOutput)&&!context.envelopeOrder&&!context.reportGeneration&&!context.matching&&
  !context.attachedOrganizer&&(context.providerRequestFormat==='serial-tools-v6-reasoning'
   &&(context.role==='ordinary'||context.role==='skill')||context.providerRequestFormat==='serial-tools-v2'&&context.role==='skill');
}
/** True when the frozen context streams its primary reply. */
export function streamsPrimary(context:{providerRequestFormat?:string;textStream?:string}):boolean{
 return STREAMING_FORMATS.has(context.providerRequestFormat??'')||context.textStream===PLAIN_TEXT_STREAM;
}
/** Interactive Agent turn format (AC-1). Used by new mentor admissions. */
export const AGENT_TURN_REQUEST_FORMAT='agent-turn-v5-stream';

type FrozenCallPolicy=z.infer<typeof frozenCallPolicy>;
/** Only the frozen context fields that decide the provider bytes. */
export type RequestContext={providerRequestFormat?:ProviderRequestFormat;textStream?:string;tools:readonly string[];workspaceContext?:boolean;
 libraryReferences?:readonly unknown[];libraryRetrieval?:boolean;research?:{freeChat?:string};skillCatalog?:readonly unknown[];
 promptCache?:PromptCachePolicy;network?:string;reasoning?:ReasoningPolicy;attachedOrganizer?:{reasoning?:ReasoningPolicy}};

/** Fail closed for reasoning attached to an older, unmarked request format. */
export function validReasoningFormat(context:RequestContext):boolean{
 const allowed=REASONING_FORMATS.has(context.providerRequestFormat??'');
 return allowed===Boolean(context.reasoning)&&
  (!context.reasoning||reasoningPolicy.safeParse(context.reasoning).success)&&
  (!context.attachedOrganizer?.reasoning||allowed&&reasoningPolicy.safeParse(context.attachedOrganizer.reasoning).success);
}

/** Tool names whose history a format may replay (v6 also free chat's research calls, CHAT-AUTO-CONTEXT C). */
export function historyToolNames(format:ProviderRequestFormat|undefined):ReadonlySet<string>{
 return format===AGENT_TURN_REQUEST_FORMAT?AGENT_TOOL_NAMES:format===FREE_CHAT_REQUEST_FORMAT?FREE_CHAT_TOOL_NAMES:SOURCE_TOOL_NAMES;
}

/** Turns the SDK's request into the exact OpenRouter bytes that are hashed,
 * claimed and sent. Every rule checks frozen context, never request content
 * alone. Primary and attached organizer calls use independent frozen values. */
export function openRouterRequestBody(request:string,options:{context:RequestContext;policy:FrozenCallPolicy;phase:string;primaryDialogue:boolean}):string{
 const {context,policy,phase}=options;
 if(!validReasoningFormat(context))throw new Error('RUNTIME_CONTEXT_INVALID');
 const original=JSON.parse(request);
 const format=context.providerRequestFormat,streaming=streamsPrimary(context);
 const requested:Array<{type?:string;function?:{name?:string}}>=original.tools??[];
 // Agent turns may use only the interactive tools their context lists; every
 // older format may use only the owned-source read of a workspace context
 // or of frozen library references (LIB-4b).
 const ownedRead=Boolean(context.workspaceContext||context.libraryReferences?.length||context.libraryRetrieval);
 // CHAT-AUTO-CONTEXT C: a v6 free chat that froze research tools may also use exactly the ones its context lists.
 const freeChatResearch=format===FREE_CHAT_REQUEST_FORMAT&&Boolean(context.research?.freeChat);
 // CONTENT-CONVERSATION-DRIVEN: load_skill only where admission froze a Skill catalog.
 const olderToolAllowed=(name:string)=>name==='read_source'?ownedRead:name==='load_skill'?Boolean(context.skillCatalog?.length):
  freeChatResearch&&FREE_CHAT_TOOL_NAMES.has(name);
 const toolsDenied=format===AGENT_TURN_REQUEST_FORMAT
  ?context.tools.some(name=>!AGENT_TOOL_NAMES.has(name))||Boolean(context.workspaceContext)||
   requested.some(tool=>tool.type!=='function'||!context.tools.includes(String(tool.function?.name)))
  :context.tools.some(name=>!olderToolAllowed(name))||
   requested.some(tool=>tool.type!=='function'||!olderToolAllowed(String(tool.function?.name))||
    tool.function?.name!=='read_source'&&!context.tools.includes(String(tool.function?.name)));
 if(toolsDenied||context.network!=='deny'||original.model!==policy.model)throw new Error('RUNTIME_REAL_TOOLS_DISABLED');
 if(!policy.providerLimits)throw new Error('RUNTIME_REAL_QUOTE_REQUIRED');
 // Matching carries no reasoning; the attached organizer has its own frozen value.
 const reasoning=phase==='attached_organizer'?context.attachedOrganizer?.reasoning:
  options.primaryDialogue?context.reasoning:undefined;
 if(!matchesFrozenReasoning(original,reasoning))throw new Error('RUNTIME_PROVIDER_BINDING_DENIED');
 const quoted=openRouterBound(policy.providerLimits,policy.outputLimit);
 if(decimal(quoted.upperUsd)!==decimal(policy.upperUsd))throw new Error('RUNTIME_REAL_QUOTE_CONFLICT');
 // This optional SDK hint excludes providers that otherwise support tools.
 // New admissions freeze this format before hashing. Unmarked executions
 // keep their original bytes for replay; the runner enforces one tool/turn.
 if(format)delete original.parallel_tool_calls;
 if(format==='serial-tools-v2'||format==='serial-tools-v6-reasoning'||streaming)normalizeOpenRouterHistory(original,historyToolNames(format));
 if(context.promptCache&&options.primaryDialogue&&phase!=='attached_organizer')
  applyPromptCache(original,context.promptCache,policy.model,policy.providerLimits.cacheWriteUsdPerMillion);
 return JSON.stringify({...original,stream:streaming&&phase!=='attached_organizer'&&Boolean(original.stream),provider:quoted.routing});
}
