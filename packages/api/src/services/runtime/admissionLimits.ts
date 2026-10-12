/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { PURPOSE_OUTPUT_CAP } from './purposeBudgets';

/** Output ceiling of a new admission: the selected limit, the model row, an organizer limit and the unified cap. */
export function admittedOutputLimit(selected: number, modelMaxTokens: unknown, organizerLimit = Infinity): number {
  return Math.min(selected, Number(modelMaxTokens), organizerLimit, PURPOSE_OUTPUT_CAP);
}

/** Frozen deadline of a new admission: at most one hour, never past the staging window. */
export function admissionDeadline(windowExpiresAt?: string, now = Date.now()): string {
  return new Date(Math.min(now + 3600000, windowExpiresAt ? Date.parse(windowExpiresAt) : Infinity)).toISOString();
}
