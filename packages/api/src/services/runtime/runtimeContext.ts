/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {STEP_SUMMARY_INPUT} from '../../shared/opcStepSummary';
import {skillFileBinding} from './skillFile';
import {frozenReport} from '../report/contract';
import {z} from 'zod';
import {promptCachePolicy} from './promptCache';
import {hostTurnContextSchema,historySelectionSchema} from './hostTurn';
import {PROVIDER_REQUEST_FORMATS} from './providerRequest';
import {QUESTION_CONTRACT,LEGACY_QUESTION_CONTRACT} from './agentTools';
import {ASK_QUESTION_TOOL} from '../../shared/agentTurn';
import {frozenPurposeBudget,FROZEN_OUTPUT_CAP} from './purposeBudgets';
import {matchingPlan} from './matching';
import {reasoningPolicy} from './reasoningPolicy';
export const runtimeContext=z.object({
 version:z.literal('runtime.v1'),sdkVersion:z.literal('0.18.0'),role:z.enum(['ordinary','skill','organizer']),
 input:z.string().min(1).max(20000),instructions:z.string().max(262144),model:z.string().min(1),
 maxOutputTokens:z.number().int().positive().max(FROZEN_OUTPUT_CAP),maxTurns:z.number().int().min(1).max(32),
 reportGeneration:frozenReport.optional(),
 mentorText:z.literal('append-card-v1').optional(),
 nativeOutput:z.literal('native-output-v1').optional(),envelopeOrder:z.literal('message-first-v1').optional(),
 inputSelection:z.enum(['scope-projection-v1','scope-projection-v2']).optional(),
 hostTurnContext:hostTurnContextSchema.optional(),historySelection:historySelectionSchema.optional(),
 providerRequestFormat:z.enum(PROVIDER_REQUEST_FORMATS).optional(),promptCache:promptCachePolicy.optional(),
 questionContract:z.enum([LEGACY_QUESTION_CONTRACT,QUESTION_CONTRACT]).optional(),reasoning:reasoningPolicy.optional(),
 historyItems:z.number().int().min(0).max(1000),purposeBudget:frozenPurposeBudget.optional(),
 skillFile:skillFileBinding.optional(),
 skillFileReserve:z.number().int().min(12288).max(131072).optional(),
 tools:z.array(z.enum(['search','read_source','read_skill_file',ASK_QUESTION_TOOL])).default([]),maxToolCalls:z.number().int().min(0).max(16).default(0),
 modelId:z.string().uuid().optional(),network:z.enum(['deny','allow','require_latest']).optional(),
 attachedOrganizer:z.object({
  modelId:z.string().uuid(),model:z.string().min(1),
  maxOutputTokens:z.number().int().positive(),inputBytes:z.number().int().positive().optional(),
  historyItems:z.number().int().min(0).max(1000).optional(),
  reasoning:reasoningPolicy.optional(),instructions:z.string().max(12000).optional(),
  input:z.string().max(24000).optional()}).strict().optional(),
 workspaceContext:z.boolean().optional(),opcTurnToken:z.string().uuid().optional(),matching:matchingPlan.optional(),scopeMaterial:z.unknown().optional(),
 answeredCard:z.unknown().optional(),request:z.unknown().optional(),
 moduleId:z.string().uuid().optional(),skillId:z.string().uuid().optional(),revisionId:z.string().uuid().optional(),sources:z.array(z.unknown()).optional(),
}).strict().superRefine((context, ctx) => {
 if (context.reportGeneration && (context.role !== 'skill' || context.historyItems !== 0 || context.maxTurns !== 1
   || context.tools.length || context.maxToolCalls || context.network !== 'deny' || context.attachedOrganizer
   || context.scopeMaterial || context.workspaceContext || context.promptCache || context.hostTurnContext
   || context.historySelection || context.sources?.length || context.purposeBudget?.purpose !== 'report'))
  ctx.addIssue({code:'custom',message:'REPORT_CONTEXT_INVALID'});
 if(Boolean(context.skillFile)!==context.tools.includes('read_skill_file')||context.skillFile&&
  (context.role!=='skill'||context.providerRequestFormat!=='agent-turn-v5-stream'||
   context.skillFile.packageId!==context.skillId||context.skillFile.revisionId!==context.revisionId||
   !context.moduleId||context.maxTurns!==2||context.maxToolCalls!==1))
  ctx.addIssue({code:'custom',message:'RUNTIME_SKILL_FILE_CONTEXT_INVALID'});
 if(context.hostTurnContext?.stepSummary&&(context.input!==STEP_SUMMARY_INPUT||context.hostTurnContext.opening||
   context.tools.includes(ASK_QUESTION_TOOL)||context.attachedOrganizer))
  ctx.addIssue({code:'custom',message:'RUNTIME_STEP_SUMMARY_CONTEXT_INVALID'});
 const host = context.hostTurnContext !== undefined;
 if (host !== (context.inputSelection === 'scope-projection-v2') || host !== (context.historySelection !== undefined) ||
     host && (context.role !== 'skill' || context.providerRequestFormat !== 'agent-turn-v5-stream') ||
     context.promptCache?.version === 'prompt-cache-v2' && !host ||
     host && context.promptCache?.version === 'prompt-cache-v1')
  ctx.addIssue({code: 'custom', message: 'RUNTIME_CONTEXT_INVALID'});
});
