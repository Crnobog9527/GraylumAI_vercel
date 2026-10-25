/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// ARCH-FIX C1: invalid tool arguments go back to the model, the limits reach it, and a research supplier request waits
// no longer than the round has left. The wire checks run through the real Agents SDK (runRuntime), as a request is sent.
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { INVALID_TOOL_ARGUMENTS, runRuntime, type RuntimeTool } from './runner';
import { researchToolBytes } from './researchAdmission';
import { researchRuntimeTools, researchToolDescription, researchToolParameters } from './researchRuntimeTool';
import { frozenResearchTurn, RESEARCH_PHASE, RESEARCH_RESULT_RESERVE_BYTES, RESEARCH_TOOL_LIMITS, RESEARCH_TURN_VERSION } from './researchTurn';
import { MIN_SUPPLIER_MS, supplierTimeout } from './researchExecution';
import { createRuntimeBudget, MIN_MODEL_DISPATCH_MS } from './budget';
import { mentorHistoryTool } from './mentorHistory';
import { loadSkillTool } from './loadSkillTool';
import { skillFileTool } from './skillFile';
import { RESEARCH_TOOL_NAMES, type ResearchToolName } from '../research/tools/schemas';
import type { ResearchToolContext } from '../research/runtime/toolContext';

type Wire = { messages: Array<{ role: string; content?: unknown }>; tools?: Array<{ function: { name: string; parameters: unknown } }> };
const session = { getSessionId: async () => 's', getItems: async () => [], addItems: async () => {}, popItem: async () => undefined,
  clearSession: async () => {} };
