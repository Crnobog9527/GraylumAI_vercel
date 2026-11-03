/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
type RunInput = { model: string; maxOutputTokens: number; instructions: string; input: string;
  exchange: (sequence: number, body: string, onChunk: () => void) => Promise<string> };
const m = vi.hoisted(() => ({ quote: vi.fn(), rows: [] as unknown[], sent: [] as Array<{ call: ModelCall; body: string }> }));
vi.mock('./admission/admissionConfiguration', () => ({ readAdmissionConfiguration: async () => ({ data: m.rows, error: null }) }));
vi.mock('./admission/newWorkGate', () => ({ readAdmissionSettings: async () => ({ ok: true, identityGuard: true }) }));
vi.mock('./quote', async original => ({ ...(await original<object>()), chatQuote: m.quote }));
// The model SDK is replaced by what it sends: one request with the instructions, the input, max_tokens and the frozen reasoning.
vi.mock('./agent/runner', () => ({ runRuntime: async (input: RunInput) => {
  const body = JSON.stringify({ model: input.model, stream: false, store: false, max_tokens: input.maxOutputTokens, reasoning_effort: 'low',
    messages: [{ role: 'system', content: input.instructions }, { role: 'user', content: input.input }] });
  return input.exchange(1, body, () => undefined);
} }));
// The paid call itself is replaced; everything before it (request builder, capacity check, bound) is real.
vi.mock('./call', async original => ({ ...(await original<object>()),
  modelCall: async (_deps: unknown, call: ModelCall, body: string) => { m.sent.push({ call, body }); return '本周表现：……'; } }));
import type { ModelCall } from './call';
import { openRouterAdapter } from './provider/openRouterAdapter';
import { openRouterBound, openRouterCallBound } from './provider/openRouterPolicy';
import { COACH_OUTPUT_TOKENS, REQUEST_ROOM_BYTES, runReviewTurn, type ReviewClaimInput } from './review';

const claim: ReviewClaimInput = { id: '11111111-1111-4111-8111-111111111111', actorId: '22222222-2222-4222-8222-222222222222',
  sessionId: '55555555-5555-4555-8555-555555555555', requestId: '44444444-4444-4444-8444-444444444444',
  modelId: '66666666-6666-4666-8666-666666666666', maxCostUsd: '1', cadence: 'weekly', attempt: 1, coach: true,
  coachMethod: '方法：先看 mode，再看卡点。' };
// Staging's Sonnet 5.5 route: 2.2 / 11 USD per million, 1M context; the context-window bound alone is 2.56 USD.
const limits = { providerSlug: 'anthropic', contextTokens: 1_000_000, promptUsdPerMillion: '2.2', completionUsdPerMillion: '11', requestUsd: '0' };
const nominalPricing = { version: 'nominal-v1' as const, pricingHash: 'a'.repeat(64), endpointTag: 'anthropic',
  tiers: [{ minPromptTokens: 0, prompt: '2.2', completion: '11', request: '0' }], timeOfDay: [] };
const pack = { review: { kind: 'review_pack', mode: 'full', rows: 'x'.repeat(10_000) } };
const quoteFor = (bytes: number) => {
  const upperUsd = openRouterCallBound(limits, COACH_OUTPUT_TOKENS, bytes + 8192).upperUsd;
  return { modelId: claim.modelId, model: 'anthropic/claude-sonnet-5.5', q: '100', multiplier: '6', upperUsd, pricing: nominalPricing,
    providerLimits: limits, outputLimit: 32768, inputLimit: bytes, concurrency: 20, reasoning: { effort: 'low' }, credential: async () => 'KEY',
    identity: { provider: 'openrouter', account: 'acct', model: 'anthropic/claude-sonnet-5.5', protocol: 'openrouter-chat-v1',
      providerLimits: limits, outputLimit: 32768, upperUsd },
    profile: { policyId: 'runtime_payg', policyVersion: 'v1', profileVersion: 'v1', evidenceVersion: 'e1', pricingHash: nominalPricing.pricingHash,
      endpointTag: 'anthropic', nominalPricing, templateTokens: 4096, marginTokens: 4096, maxBytes: 196_608, maxMessages: 128,
      maxSchemaBytes: 16_384 } };
};
const tomb = { sessionTombstoned: false, accountErasing: false, voiceSourceRevoked: false };
function deps() {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'turn_open') return { data: { turnId: 9, state: 'running', replay: false, reservedCredits: 120, reservedUsd: 0.2, history: [], replyLanguage: null }, error: null };
    if (name === 'turn_close') return { data: { turnId: 9, closeKind: args.p_close_kind, chargedCredits: 80, absorbedCredits: 0, settlement: 'done', replay: false, ...tomb }, error: null };
    return { data: { state: 'running', ...tomb }, error: null };
  });
  return { admin: { rpc } as never, clients: { write: { rpc }, read: { rpc, from: () => ({}) } } as never, slots: {} as never,
    newWork: { message: async () => ({ ok: true }), calls: async () => ({ ok: true }) } as never };
}
beforeEach(() => {
  vi.clearAllMocks(); m.sent.length = 0;
  m.rows = [{ key: 'core_path_v2', value: { enabled: true, decisionUpperUsd: '0.01', stopLoss: { limitUsd: 100, p: 4, poolSize: 16, uFastUsd: 1, uBigUsd: 5 } } },
    { key: 'billing_payg_start_thresholds', value: { version: '1', thresholds: [{ model: 'anthropic/claude-sonnet-5.5', purpose: 'ordinary', typicalUsd: '0.1' }] } }];
});

