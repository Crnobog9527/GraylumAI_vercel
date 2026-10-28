/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CanonicalAccount } from '../../research/tools/accountLinks';
import { GENERAL_RESEARCH_TOOLS } from '../../research/tools/names';
import { platformSecretReader, type SecretReader } from '../../research/runtime/secrets';
import type { VendorCalls } from '../../research/runtime/subcall';
import { researchToolBytes } from '../../runtime/researchAdmission';
import { FREE_CHAT_RESEARCH } from '../../runtime/researchTurn';
import { loadSkillToolBytes } from '../../runtime/loadSkillTool';
import { skillCatalogInstructions, type SkillCatalogEntry } from '../../runtime/skillCatalog';
import type { ConfigurationRows } from '../../runtime/settingsRows';
import type { RuntimeTool } from '../../runtime/runner';
import { TurnStop } from '../call';
import type { CounterStore } from '../limiter';
import { planTurnTools, RESEARCH_INPUT_BYTES, type ResearchSetup } from './plan';
import { researchInstructions, READ_SOURCE_DESCRIPTION, turnTools, type SourceReader } from './index';
import type { PreparedSkills } from './skills';
import type { ToolCallDeps, ToolPlan, TurnToolName } from './types';

/*
 * CORE-PATH-V2 V2-6: the tools of a free chat (kind=chat, 2.7). The session's whitelist is the general research lookups
 * (when the chat research switch is on), load_skill (when the account has a Skill catalog) and read_source (when the kind
 * gives a reader); its definitions and the research/catalog instructions are the same on every turn of the session. What
 * this turn can use, and its limits and bounds, come from planTurnTools before turn_open.
 */
export type ChatToolDeps = {
  /** The account's Skill catalog and each entry's prepared load result (read before turn_open; cached by package hash). */
  skills?: (actorId: string) => Promise<{ catalog: SkillCatalogEntry[]; prepared: PreparedSkills }>;
  /** The owned-source read (library, business context), when the deployment provides one. */
  readSource?: (actorId: string, sessionId: string) => SourceReader;
  /** Accounts from the user's benchmark table that social_account may look up. */
  benchmarkAccounts?: (actorId: string) => Promise<CanonicalAccount[]>;
  /** Tests and the load-test stub only; production reads the admin Vault and calls the real suppliers. */
  readKey?: SecretReader; vendors?: VendorCalls;
};

export type ChatToolsSetup = {
  plan: ToolPlan; research: ResearchSetup | null; inputLimit: number;
  /** Appended to the shared (cached) instructions: fixed per session. */
  sharedInstructions: string;
  /** Context fields of the request format (providerRequest.ts): the tools it may carry. */
  context: { tools: string[]; research?: { freeChat: string }; skillCatalog?: SkillCatalogEntry[]; libraryRetrieval?: boolean };
  build(calls: ToolCallDeps, extra: { slots: CounterStore; multiplier: string; currentMessage: string; deadline: number;
    onStop: (stop: TurnStop) => void }): Promise<ReturnType<typeof turnTools>>;
};

/** Leave this much of the turn's 300 s for the reply after the last supplier answer. */
const REPLY_RESERVE_MS = 60_000;

export async function prepareChatTools(input: { admin: SupabaseClient; configuration: Promise<ConfigurationRows>; tools: ChatToolDeps;
  actorId: string; sessionId: string; requiredBytes: number; interactiveBytes: number; quotedBytes: number;
  modelMultiplier: string; defaultMultiplier: string }): Promise<ChatToolsSetup> {
  const skills = input.tools.skills ? await input.tools.skills(input.actorId).catch(() => null) : null;
  const offered: TurnToolName[] = [
    ...(input.tools.readSource ? ['read_source' as const] : []),
    ...(skills?.catalog.length ? ['load_skill' as const] : []),
    ...GENERAL_RESEARCH_TOOLS as readonly TurnToolName[],
  ];
  const research = offered.filter(name => (GENERAL_RESEARCH_TOOLS as readonly string[]).includes(name)) as typeof GENERAL_RESEARCH_TOOLS[number][];
  const definitionBytes = researchToolBytes(research, false, true) + (skills?.catalog.length ? loadSkillToolBytes() : 0)
    + (input.tools.readSource ? Buffer.byteLength(READ_SOURCE_DESCRIPTION) + 256 : 0);
  const catalogText = skills?.catalog.length ? skillCatalogInstructions(skills.catalog) : '';
  const { plan, research: setup } = await planTurnTools({ admin: input.admin, configuration: input.configuration, offered,
    freeReady: { load_skill: Boolean(skills?.prepared.size) },
    requiredBytes: input.requiredBytes + definitionBytes + Buffer.byteLength(catalogText),
    // A turn whose research is usable may use the research ceiling; otherwise the interactive one (Owner 10-17 / 10-27).
    inputBytes: Math.min(input.quotedBytes, input.interactiveBytes),
    researchInputBytes: Math.min(input.quotedBytes, RESEARCH_INPUT_BYTES), modelMultiplier: input.modelMultiplier,
    defaultMultiplier: input.defaultMultiplier, readKey: input.tools.readKey ?? platformSecretReader(input.admin) });
  const researchUsable = plan.limits.paidTools > 0;
  // Without usable research the turn keeps the interactive ceiling (the free tools were sized against it).
  const inputLimit = researchUsable ? Math.min(input.quotedBytes, RESEARCH_INPUT_BYTES) : Math.min(input.quotedBytes, input.interactiveBytes);
  const benchmark = setup && input.tools.benchmarkAccounts ? await input.tools.benchmarkAccounts(input.actorId).catch(() => []) : [];
  return {
    plan, research: setup, inputLimit,
    sharedInstructions: researchInstructions(plan) + catalogText,
    context: { tools: [...plan.offered], ...(research.length ? { research: { freeChat: FREE_CHAT_RESEARCH } } : {}),
      ...(skills?.catalog.length ? { skillCatalog: skills.catalog } : {}),
      ...(input.tools.readSource ? { libraryRetrieval: true } : {}) },
    async build(calls, extra) {
      const built = turnTools({ plan, calls, multiplier: extra.multiplier, research: setup,
        suppliers: { slots: extra.slots, timeLeft: () => extra.deadline - Date.now() - REPLY_RESERVE_MS,
          ...(input.tools.vendors ? { vendors: input.tools.vendors } : {}) },
        accounts: { benchmark, currentMessage: extra.currentMessage },
        ...(skills ? { skills: skills.prepared } : {}),
        ...(input.tools.readSource ? { readSource: input.tools.readSource(input.actorId, input.sessionId) } : {}) });
      // A stop raised inside a tool (paused for credits, a tombstone) reaches the turn, not the SDK's error wrapper.
      const tools: RuntimeTool[] = built.tools.map(tool => ({ ...tool, async execute(args, callId) {
        try { return await tool.execute(args, callId); }
        catch (error) { if (error instanceof TurnStop) extra.onStop(error); throw error; }
      } }));
      return { ...built, tools };
    },
  };
}