const reply = (message: Record<string, unknown>, finish = 'stop') => JSON.stringify({ id: 'r', object: 'chat.completion', created: 0,
  model: 'm', choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', ...message } }] });
const call = (name: string, args: unknown, id = 'c1') => reply({ content: null, tool_calls: [{ id, type: 'function',
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] }, 'tool_calls');

/** One SDK run; returns the requests the SDK sent and the final output (or the error it ended with). */
async function run(tools: RuntimeTool[], responses: string[], maxTurns = 3) {
  const requests: Wire[] = [];
  let output: string | Error;
  try {
    output = await runRuntime({ model: 'm', instructions: 'i', input: 'hi', maxOutputTokens: 100, maxTurns, session: session as never,
      persistSession: false, selectHistory: async (history: unknown[], incoming: unknown[]) => [...history, ...incoming], tools,
      exchange: async (_sequence: number, body: string) => { requests.push(JSON.parse(body)); return responses.shift() ?? reply({ content: 'end' }); },
    } as never);
  } catch (error) { output = error as Error; }
  return { requests, output };
}
const lastToolResult = (request: Wire) => JSON.stringify(request.messages.at(-1));

/** Every string the model is offered is bounded: a maxLength, a fixed value list or a uuid pattern. */
function unboundedStrings(schema: unknown, path = '$'): string[] {
  if (Array.isArray(schema)) return schema.flatMap((item, i) => unboundedStrings(item, `${path}[${i}]`));
  if (!schema || typeof schema !== 'object') return [];
  const node = schema as Record<string, unknown>;
  const own = node.type === 'string' && node.maxLength === undefined && node.enum === undefined && node.const === undefined
    && node.pattern === undefined ? [path] : [];
  return [...own, ...Object.entries(node).flatMap(([key, value]) => unboundedStrings(value, `${path}.${key}`))];
}
const researchTool = (name: ResearchToolName, fast: boolean, declared: boolean, freeChat = false): RuntimeTool =>
  ({ name, description: researchToolDescription(name, freeChat), parameters: researchToolParameters(name, fast, declared), execute: async () => '' });

describe('research tool parameters declare their limits', () => {
  for (const fast of [false, true]) {
    it(`the SDK request carries every limit (fast search only: ${fast})`, async () => {
      const { requests } = await run(RESEARCH_TOOL_NAMES.map(name => researchTool(name, fast, true)), [reply({ content: 'ok' })], 1);
      const tools = requests[0]!.tools!;
      expect(tools.map(tool => tool.function.name)).toEqual(RESEARCH_TOOL_NAMES);
      expect(unboundedStrings(tools)).toEqual([]);
      const keywords = (tools.find(tool => tool.function.name === 'social_search')!.function.parameters as
        { properties: { keywords: { items: { maxLength: number } } } }).properties.keywords;
      expect(keywords.items.maxLength).toBe(40);
    });
  }
  it('the admission size (researchToolBytes) is measured from schemas with every limit too', () => {
    for (const name of RESEARCH_TOOL_NAMES) expect(unboundedStrings(z.toJSONSchema(researchToolParameters(name)))).toEqual([]);
    expect(researchToolBytes([...RESEARCH_TOOL_NAMES])).toBeGreaterThan(researchToolBytes([...RESEARCH_TOOL_NAMES], false, false, false));
  });
  // A turn frozen before the limits were declared replays with the same request bytes (its request hashes must match).
  it('a turn frozen without the marker is offered exactly the earlier tool definitions', async () => {
    const pinned: Record<string, string> = {
      'false,false': '35031793e37db00b2a836b13bddddbea1fb921e86d6ab1e6e50fb2bf0de9abfa',
      'false,true': 'df6c6c11a6e44d80232dda151895ad50115b983b48354150e5aeccadfd17c6d3',
      'true,false': '0a124c069bb53363c960d06e3d8ddece13d9950bb2145441dd4ef89c8048d3c0',
      'true,true': '6cc205ba40b061faa7ddc46128cd59b57498a3977297465f834a0e13e30e1c00',
    };
    for (const [key, hash] of Object.entries(pinned)) {
      const [fast, freeChat] = key.split(',').map(value => value === 'true') as [boolean, boolean];
      const { requests } = await run(RESEARCH_TOOL_NAMES.map(name => researchTool(name, fast, false, freeChat)), [reply({ content: 'ok' })], 1);
      expect(createHash('sha256').update(JSON.stringify(requests[0]!.tools)).digest('hex')).toBe(hash);
    }
  });
  it('admission freezes the marker; a context without it stays valid', () => {
    const base = { version: RESEARCH_TURN_VERSION, configRevision: 1, phase: RESEARCH_PHASE, subcalls: 4, reserve: RESEARCH_RESULT_RESERVE_BYTES,
      vendors: ['parallel'], verifiedPlatforms: [], benchmarkPlatforms: [], discoverSubcalls: 4,
      routes: [{ platform: 'web', kind: 'web_search', vendor: 'parallel', route: 'parallel:search:fast', backup: null, maxUnitsPerCall: '1' }],
      recentGrowth: { maxFirstPostAgeDays: 90, minViewsToFollowers: '1' } };
    expect(frozenResearchTurn.parse(base).toolLimits).toBeUndefined();
    expect(frozenResearchTurn.parse({ ...base, toolLimits: RESEARCH_TOOL_LIMITS }).toolLimits).toBe(RESEARCH_TOOL_LIMITS);
  });
  it('an optional argument the model sends as null runs as not given', async () => {
    const createCard = vi.fn();
    const ctx = { config: { enabled: false, routes: [], limits: { maxSubcallsPerRound: 1, discoverSubcalls: 1 } },
      store: { createCard } } as unknown as ResearchToolContext;
    const [tool] = researchRuntimeTools(ctx, ['social_search']);
    const { requests, output } = await run([tool!], [call('social_search', { platform: 'tiktok', keywords: ['hardanger'], limit: null }),
      reply({ content: 'done' })]);
    expect(output).toBe('done');
    // Valid arguments reach the tool (here it reports research is off), not the invalid-arguments answer.
    expect(lastToolResult(requests[1]!)).toContain('RESEARCH_DISABLED');
  });
});

describe('invalid tool arguments go back to the model (runner default)', () => {
  const tools = {
    read_history: mentorHistoryTool,
    load_skill: (execute: RuntimeTool['execute']) => loadSkillTool(execute),
    read_skill_file: skillFileTool,
    read_source: (execute: RuntimeTool['execute']): RuntimeTool => ({ name: 'read_source', description: 'd', execute }),
  };
  const invalid: Record<keyof typeof tools, unknown> = {
    read_history: { query: 'x'.repeat(65) }, load_skill: { name: '' }, read_skill_file: { path: 'p'.repeat(241) },
    read_source: { query: 'q', extra: true },
  };
  for (const name of Object.keys(tools) as Array<keyof typeof tools>) {
    it(`${name}: the model is told, nothing runs and the paid turn completes`, async () => {
      const execute = vi.fn(async () => 'ran');
      const { requests, output } = await run([tools[name](execute)], [call(name, invalid[name]), reply({ content: 'answered' })]);
      expect(output).toBe('answered');
      expect(execute).not.toHaveBeenCalled();
      expect(JSON.parse(JSON.parse(lastToolResult(requests[1]!)).content)).toEqual(JSON.parse(INVALID_TOOL_ARGUMENTS));
    });
  }
  it('arguments that are not JSON at all are answered by the SDK itself, and the turn goes on', async () => {
    const execute = vi.fn(async () => 'ran');
    const { requests, output } = await run([skillFileTool(execute)], [call('read_skill_file', '{"path":'), reply({ content: 'ok' })]);
    expect(output).toBe('ok');
    expect(execute).not.toHaveBeenCalled();
    expect(lastToolResult(requests[1]!)).toContain('valid JSON');
  });
  it('a failed execution still fails the run', async () => {
    const execute = vi.fn(async () => { throw new Error('RUNTIME_SKILL_FILE_DENIED'); });
    const { output } = await run([skillFileTool(execute)], [call('read_skill_file', { path: 'a.md' })]);
    expect(output).toEqual(new Error('RUNTIME_EXECUTION_PENDING'));
    expect(execute).toHaveBeenCalledOnce();
  });
  it('a tool with its own catch-all result keeps it', async () => {
    const { requests } = await run([{ name: 'ask_question', description: 'd', parameters: z.object({ q: z.string().max(5) }).strict(),
      invalidResult: 'CARD_INVALID', execute: async () => { throw new Error('boom'); } }],
    [call('ask_question', { q: 'x'.repeat(9) }), call('ask_question', { q: 'ok' }, 'c2'), reply({ content: 'end' })]);
    expect(lastToolResult(requests[1]!)).toContain('CARD_INVALID');
    expect(lastToolResult(requests[2]!)).toContain('CARD_INVALID');
  });
  it('a model that keeps sending invalid arguments stops at the turn limit, not in a loop', async () => {
    const execute = vi.fn(async () => 'ran');
    const responses = Array.from({ length: 10 }, (_, i) => call('read_skill_file', { path: '' }, `c${i}`));
    const { requests, output } = await run([skillFileTool(execute)], responses, 3);
    expect(output).toEqual(new Error('RUNTIME_EXECUTION_PENDING'));
    expect(requests).toHaveLength(3);
    expect(execute).not.toHaveBeenCalled();
  });
  it('the same invalid arguments give the same next request on replay', async () => {
    const first = await run([skillFileTool(vi.fn())], [call('read_skill_file', { path: '' }), reply({ content: 'ok' })]);
    const replay = await run([skillFileTool(vi.fn())], [call('read_skill_file', { path: '' }), reply({ content: 'ok' })]);
    expect(JSON.stringify(replay.requests)).toBe(JSON.stringify(first.requests));
  });
});

describe('a research supplier request waits no longer than the round has left', () => {
  const budgetAt = (elapsedMs: number) => { let clock = 0; const budget = createRuntimeBudget(() => clock); clock = elapsedMs; return budget; };
  it('is the vendor default with time to spare, then shrinks to what is left after the reply\'s minimum', () => {
    expect(supplierTimeout(undefined)).toBe(60_000);
    expect(supplierTimeout(budgetAt(0))).toBe(60_000);
    // 265s of work: at 180s, 85s are left; the reply keeps its 60s, the supplier gets 25s.
    expect(supplierTimeout(budgetAt(180_000))).toBe(25_000);
    expect(supplierTimeout(budgetAt(265_000 - MIN_MODEL_DISPATCH_MS - MIN_SUPPLIER_MS + 1))).toBeLessThan(MIN_SUPPLIER_MS);
    expect(supplierTimeout(budgetAt(300_000))).toBe(0);
  });
});
