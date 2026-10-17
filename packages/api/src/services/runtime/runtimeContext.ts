/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {STEP_SUMMARY_INPUT} from '../../shared/opcStepSummary';
import {frozenSourceContent} from './contentSource';
import {skillFileBinding} from './skillFile';
import {frozenReport} from '../report/contract';
import {z} from 'zod';
import {promptCachePolicy} from './promptCache';
import {hostTurnContextSchema,historySelectionSchema} from './hostTurn';
import {PLAIN_TEXT_STREAM,PROVIDER_REQUEST_FORMATS,plainTextStreamAllowed} from './providerRequest';
import {QUESTION_CONTRACT,LEGACY_QUESTION_CONTRACT,READ_HISTORY_TOOL} from './agentTools';
import {MENTOR_HISTORY_VERSION,MENTOR_HISTORY_RESERVE_BYTES} from './mentorHistory';
import {ASK_QUESTION_TOOL} from '../../shared/agentTurn';
import {frozenPurposeBudget,FROZEN_OUTPUT_CAP} from './purposeBudgets';
import {matchingPlan} from './matching';
import {reasoningPolicy} from './reasoningPolicy';
import {frozenResearchTurn} from './researchTurn';
import {POSITIONING_RESEARCH_TOOLS} from '../research/tools/names';
/** Library documents the user referenced with @: each the caller's own document at the version they chose. */
export const libraryReferences=z.array(z.object({documentId:z.string().uuid(),version:z.number().int().positive()}).strict())
 .min(1).max(5).refine(items=>new Set(items.map(item=>item.documentId.toLowerCase())).size===items.length,'LIB_REFERENCE_INVALID');