it('a coach review runs from the turn through the real request builder and the body-measured bound, and the adapter accepts what is sent', async () => {
  const { COACH_REQUEST, coachInstructions } = await import('./review');
  const { withBrandIdentity } = await import('../modelIdentity/brandIdentity');
  const bytes = Buffer.byteLength(COACH_REQUEST + JSON.stringify(pack.review)) + Buffer.byteLength(withBrandIdentity(coachInstructions(claim.coachMethod!), true)) + REQUEST_ROOM_BYTES;
  const quote = quoteFor(bytes);
  m.quote.mockResolvedValue(quote);
  const result = await runReviewTurn(deps(), claim, pack, async () => true);
  expect(result).toMatchObject({ kind: 'done', delivered: true });
  // The request was built under the policy's own context-window bound (the builder still re-checks that one) ...
  expect(m.sent).toHaveLength(1);
  const { call, body } = m.sent[0]!;
  expect(JSON.parse(body).max_tokens).toBe(COACH_OUTPUT_TOKENS);
  expect(Number(openRouterBound(limits, 32768).upperUsd)).toBeGreaterThan(2);
  // ... while the call's money bound is the one measured on that body: far below the cap, never above what the turn froze.
  expect(Number(call.upperUsd)).toBeLessThan(0.2);
  expect(Number(call.upperUsd)).toBeLessThanOrEqual(Number(quote.upperUsd));
  const adapter = openRouterAdapter({ credential: async () => 'KEY', transport: vi.fn() });
  await expect(adapter.prepareDispatch({ input: body }, call.identity)).resolves.toBeTypeOf('function');
  // Any other upper, or any other body, is refused.
  await expect(adapter.prepareDispatch({ input: body }, { ...call.identity, upperUsd: openRouterBound(limits, 32768).upperUsd })).rejects.toThrow('QUOTE_CONFLICT');
  await expect(adapter.prepareDispatch({ input: body + ' ' }, call.identity)).rejects.toThrow('QUOTE_CONFLICT');
});

it('a coach review without the Skill method waits: nothing is quoted, opened or sent', async () => {
  const result = await runReviewTurn(deps(), { ...claim, coachMethod: undefined }, pack, async () => true);
  expect(result).toEqual({ kind: 'deferred', code: 'COACH_METHOD_UNAVAILABLE' });
  expect(m.quote).not.toHaveBeenCalled();
  expect(m.sent).toHaveLength(0);
});
it('the method comes before the contract in the instructions, and the contract is always last', async () => {
  const { coachInstructions, COACH_CONTRACT } = await import('./review');
  const text = coachInstructions('方法正文');
  expect(text.startsWith('方法正文')).toBe(true);
  expect(text.endsWith(COACH_CONTRACT)).toBe(true);
});
it('a request larger than the one the turn froze is stopped before anything is sent', async () => {
  const quote = quoteFor(2_000);
  m.quote.mockResolvedValue(quote);
  const result = await runReviewTurn(deps(), claim, pack, async () => true);
  expect(m.sent).toHaveLength(0);
  expect(result).toMatchObject({ kind: 'done', delivered: false });
});
