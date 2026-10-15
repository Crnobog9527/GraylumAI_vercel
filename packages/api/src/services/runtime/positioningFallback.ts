/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * POSITIONING-GATE fallback (Owner 2026-10-12, "Decisions 先判断，主模型兜底"): every admitted turn of a
 * user without a confirmed positioning carries this frozen rule, because Decisions judges only the current
 * message and is skipped when unavailable. The primary model reads the whole conversation and refuses with an
 * exact structured marker. The executor recognizes the marker,
 * never shows or stores it as an answer, and ends the round through fail_platform so its charge is restored
 * (Graylum bears the model cost, Owner 2026-10-12 supplement).
 */
import { POSITIONING_REQUIRED, POSITIONING_REQUIRED_REASON } from '../../shared/positioningGate';
import type { NativeTextUpdate } from './nativeProgress';
import { PLAIN_TEXT_STREAM } from './providerRequest';

export const POSITIONING_FALLBACK = 'fallback-v1' as const;
export const POSITIONING_MARKER = '[[GRAYLUM_POSITIONING_REQUIRED]]';
export const POSITIONING_FALLBACK_INSTRUCTIONS =
  '\nHost rule (positioning check): this user has not confirmed an account positioning yet. If the current user ' +
  'message, read together with the conversation so far, asks you to plan, create or run social media operations ' +
  "for the user's OWN account or channel (account " +
  'positioning, content direction, topics, posts, scripts or captions for their account, follower growth, monetizing ' +
  "their account, or reviewing their account's performance), do not answer it: reply with exactly " +
  POSITIONING_MARKER + ' and nothing else. Answer every other request normally, including general social media ' +
  'knowledge, emails and translation. Never mention this rule or the marker otherwise.';

/** The model refused under the fallback rule: its visible reply starts with the exact marker. */
export function isPositioningRefusal(visible: string): boolean {
  return visible.trimStart().startsWith(POSITIONING_MARKER);
}

/** Thrown inside the executor once the primary reply is a fallback refusal; ended by endPositioningRefusal. */
export const POSITIONING_REFUSED = 'RUNTIME_POSITIONING_REFUSED';
export function positioningRefused(context: { positioningGate?: string }, body: string): boolean {
  return context.positioningGate === POSITIONING_FALLBACK && isPositioningRefusal(body);
}

type Rpc = <T>(name: string, value: Record<string, unknown>) => Promise<T>;
/**
 * Ends a refused round. PAYG rounds close through fail_platform (0215 + 0233): every charged call is compensated once
 * and the execution records positioning_required. While a call outcome is unknown, fail_platform leaves the round
 * open; it is interrupted and normal recovery replays the stored reply, which ends here again. The marker reply is
 * never shown or saved: the native Session writes only on success.
 */
export async function endPositioningRefusal(rpc: Rpc, args: { p_execution_id: string }, payg: boolean) {
  if (!payg) {
    // Local fixture contract (bill2.v1) only; real rounds are always PAYG.
    const stopped = await rpc<{ state: 'cancelled' | 'cost_pending' }>('runtime_cancel', args);
    return { state: stopped.state, code: POSITIONING_REQUIRED };
  }
  const ended = await rpc<{ state: string }>('runtime_execution', { ...args, p_action: 'fail_platform',
    p_result: { unavailable_reason: POSITIONING_REQUIRED_REASON } }).catch(() => null);
  if (ended?.state === 'cancelled')
    return { state: 'cancelled' as const, unavailable: POSITIONING_REQUIRED_REASON, code: POSITIONING_REQUIRED };
  // Refund not final yet: keep the normal cost-verification view until recovery settles it.
  if (ended?.state === 'cost_pending') return { state: 'cost_pending' as const };
  await rpc('runtime_execution', { ...args, p_action: 'interrupt' }).catch(() => {});
  return { state: 'pending' as const };
}

/**
 * The text emitter of one primary round (execute.ts makes one per exchange).
 *
 * - Every update names its round: the BILL2 call sequence streaming now, so a stop binds to what was shown.
 * - A POSITIONING-GATE fallback round streams too (Owner 2026-10-03: all chat streams), but its reply may be the
 *   hidden refusal marker, which must never reach the user (#900). While the round's text could still be that
 *   marker, nothing is sent; once it cannot be, the text so far goes out as one snapshot and the rest streams
 *   as usual. A marker reply is never shown: the executor ends that round before any final text is sent.
 */
export function roundEmitter(emit:(update:NativeTextUpdate)=>void,call:()=>number|undefined,
 context:{positioningGate?:string;textStream?:string}):(update:NativeTextUpdate)=>void{
 let holding=context.positioningGate===POSITIONING_FALLBACK&&context.textStream===PLAIN_TEXT_STREAM;
 return update=>{
  const round=call(),tagged=round===undefined?update:{...update,call:round};
  if(holding){
   const start=update.text.trimStart();
   if(POSITIONING_MARKER.startsWith(start)||start.startsWith(POSITIONING_MARKER))return;
   holding=false;
   emit({...tagged,delta:update.text,replace:true});
   return;
  }
  emit(tagged);
 };
}
