/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { runChatTurn, type ChatDeps } from './chat';
import { turnDatabase, TurnDatabaseError } from './db';
import { runMentorTurn } from './mentor';
import { mentorAnswer } from './mentorInput';
import type { TurnEvent } from './sse';

/*
 * CORE-PATH-V2 2.2: POST /api/turn with kind=resume. The paused turn says what it was (saved at the pause, turn_pause_save) and what it
 * has left, and the same kind runs again from those. Nothing comes from the page, so any device can continue. A pause whose
 * save failed cannot continue: it ends now as the 24-hour expiry would, refunded in full, and the conversation is free again.
 */
const reference = z.object({ kind: z.literal('library_document'), documentId: z.string().uuid(), version: z.number().int().positive() });
const saved = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat'), text: z.string(), chosen: z.object({ moduleId: z.string().optional(), references: z.array(reference).optional() }).optional() }),
  z.object({ kind: z.literal('mentor'), moduleId: z.string(), stepId: z.string(), text: z.string(), organizeAfter: z.boolean(),
    answer: mentorAnswer.optional(), researchRefreshId: z.string().optional() }),
]);

export async function runResumedTurn(deps: ChatDeps, input: { actorId: string; sessionId: string; requestId: string; resumeOf: number },
  emit: (event: TurnEvent) => void): Promise<void> {
  const db = turnDatabase(deps.clients), { actorId, sessionId, requestId, resumeOf } = input;
  let read;
  try { read = await db.resumeRead({ actorId, sessionId, turnId: resumeOf }); }
  catch (error) { return emit({ type: 'error', code: error instanceof TurnDatabaseError ? error.code : 'TURN_RESUME_DENIED' }); }
  const asked = saved.safeParse(read.input);
  if (!asked.success) {
    await db.close({ actorId, turnId: resumeOf, kind: 'expired', messages: [], delivered: false, refundAll: true, failureCode: 'resume_input_lost' });
    return emit({ type: 'error', code: 'TURN_RESUME_INPUT_LOST' });
  }
  const resume = { of: resumeOf, read }, ids = { actorId, sessionId, requestId, resume };
  if (asked.data.kind === 'chat') {
    const { text, chosen } = asked.data;
    return runChatTurn(deps, { ...ids, text, ...(chosen ? { chosen: { ...chosen } as never } : {}) }, emit);
  }
  const { kind: _kind, ...mentor } = asked.data;
  return runMentorTurn(deps as never, { ...ids, ...mentor } as never, emit);
}
