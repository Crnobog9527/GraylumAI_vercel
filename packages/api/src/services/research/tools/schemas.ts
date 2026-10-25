/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Model-callable research tools (plan §2.1): names, strict arguments, descriptions and the worst-case
// supplier subcalls each call may spend. Not wired into the runtime yet (RT-3 wiring follows #920/#950).
import { z } from 'zod';
import { publicHttpUrl } from '../vendors/http';
import { SOCIAL_PLATFORMS, type SocialPlatform } from '../vendors/types';
import { BENCHMARK_EXTRA_POST_PAGES, benchmarkSubcallsPerAccount, type ResearchToolsConfig } from '../vendors/config';
import type { ResearchToolName } from './names';
export { GENERAL_RESEARCH_TOOLS, POSITIONING_RESEARCH_TOOLS, RESEARCH_TOOL_NAMES, type ResearchToolName } from './names';

const chars = (value: string) => [...value].length;
const noControl = (value: string) => !/\p{Cc}/u.test(value);
/**
 * ARCH-FIX C1: which form of the tool arguments to build.
 * - `run`: the arguments a tool runs with. Limits are `.max()` (a `.refine()` limit never reaches the JSON Schema).
 * - `offer`: the parameters sent to the model. As `run`, but an optional field is nullable (the model's null means not
 *   given): for a strict tool the SDK keeps maxLength only then; its fallback for `.optional()` drops every limit.
 * - `undeclared`: the earlier refine-only form, offered unchanged to a turn frozen before the limits were declared, so
 *   its replayed requests keep their bytes.
 */
type ArgsForm = 'run' | 'offer' | 'undeclared';
const text = (max: number, label: string, undeclared: boolean) => undeclared
  ? z.string().trim().min(1).refine(value => chars(value) <= max && noControl(value), `${label}: at most ${max} characters`)
  : z.string().trim().min(1).max(max, `${label}: at most ${max} characters`).refine(noControl, `${label}: no control characters`);
const platform = z.enum(SOCIAL_PLATFORMS);
const id = z.string().uuid();
const uniqueBy = <T>(items: T[], key: (item: T) => string) => new Set(items.map(key)).size === items.length;

function toolArgs(form: ArgsForm) {
  const undeclared = form === 'undeclared';
  const keyword = text(40, 'Keyword', undeclared);
  const account = text(200, 'Account', undeclared);
  const optional = <T extends z.ZodTypeAny>(schema: T) => form === 'offer' ? schema.nullable() : schema.optional();
  return {
    propose_keywords: z.object({
      // BENCHMARK-COVERAGE (Owner 2026-10-23): 6–10 keywords, at least 3; research_card_create checks the same range.
      keywords: z.array(keyword).min(3).max(10).refine(items => uniqueBy(items, item => item.toLowerCase()), 'Duplicate keyword'),
    }).strict(),
    benchmark_discover: z.union([
      z.object({
        keywordConfirmationId: id,
        platforms: z.array(platform).min(1).max(2).refine(items => uniqueBy(items, item => item), 'Duplicate platform'),
      }).strict(),
      z.object({ discoveryId: id }).strict(),
    ]),
    social_search: z.object({
      platform,
      keywords: z.array(keyword).min(1).max(5).refine(items => uniqueBy(items, item => item.toLowerCase()), 'Duplicate keyword'),
      limit: optional(z.number().int().min(1).max(30)),
    }).strict(),
    propose_more_candidates: z.object({ discoveryId: id }).strict(),
    benchmark_fetch: z.object({
      accounts: z.array(z.object({ platform, account }).strict()).min(1).max(5),
      source: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('candidate'), confirmationId: id }).strict(),
        // messageId omitted: the user's message this reply answers (the model never sees message ids).
        z.object({ kind: z.literal('user_message'), messageId: optional(id) }).strict(),
        z.object({ kind: z.literal('refresh'), refreshId: id }).strict(),
      ]),
    }).strict(),
    social_account: z.object({ platform, account, posts: optional(z.number().int().min(1).max(30)) }).strict(),
    web_search: z.object({
      query: text(200, 'Query', undeclared),
      mode: z.enum(['fast', 'pro']).default('fast'),
    }).strict(),
    web_fetch: z.object({
      url: z.string().max(2048).refine(value => publicHttpUrl(value) !== undefined, 'Only public http(s) links without credentials'),
    }).strict(),
  } satisfies Record<ResearchToolName, z.ZodTypeAny>;
}

