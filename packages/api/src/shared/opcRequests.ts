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
