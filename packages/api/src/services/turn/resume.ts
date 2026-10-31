/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { TurnLimits } from './policy';

/*
 * CORE-PATH-V2 2.2 "充值后从断点继续": a turn paused for credits leaves nothing but its receipts, and they are enough. A resume goes
 * through the same turn again from the user's message: each model call answered by a receipt returns that completion, each paid
 * tool call answered by one takes its supplier results, without a request or a row, and the first call without a receipt is
 * the real next one. So what was done is neither done nor charged twice (the paused turn's receipts are carried, turn_resume_carry).
 * A free tool runs again; it costs nothing. A receipt finished by the recovery job's lookup holds no completion: the replay stops
 * there and that call is made for real.
 */
export const resumeRead = z.object({ kind: z.string(),
  limits: z.object({ model: z.number().int(), paidTools: z.number().int(), freeTools: z.number().int(), decisions: z.number().int() }),
  decided: z.boolean(),
  calls: z.array(z.object({ seq: z.number().int(), callKind: z.enum(['model', 'tool']), toolName: z.string().nullable(),
    status: z.enum(['ok', 'unusable']), body: z.string().nullable() })) });
export type ResumeRead = z.infer<typeof resumeRead>;

const completion = (body: string | null): string | null => {
  if (!body) return null;
  try { return Array.isArray((JSON.parse(body) as { choices?: unknown }).choices) ? body : null; } catch { return null; }
};

export type StoredTool = { status: 'ok' | 'unusable'; results: unknown[] };
export class TurnReplay {
  private readonly models: string[] = [];
  private readonly tools: Array<{ name: string } & StoredTool> = [];
  constructor(calls: ResumeRead['calls']) {
    for (const call of calls) {
      if (call.callKind === 'model') {
        const stored = completion(call.body);
        if (!stored) break;
        this.models.push(stored);
      } else {
        let results: unknown;
        try { results = JSON.parse(call.body ?? 'null'); } catch { results = null; }
        if (!Array.isArray(results) || !call.toolName) break;
        this.tools.push({ name: call.toolName, status: call.status, results });
      }
    }
  }
  /** The stored answer of the next model call, or null: that call is real. */
  model(): string | null { return this.models.shift() ?? null; }
  /** The stored results of the next paid call of this tool, or null: that call is real. */
  tool(name: string): StoredTool | null {
    if (this.tools[0]?.name !== name) return null;
    const { status, results } = this.tools.shift()!;
    return { status, results };
  }
}

/** The limits of a resumed turn: what the paused one has left, and every tool return still has its model call (turnPolicy's rule). */
export function resumeLimits(full: TurnLimits, left: ResumeRead['limits'], otherModelCalls = 0): TurnLimits {
  const room = Math.max(left.model - otherModelCalls - 1, 0);
  const freeTools = Math.min(full.freeTools, Math.max(left.freeTools, 0), room);
  const paidTools = Math.min(full.paidTools, Math.max(left.paidTools, 0), room - freeTools);
  return { model: 1 + paidTools + freeTools + otherModelCalls, paidTools, freeTools, decisions: Math.min(full.decisions, Math.max(left.decisions, 0)) };
}
