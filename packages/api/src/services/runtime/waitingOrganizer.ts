/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import type {AgentTurnOutcome} from '../../shared/agentTurn';
import {StagingAccessError} from './stagingErrors';
import type {ResumeInput} from './paygRuntime';

const waitingOrganizer = z.object({
 executionId:z.string().uuid(),cursor:z.number().int().nonnegative(),epoch:z.number().int().nonnegative(),
 state:z.enum(['waiting_credits','waiting_resume','running','interrupted','cost_pending']),remainingCalls:z.number().int().nonnegative(),
});
export type ResumeWaitingOrganizer = (token:ResumeInput)=>Promise<AgentTurnOutcome>;
export type BlockedOrganizerAdmission = AgentTurnOutcome & {admitted:false;blockedRequestId:string;executionId:string};

/** A new user message is the trigger, not a scheduler. The host supplies the
 * original request budget/auth/transport; a bare service never invents one.
 * The new request is not admitted or stored: clients retain its request ID and
 * input until this original organizer completes and admission succeeds. */
export async function finishWaitingOrganizer(context:unknown,requestId:string,
 resume?:ResumeWaitingOrganizer):Promise<BlockedOrganizerAdmission|null>{
 const raw=z.object({waitingOrganizer:z.unknown().optional()}).parse(context).waitingOrganizer;
 if(raw===undefined||raw===null)return null;
 const waiting=waitingOrganizer.parse(raw);
 if(waiting.state!=='waiting_credits'&&waiting.state!=='waiting_resume')
  throw new StagingAccessError('RUNTIME_ORGANIZER_PENDING');
 const token={executionId:waiting.executionId,cursor:waiting.cursor,epoch:waiting.epoch};
 const result=resume?await resume(token):{...waiting,state:waiting.state,
  code:waiting.state==='waiting_credits'?'RUNTIME_WAITING_CREDITS' as const:'RUNTIME_WAITING_RESUME' as const};
 if(result.state==='completed')return null;
 return {...result,admitted:false,blockedRequestId:requestId,executionId:waiting.executionId};
}
