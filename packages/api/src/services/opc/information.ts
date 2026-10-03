/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from "zod";
const uuid = z.string().uuid();
export const opcInformation = z
  .object({
    draftId: uuid,
    stepId: z.string().min(1).max(64),
    requestId: uuid,
    expectedVersion: z.number().int().nonnegative(),
    values: z.record(
      z.string().max(64),
      z
        .object({
          status: z.enum([
            "unknown",
            "unclear",
            "provisional",
            "confirmed",
            "deferred",
          ]),
          nature: z.enum(["fact", "decision", "hypothesis", "unknown"]),
          value: z.string().max(400),
        })
        .strict(),
    ),
  })
  .strict();
