/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from "zod";
const uuid = z.string().uuid();
export const opcSaveResult = z
  .object({
    draftId: uuid,
    executionId: uuid,
    stepId: z.string().min(1).max(64),
    requestId: uuid,
  })
  .strict();

export const STEP_ENVELOPE_INSTRUCTION = 'Return a JSON object whose first property is "message" '+
  '(the public reply string), followed by the private protocol fields. ';
export async function assertCompleteStepResult(
  rpc:(name:string,args:Record<string,unknown>)=>Promise<{result?:{completeness?:string;envelopeCompact?:boolean;organized?:boolean}}>,
  executionId:string,
) {
  const execution=await rpc('runtime_execution',{p_execution_id:executionId,p_action:'read'});
  if((execution.result?.completeness!==undefined&&execution.result.completeness!=='complete')
    ||execution.result?.envelopeCompact||execution.result?.organized===false)
    throw new Error('OPC_RESULT_DENIED');
}
