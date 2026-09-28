/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type {z} from 'zod';
import {decimal} from '../bill2/decimal';
import {openRouterBound} from '../bill2/openRouterPolicy';
import type {frozenCallPolicy} from '../bill2/service';
import {normalizeOpenRouterHistory} from './openRouterHistory';
import {AGENT_TOOL_NAMES,SOURCE_TOOL_NAMES} from './agentTools';

/** The request formats a frozen Runtime context may carry. */
export const PROVIDER_REQUEST_FORMATS=['serial-tools-v1','serial-tools-v2','serial-tools-v3-stream','serial-tools-v4-stream','agent-turn-v5-stream'] as const;
export type ProviderRequestFormat=typeof PROVIDER_REQUEST_FORMATS[number];
/** Streamed formats. */
export const STREAMING_FORMATS:ReadonlySet<string>=new Set(['serial-tools-v3-stream','serial-tools-v4-stream','agent-turn-v5-stream']);
/** Formats that must, and alone may, carry a frozen reasoning policy. */
export const REASONING_FORMATS:ReadonlySet<string>=new Set(['serial-tools-v4-stream','agent-turn-v5-stream']);
/** Interactive Agent turn format (AC-1). No admission produces it yet. */
export const AGENT_TURN_REQUEST_FORMAT='agent-turn-v5-stream';

type FrozenCallPolicy=z.infer<typeof frozenCallPolicy>;
/** Only the frozen context fields that decide the provider bytes. */
export type RequestContext={providerRequestFormat?:ProviderRequestFormat;tools:readonly string[];workspaceContext?:boolean;
 network?:string;reasoning?:{effort:string}};

/** Tool names whose history a format may replay. */
export function historyToolNames(format:ProviderRequestFormat|undefined):ReadonlySet<string>{
 return format===AGENT_TURN_REQUEST_FORMAT?AGENT_TOOL_NAMES:SOURCE_TOOL_NAMES;
}

/** Turns the SDK's request into the exact OpenRouter bytes that are hashed,
 * claimed and sent. Every rule checks frozen context, never request content
 * alone. `primaryDialogue` marks the one call that carries reasoning. */
export function openRouterRequestBody(request:string,options:{context:RequestContext;policy:FrozenCallPolicy;phase:string;primaryDialogue:boolean}):string{
 const {context,policy,phase}=options;
 const original=JSON.parse(request);
 const format=context.providerRequestFormat,streaming=Boolean(format&&STREAMING_FORMATS.has(format));
 const requested:Array<{type?:string;function?:{name?:string}}>=original.tools??[];
 // Agent turns may use only the interactive tools their context lists; every
 // older format may use only the owned-source read of a workspace context.
 const toolsDenied=format===AGENT_TURN_REQUEST_FORMAT
  ?context.tools.some(name=>!AGENT_TOOL_NAMES.has(name))||Boolean(context.workspaceContext)||
   requested.some(tool=>tool.type!=='function'||!context.tools.includes(String(tool.function?.name)))
  :context.tools.some(name=>name!=='read_source'||!context.workspaceContext)||
   requested.some(tool=>tool.type!=='function'||tool.function?.name!=='read_source'||!context.workspaceContext);
 if(toolsDenied||context.network!=='deny'||original.model!==policy.model)throw new Error('RUNTIME_REAL_TOOLS_DISABLED');
 if(!policy.providerLimits)throw new Error('RUNTIME_REAL_QUOTE_REQUIRED');
 // Only the primary dialogue call carries the frozen reasoning policy.
 // Matching and organizer calls keep their original bytes.
 const reasoning=options.primaryDialogue?context.reasoning?.effort:undefined;
 if('reasoning' in original||original.reasoning_effort!==reasoning)throw new Error('RUNTIME_PROVIDER_BINDING_DENIED');
 const quoted=openRouterBound(policy.providerLimits,policy.outputLimit);
 if(decimal(quoted.upperUsd)!==decimal(policy.upperUsd))throw new Error('RUNTIME_REAL_QUOTE_CONFLICT');
 // This optional SDK hint excludes providers that otherwise support tools.
 // New admissions freeze this format before hashing. Unmarked executions
 // keep their original bytes for replay; the runner enforces one tool/turn.
 if(format)delete original.parallel_tool_calls;
 if(format==='serial-tools-v2'||streaming)normalizeOpenRouterHistory(original,historyToolNames(format));
 return JSON.stringify({...original,stream:streaming&&phase!=='attached_organizer'&&Boolean(original.stream),provider:quoted.routing});
}
