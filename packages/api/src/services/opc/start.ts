/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from "zod";
const uuid = z.string().uuid();
export const opcStart = z
  .object({
    requestId: uuid,
    registration: z.string().min(1).max(100),
    mode: z.enum(["mentor", "manual"]),
    businessId: uuid.nullable().optional(),
    businessName: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export const opcTopicBind = z
  .object({ draftId: uuid, requestId: uuid, sourceVersionId: uuid })
  .strict();
