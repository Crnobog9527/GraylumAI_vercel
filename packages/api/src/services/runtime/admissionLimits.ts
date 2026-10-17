/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { PURPOSE_OUTPUT_CAP } from './purposeBudgets';
import { currentRequestTiming } from './timing';

/** Output ceiling of a new admission: the selected limit, the model row, an organizer limit and the unified cap. */
export function admittedOutputLimit(selected: number, modelMaxTokens: unknown, organizerLimit = Infinity): number {
  return Math.min(selected, Number(modelMaxTokens), organizerLimit, PURPOSE_OUTPUT_CAP);
}

/** Frozen deadline of a new admission: at most one hour, never past the staging window. */
export function admissionDeadline(windowExpiresAt?: string, now = Date.now()): string {
  return new Date(Math.min(now + 3600000, windowExpiresAt ? Date.parse(windowExpiresAt) : Infinity)).toISOString();
}

/** AC-0 measurement: admission and Skill loading form their own timing phase. */
export async function timedAdmission<T>(run:()=>Promise<T>):Promise<T>{
 const timing=currentRequestTiming(),leave=timing?.enter('admission');
 try{
  const result=await run();
  timing?.tagExecution((result as {executionId?:unknown}|null)?.executionId);
  return result;
 }finally{leave?.();}
}
