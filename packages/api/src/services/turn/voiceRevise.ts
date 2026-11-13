/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { logger } from '../../lib/logger';
import { applyRewrites, findOverlaps, REWRITE_INSTRUCTIONS, rewriteInput } from '../voice/overlap';
import { runRuntime } from './agent/runner';
import { modelCall, TurnStop } from './call';
import { turnSession } from './history';
import { FREE_CHAT_REQUEST_FORMAT, openRouterRequestBody, PLAIN_TEXT_STREAM, type RequestContext } from './provider/providerRequest';

/*
 * VOICE-2 PR-3 (Owner 2026-11-14: only the too-similar sentences are rewritten, the call is part of this reply and paid by its
 * usage): after a free-chat draft that was shown the user's past passages, code finds the sentences sharing a run of 12
 * characters with them and, only then, makes one more model call of this turn (frozen for it at the open) for those sentences.
 * The rewrites that still share a run are dropped. A deleted voice or a pause for credits ends the turn as any call would; any
 * other failure keeps the draft as it was.
 */
const REWRITE_OUTPUT_TOKENS = 4096;

/** The rewrite call as turnPolicy's "another model call": the same model under its own bound (its output cap is smaller), so the
 * freeze and the stop-loss count it and limits.model = 1 + tools + other calls holds, at the open and on a resume (chat.ts adds
 * one model call and passes one to resumeLimits when tools.voiceRewrite). None when the reply cannot be shown passages. */
export function voiceRewriteCalls(on: boolean, quote: { upperUsd: string; multiplier: string }) {
  return on ? [{ upperUsd: quote.upperUsd, multiplier: quote.multiplier }] : [];
}
type Deps = { quote: Parameters<typeof modelCall>[1] & { model: string; reasoning: unknown; outputLimit: number };
  callDeps: Parameters<typeof modelCall>[0]; callPolicy: unknown; callGate: (count: number) => Promise<void> };
type Args = Deps & { draft: string; shown: readonly string[] };

/** The draft to save, how many sentences were rewritten, and what the result event says of it (nothing when none was). */
type Revised = { text: string; revised: number; event: { voiceRevised?: number } };
const outcome = (text: string, revised: number): Revised => ({ text, revised, event: revised ? { voiceRevised: revised } : {} });

/** chat.ts's call: the draft, the tools this reply was built with (the passages it was shown), the turn's model call parts. */
export function reviseVoiceDraft(draft: string, built: { voiceShown?: () => string[] } | null, deps: Deps): Promise<Revised> {
  return reviseShown({ ...deps, draft, shown: built?.voiceShown?.() ?? [] });
}
export async function reviseShown(args: Args): Promise<Revised> {
  const overlaps = findOverlaps(args.draft, args.shown);
  if (!overlaps.length) return outcome(args.draft, 0);
  const context: RequestContext = { providerRequestFormat: FREE_CHAT_REQUEST_FORMAT, textStream: PLAIN_TEXT_STREAM, tools: [],
    network: 'deny', reasoning: args.quote.reasoning as RequestContext['reasoning'] };
  let streamed = '';
  try {
    const output = await runRuntime({
      model: args.quote.model, instructions: REWRITE_INSTRUCTIONS, input: rewriteInput(overlaps, args.shown), session: turnSession([]),
      maxOutputTokens: Math.min(args.quote.outputLimit, REWRITE_OUTPUT_TOKENS), maxTurns: 1, reasoning: args.quote.reasoning as never,
      tools: [], stream: true, readSessionHistory: false, selectHistory: async (_items, incoming) => incoming,
      onText: delta => { streamed += delta; },
      exchange: async (_sequence, body, onChunk) => {
        const request = openRouterRequestBody(body, { context, policy: args.callPolicy as never, phase: 'ordinary', primaryDialogue: true });
        await args.callGate(1);
        return modelCall(args.callDeps, args.quote, request, onChunk);
      },
    });
    const result = applyRewrites(args.draft, overlaps, output || streamed, args.shown);
    logger.info('ai', 'voice_draft_revised', { found: overlaps.length, revised: result.revised });
    return outcome(result.text, result.revised);
  } catch (error) {
    if (error instanceof TurnStop && (error.code === 'TURN_TOMBSTONED' || error.code === 'TURN_PAUSED_FOR_CREDITS')) throw error;
    logger.warn('ai', 'voice_draft_revise_failed', { found: overlaps.length, code: error instanceof TurnStop ? error.code : 'unknown' });
    return outcome(args.draft, 0);
  }
}
