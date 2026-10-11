/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';

/** Explicit UI action, distinct from speech; part of the frozen request identity. */
export const STEP_SUMMARY_INPUT = 'HOST_STEP_SUMMARY:v1';
export function isStepSummaryInput(input: string): boolean {
  if(input.startsWith('HOST_STEP_SUMMARY')&&input!==STEP_SUMMARY_INPUT)
    throw new Error('OPC_STEP_SUMMARY_INVALID');
  return input===STEP_SUMMARY_INPUT;
}
export const stepSummaryNoticeSchema=z.object({
  kind:z.literal('step_summary'),
  missingRequiredFieldIds:z.array(z.string().min(1).max(128)).max(100),
}).strict();
export type StepSummaryNotice=z.infer<typeof stepSummaryNoticeSchema>;
