/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
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
 inputSelection:z.enum(['scope-projection-v1','scope-projection-v2']).optional(),
 hostTurnContext:hostTurnContextSchema.optional(),historySelection:historySelectionSchema.optional(),
 providerRequestFormat:z.enum(PROVIDER_REQUEST_FORMATS).optional(),promptCache:promptCachePolicy.optional(),
 questionContract:z.enum([LEGACY_QUESTION_CONTRACT,QUESTION_CONTRACT]).optional(),reasoning:reasoningPolicy.optional(),
 historyItems:z.number().int().min(0).max(1000),purposeBudget:frozenPurposeBudget.optional(),
 tools:z.array(z.enum(['search','read_source',ASK_QUESTION_TOOL])).default([]),maxToolCalls:z.number().int().min(0).max(16).default(0),
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
 const host = context.hostTurnContext !== undefined;
 if (host !== (context.inputSelection === 'scope-projection-v2') || host !== (context.historySelection !== undefined) ||
     host && (context.role !== 'skill' || context.providerRequestFormat !== 'agent-turn-v5-stream') ||
     context.promptCache?.version === 'prompt-cache-v2' && !host ||
     host && context.promptCache?.version === 'prompt-cache-v1')
  ctx.addIssue({code: 'custom', message: 'RUNTIME_CONTEXT_INVALID'});
});