export const runtimeContext=z.object({
 version:z.literal('runtime.v1'),sdkVersion:z.literal('0.18.0'),role:z.enum(['ordinary','skill','organizer']),
 input:z.string().min(1).max(20000),instructions:z.string().max(262144),model:z.string().min(1),
 maxOutputTokens:z.number().int().positive().max(FROZEN_OUTPUT_CAP),maxTurns:z.number().int().min(1).max(32),
 reportGeneration:frozenReport.optional(),
 mentorText:z.literal('append-card-v1').optional(),
 nativeOutput:z.literal('native-output-v1').optional(),envelopeOrder:z.literal('message-first-v1').optional(),
 textStream:z.literal(PLAIN_TEXT_STREAM).optional(),
 inputSelection:z.enum(['scope-projection-v1','scope-projection-v2']).optional(),
 hostTurnContext:hostTurnContextSchema.optional(),historySelection:historySelectionSchema.optional(),
 providerRequestFormat:z.enum(PROVIDER_REQUEST_FORMATS).optional(),promptCache:promptCachePolicy.optional(),
 questionContract:z.enum([LEGACY_QUESTION_CONTRACT,QUESTION_CONTRACT]).optional(),reasoning:reasoningPolicy.optional(),
 historyItems:z.number().int().min(0).max(1000),purposeBudget:frozenPurposeBudget.optional(),
 skillFile:skillFileBinding.optional(),
 skillFileReserve:z.number().int().min(12288).max(131072).optional(),
 historyRead:z.object({version:z.literal(MENTOR_HISTORY_VERSION),reserve:z.literal(MENTOR_HISTORY_RESERVE_BYTES)}).strict().optional(),
 tools:z.array(z.enum(['search','read_source','read_skill_file',READ_HISTORY_TOOL,ASK_QUESTION_TOOL,...POSITIONING_RESEARCH_TOOLS])).default([]),
 // RT-3b PR-3: a positioning mentor turn's research tools, routes, prices' phase and subcall allowance.
 research:frozenResearchTurn.optional(),
 maxToolCalls:z.number().int().min(0).max(16).default(0),
 modelId:z.string().uuid().optional(),network:z.enum(['deny','allow','require_latest']).optional(),
 attachedOrganizer:z.object({
  modelId:z.string().uuid(),model:z.string().min(1),
  maxOutputTokens:z.number().int().positive(),inputBytes:z.number().int().positive().optional(),
  historyItems:z.number().int().min(0).max(1000).optional(),
  reasoning:reasoningPolicy.optional(),instructions:z.string().max(12000).optional(),
  input:z.string().max(24000).optional()}).strict().optional(),
 // POSITIONING-GATE: Decisions was unavailable; the primary model carries the fallback rule.
 positioningGate:z.literal('fallback-v1').optional(),
 // SKILL-I18N-HOOK: the primary call carries the reply-language rule (absent on contexts admitted before it).
 replyLanguage:z.literal('reply-language-v1').optional(),
 // A2: the saved version a directly chosen derived-content Skill was admitted with (checkpoint_source injects it).
 sourceContent:frozenSourceContent.optional(),
 workspaceContext:z.boolean().optional(),opcTurnToken:z.string().uuid().optional(),matching:matchingPlan.optional(),scopeMaterial:z.unknown().optional(),
 answeredCard:z.unknown().optional(),request:z.unknown().optional(),
 moduleId:z.string().uuid().optional(),skillId:z.string().uuid().optional(),revisionId:z.string().uuid().optional(),sources:z.array(z.unknown()).optional(),
 // LIB-4: frozen with the execution by runtime_library_references_freeze (0262); read through read_source.
 libraryReferences:libraryReferences.optional(),
}).strict().superRefine((context, ctx) => {
 if (context.reportGeneration && (context.role !== 'skill' || context.historyItems !== 0 || context.maxTurns !== 1
   || context.tools.length || context.maxToolCalls || context.network !== 'deny' || context.attachedOrganizer
   || context.scopeMaterial || context.workspaceContext || context.promptCache || context.hostTurnContext
   || context.historySelection || context.sources?.length || context.libraryReferences
   || context.purposeBudget?.purpose !== 'report'))
  ctx.addIssue({code:'custom',message:'REPORT_CONTEXT_INVALID'});
 // A research slot adds one tool call and the model call that reads its result (a card turn already has one tool call).
 const researchSlot=context.research?1:0;
 if(Boolean(context.research)!==context.tools.some(name=>(POSITIONING_RESEARCH_TOOLS as readonly string[]).includes(name))||context.research&&
  (!context.hostTurnContext||context.hostTurnContext.opening||context.hostTurnContext.stepSummary||
   context.providerRequestFormat!=='agent-turn-v5-stream'||!context.tools.includes(ASK_QUESTION_TOOL)||context.network!=='deny'||
   context.maxTurns!==2+(context.skillFile?1:0)||context.maxToolCalls!==2))
  ctx.addIssue({code:'custom',message:'RUNTIME_RESEARCH_CONTEXT_INVALID'});
 if(Boolean(context.skillFile)!==context.tools.includes('read_skill_file')||context.skillFile&&
  (context.role!=='skill'||context.providerRequestFormat!=='agent-turn-v5-stream'||
   context.skillFile.packageId!==context.skillId||context.skillFile.revisionId!==context.revisionId||
   !context.moduleId||context.maxTurns!==2+researchSlot||context.maxToolCalls!==1+researchSlot))
  ctx.addIssue({code:'custom',message:'RUNTIME_SKILL_FILE_CONTEXT_INVALID'});
 // R4: earlier user messages share the bound Skill file's single read slot of a mentor turn.
 if(Boolean(context.historyRead)!==context.tools.includes(READ_HISTORY_TOOL)||context.historyRead&&
  (!context.skillFile||!context.opcTurnToken||!context.hostTurnContext||context.hostTurnContext.stepSummary||
   !context.tools.includes(ASK_QUESTION_TOOL)))
  ctx.addIssue({code:'custom',message:'RUNTIME_HISTORY_READ_CONTEXT_INVALID'});
 if(context.hostTurnContext?.stepSummary&&(context.input!==STEP_SUMMARY_INPUT||context.hostTurnContext.opening||
   context.tools.includes(ASK_QUESTION_TOOL)||context.attachedOrganizer))
  ctx.addIssue({code:'custom',message:'RUNTIME_STEP_SUMMARY_CONTEXT_INVALID'});
 if(context.textStream&&!plainTextStreamAllowed(context))ctx.addIssue({code:'custom',message:'RUNTIME_CONTEXT_INVALID'});
 const host = context.hostTurnContext !== undefined;
 if (host !== (context.inputSelection === 'scope-projection-v2') || host !== (context.historySelection !== undefined) ||
     host && (context.role !== 'skill' || context.providerRequestFormat !== 'agent-turn-v5-stream') ||
     context.promptCache?.version === 'prompt-cache-v2' && !host ||
     host && context.promptCache?.version === 'prompt-cache-v1')
  ctx.addIssue({code: 'custom', message: 'RUNTIME_CONTEXT_INVALID'});
});
