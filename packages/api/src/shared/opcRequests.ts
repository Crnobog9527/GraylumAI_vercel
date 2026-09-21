/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Pure request schemas shared by the server and browser before durable freezing.
import { z } from "zod";
const uuid = z.string().uuid();
export const planItem = z
  .object({
    id: uuid,
    platform: z.string().regex(/^[a-z0-9_-]{1,32}$/),
    account: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/),
    title: z.string().trim().min(1).max(160),
    brief: z.string().trim().min(1).max(2000),
    day: z.string().date(),
  })
  .strict();
export const opcPlan = z
  .object({
    draftId: uuid,
    requestId: uuid,
    expectedVersion: z.number().int().nonnegative(),
    sourceVersionId: uuid,
    body: z.array(planItem).min(1).max(28),
  })
  .strict();
export const opcHandoff = z
  .object({
    draftId: uuid,
    requestId: uuid,
    planId: uuid,
    accounts: z
      .array(
        planItem
          .pick({ platform: true, account: true })
          .extend({ expectedRevision: z.number().int().positive().nullable() }),
      )
      .min(1)
      .max(8),
  })
  .strict();
export const opcTopicTurn = z
  .object({ draftId: uuid, requestId: uuid, input: z.string().trim().min(1).max(8000) })
  .strict();
export const opcTopicDraft = opcPlan.extend({ executionId: uuid }).strict();
export const opcAdoptTopics = opcPlan.extend({
  accounts: opcHandoff.shape.accounts,
}).strict();
export const opcLibraryEdit = z.object({
  requestId: uuid,
  target: z.enum(["business", "account", "item"]),
  targetId: uuid,
  expectedRevision: z.number().int().positive(),
  patch: z.record(z.string(), z.string()),
}).strict();
export const opcContentFromExecution = z.object({
  workItemId: uuid,
  requestId: uuid,
  expectedVersion: z.number().int().nonnegative(),
  kind: z.enum(["brief", "script"]),
  status: z.enum(["draft", "final"]),
  executionId: uuid,
  sourceContentId: uuid.nullable().default(null),
}).strict();
export const opcVideoPackage = z.object({
  workItemId: uuid,
  requestId: uuid,
  executionId: uuid,
  sourceScriptId: uuid,
  expectedStoryboardVersion: z.number().int().nonnegative(),
  expectedEditingVersion: z.number().int().nonnegative(),
}).strict();
export const opcVideoResults = opcVideoPackage.extend({
  choice: z.enum(["both", "storyboard", "editing"]),
}).strict();
export const opcVideoExecutionCheck = z.object({
  workItemId: uuid,
  executionId: uuid,
  sourceScriptId: uuid,
}).strict();
export const opcVideoMaterialPrepare = z.object({
  workItemId: uuid,
  requestId: uuid,
  sourceScriptId: uuid,
  choice: z.enum(["both", "storyboard", "editing"]),
  expectedStoryboardVersion: z.number().int().nonnegative(),
  expectedEditingVersion: z.number().int().nonnegative(),
}).strict();