export const researchToolArgs = toolArgs('run');
/** The parameters offered to a turn frozen with declared limits (FrozenResearchTurn.toolLimits). */
export const declaredResearchParameters = toolArgs('offer');
/** The parameters offered to a turn frozen without them. */
export const undeclaredResearchToolArgs = toolArgs('undeclared');
/** Offered arguments as the tool runs them: a null the model sent for an optional field means it was not given. */
export function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => [key, withoutNulls(item)]));
}

export type ResearchToolArgs<T extends ResearchToolName> = z.infer<typeof researchToolArgs[T]>;

const PRIVACY = 'Send only keywords, public links or public account names; never personal details or conversation text.';
export const RESEARCH_TOOL_DESCRIPTIONS: Record<ResearchToolName, string> = {
  propose_keywords: 'Show the user a keyword selection card (aim for 6-10, at least 3: the niche term, synonyms, related terms, '
    + 'the target market\'s language) before any benchmark search. Free.',
  benchmark_discover: 'Find benchmark candidates for a keyword card the user confirmed (keywordConfirmationId from ' +
    `hostTurnContext.research.cards). To continue, call again with the same confirmation and platforms. ${PRIVACY}`,
  social_search: `Search recent public posts on one platform by keyword. ${PRIVACY}`,
  propose_more_candidates: 'Show another candidate card from an earlier discovery (discoveryId from hostTurnContext.research.cards), ' +
    'excluding accounts already chosen. Free.',
  benchmark_fetch: 'Fetch profile and recent posts for benchmark accounts. source: {kind:"candidate",confirmationId} from ' +
    'hostTurnContext.research.cards, or {kind:"user_message"} for profile links in the message you are answering. ' + PRIVACY,
  social_account: `Look up one public account and its recent posts (not saved as a benchmark). ${PRIVACY}`,
  web_search: `Search the web. ${PRIVACY}`,
  web_fetch: 'Read the main text of one public web page. Pass only a public http(s) link.',
};

/**
 * Subcall allowance (plan §5): general lookups are all-or-nothing and need their worst case up front;
 * benchmark tools run up to their own cap and stop with `partial` when the round runs out.
 */
export type SubcallNeed = { mode: 'all_or_nothing'; subcalls: number } | { mode: 'up_to'; subcalls: number };

/** Profile + posts, plus Bilibili's separately billed relation lookup. */
const ACCOUNT_SUBCALLS = 3;

/** What one benchmark account may spend: at least ACCOUNT_SUBCALLS, or its route set plus extra post pages if that is more. */
export function benchmarkAccountSubcalls(platform: SocialPlatform): number {
  return Math.max(ACCOUNT_SUBCALLS, benchmarkSubcallsPerAccount(platform) + (BENCHMARK_EXTRA_POST_PAGES[platform] ?? 0));
}

export function subcallNeed<T extends ResearchToolName>(
  tool: T, args: ResearchToolArgs<T>, config: ResearchToolsConfig,
): SubcallNeed {
  switch (tool) {
    case 'propose_keywords':
    case 'propose_more_candidates':
      return { mode: 'all_or_nothing', subcalls: 0 };
    case 'social_search':
      return { mode: 'all_or_nothing', subcalls: (args as ResearchToolArgs<'social_search'>).keywords.length };
    case 'social_account':
      return { mode: 'all_or_nothing', subcalls: ACCOUNT_SUBCALLS };
    case 'web_search':
    case 'web_fetch':
      return { mode: 'all_or_nothing', subcalls: 1 };
    case 'benchmark_fetch':
      // Each account needs its own route set plus the extra post pages its platform may page through.
      return { mode: 'up_to', subcalls: (args as ResearchToolArgs<'benchmark_fetch'>).accounts
        .reduce((sum, account) => sum + benchmarkAccountSubcalls(account.platform), 0) };
    case 'benchmark_discover':
      return { mode: 'up_to', subcalls: config.limits.discoverSubcalls };
    default:
      throw new Error(`Unknown research tool ${String(tool)}`);
  }
}

/**
 * How many subcalls this tool call may spend given what is left in the round; 0 with `exhausted`
 * means return `budget_exhausted` without contacting any supplier.
 */
export function admitSubcalls(need: SubcallNeed, remaining: number): { allowed: number; exhausted: boolean } {
  const left = Math.max(0, Math.trunc(remaining));
  if (need.subcalls === 0) return { allowed: 0, exhausted: false };
  if (need.mode === 'all_or_nothing') return need.subcalls <= left ? { allowed: need.subcalls, exhausted: false } : { allowed: 0, exhausted: true };
  return left === 0 ? { allowed: 0, exhausted: true } : { allowed: Math.min(need.subcalls, left), exhausted: false };
}
