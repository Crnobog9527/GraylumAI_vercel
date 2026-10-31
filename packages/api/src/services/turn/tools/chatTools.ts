/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { swallow } from '../../../lib/swallow';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CanonicalAccount } from '../../research/tools/accountLinks';
import { GENERAL_RESEARCH_TOOLS } from '../../research/tools/names';
import { platformSecretReader, type SecretReader } from '../../research/runtime/secrets';
import type { VendorCalls } from '../../research/runtime/subcall';
import { researchToolBytes } from '../../runtime/researchAdmission';
import { FREE_CHAT_RESEARCH } from '../../runtime/researchTurn';
import { chatResearchEnabled } from '../../runtime/freeChatResearch';
import { admitLibraryRetrieval } from '../../runtime/libraryAdmission';
import { libraryAddendum } from '../../runtime/primaryInstructions';
import { loadSkillToolBytes } from '../../runtime/loadSkillTool';
import { skillCatalogInstructions, type SkillCatalogEntry } from '../../runtime/skillCatalog';
import type { ConfigurationRows } from '../../runtime/settingsRows';
import type { RuntimeTool } from '../../runtime/runner';
import { TurnStop } from '../call';
import type { CounterStore } from '../limiter';
import type { TurnClients } from '../db';
import { libraryTurnReader } from './source';
import { planTurnTools, RESEARCH_INPUT_BYTES, type ResearchSetup } from './plan';
import { researchInstructions, READ_SOURCE_DESCRIPTION, turnTools, type SourceReader } from './index';
import type { PreparedSkills } from './skills';
import type { ToolCallDeps, ToolPlan, TurnToolName } from './types';

/*
 * CORE-PATH-V2 V2-6: the tools of a free chat (kind=chat, 2.7). The session's whitelist is the general research lookups
 * (when the chat research switch is on and the route profile's tool ceiling holds them), load_skill (when the account has a
 * Skill catalog) and read_source (when the deployment enables the library read); its definitions and the research/catalog instructions are
 * the same on every turn of the session. What this turn can use, and its limits and bounds, come from planTurnTools before turn_open.
 */
export type ChatToolDeps = {
  /** The account's Skill catalog and each entry's prepared load result (read before turn_open; cached by package hash). */
  skills?: (actorId: string) => Promise<{ catalog: SkillCatalogEntry[]; prepared: PreparedSkills }>;
  /** The confirmed voice of the catalog's writing Skills: a per-user system paragraph, and the version turn_open freezes. */
  voice?: (actorId: string, catalog: SkillCatalogEntry[]) => Promise<{ text: string; versionId?: string } | undefined>;
  /** Offer read_source over the user's own library (library_turn_read through the read client) while the two library switches are
   *  on; tests may give their own reader. */
  library?: boolean | ((actorId: string, sessionId: string) => SourceReader);
  /** Accounts from the user's benchmark table that social_account may look up. */
  benchmarkAccounts?: (actorId: string, sessionId: string) => Promise<CanonicalAccount[]>;
  /** Tests and the load-test stub only; production reads the admin Vault and calls the real suppliers. */
  readKey?: SecretReader; vendors?: VendorCalls;
};

export type ChatToolsSetup = {
  plan: ToolPlan; research: ResearchSetup | null; inputLimit: number;
  /** Request bytes of the offered tool definitions (the history may not take them). */
  definitionBytes: number;
  /** Appended to the shared (cached) instructions: fixed per session. `gated`: an account without a confirmed positioning. */
  sharedInstructions: (gated: boolean) => string;
  /** The per-user segment's part (2.9 rule 3): the catalog voice. */
  userInstructions: string;
  /** Frozen into the turn: revoking this version stops the turn (voice tombstone). */
  voiceVersionId?: string;
  /** What the user chose for this message, as a line for the model, or the code that refuses it before anything opens. */
  selection(chosen: ChatSelection): { note: string } | { refused: string };
  /** Context fields of the request format (providerRequest.ts): the tools it may carry. */
  context: { tools: string[]; research?: { freeChat: string }; skillCatalog?: SkillCatalogEntry[]; libraryRetrieval?: boolean };
  build(calls: ToolCallDeps, extra: { slots: CounterStore; currentMessage: string; deadline: number; callGate: (subcalls: number) => Promise<void>;
    onStop: (stop: TurnStop) => void; gated: boolean; onCall: NonNullable<Parameters<typeof turnTools>[0]['onCall']> }): Promise<ReturnType<typeof turnTools>>;
};

export type ChatSelection = { moduleId?: string; references?: ReadonlyArray<{ documentId: string; version: number }> };

/** POSITIONING-GATE: an account without a confirmed positioning neither sees nor loads a social-media Skill. */
const allowedSkills = (catalog: readonly SkillCatalogEntry[], gated: boolean) => gated ? catalog.filter(entry => !entry.social) : catalog;

/** Leave this much of the turn's 300 s for the reply after the last supplier answer. */
const REPLY_RESERVE_MS = 60_000;

export async function prepareChatTools(input: { admin: SupabaseClient; read: TurnClients['read'];
  configuration: Promise<ConfigurationRows>; tools: ChatToolDeps;
  actorId: string; sessionId: string; requiredBytes: number; interactiveBytes: number; quotedBytes: number; chosen?: ChatSelection;
  modelMultiplier: string; defaultMultiplier: string;
  /** The route profile's tool ceiling: a group that does not fit is not offered at all (payg-three-tools rule). */
  maxTools: number }): Promise<ChatToolsSetup> {
  const skills = input.tools.skills ? await swallow('turn_tools_skills_unavailable', input.tools.skills(input.actorId), null) : null;
  // Whole groups in this order, each only if it still fits the profile's ceiling; the result depends on configuration only,
  // so it is the same on every turn of the session (2.9 rule 2).
  const offered: TurnToolName[] = [];
  // The research lookups are offered only while the admin's chat research switch is on (a configuration change, not a turn's).
  const researchOn = await swallow('turn_tools_research_switch_unavailable',
    chatResearchEnabled(input.admin, input.configuration), false);
  const library = input.tools.library === true ? await swallow('turn_tools_library_switch_unavailable',
    admitLibraryRetrieval(input.admin, true, 'ordinary', [], input.configuration), false) : Boolean(input.tools.library);
  for (const group of [library ? ['read_source' as const] : [], skills?.catalog.length ? ['load_skill' as const] : [],
    researchOn ? [...GENERAL_RESEARCH_TOOLS] as TurnToolName[] : []]) if (offered.length + group.length <= input.maxTools) offered.push(...group);
  const research = offered.filter(name => (GENERAL_RESEARCH_TOOLS as readonly string[]).includes(name)) as typeof GENERAL_RESEARCH_TOOLS[number][];
  const skillOffered = offered.includes('load_skill'), sourceOffered = offered.includes('read_source');
  const definitionBytes = (research.length ? researchToolBytes(research, false, true) : 0) + (skillOffered ? loadSkillToolBytes() : 0)
    + (sourceOffered ? Buffer.byteLength(READ_SOURCE_DESCRIPTION) + 256 : 0);
  const catalog = skillOffered ? skills!.catalog : [];
  const catalogText = skillCatalogInstructions(catalog);
  const libraryText = libraryAddendum(false, sourceOffered);
  const voice = input.tools.voice && catalog.length
    ? await swallow('turn_tools_voice_unavailable', input.tools.voice(input.actorId, catalog), undefined) : undefined;
  const { plan, research: setup } = await planTurnTools({ admin: input.admin, configuration: input.configuration, offered,
    freeReady: { load_skill: Boolean(skills?.prepared.size) },
    requiredBytes: input.requiredBytes + definitionBytes + Buffer.byteLength(catalogText + libraryText + (voice?.text ?? '')),
    // A turn whose research is usable may use the research ceiling; otherwise the interactive one (Owner 10-17 / 10-27).
    inputBytes: Math.min(input.quotedBytes, input.interactiveBytes),
    researchInputBytes: Math.min(input.quotedBytes, RESEARCH_INPUT_BYTES), modelMultiplier: input.modelMultiplier,
    defaultMultiplier: input.defaultMultiplier, readKey: input.tools.readKey ?? platformSecretReader(input.admin) });
  const researchUsable = plan.limits.paidTools > 0;
  // Without usable research the turn keeps the interactive ceiling (the free tools were sized against it).
  const inputLimit = researchUsable ? Math.min(input.quotedBytes, RESEARCH_INPUT_BYTES) : Math.min(input.quotedBytes, input.interactiveBytes);
  const benchmark = setup && input.tools.benchmarkAccounts ? await swallow('turn_tools_benchmark_accounts_unavailable',
    input.tools.benchmarkAccounts(input.actorId, input.sessionId), []) : [];
  return {
    plan, research: setup, inputLimit, definitionBytes,
    sharedInstructions: gated => researchInstructions(plan) + libraryText + skillCatalogInstructions(allowedSkills(catalog, gated)),
    userInstructions: voice?.text ?? '', ...(voice?.versionId ? { voiceVersionId: voice.versionId } : {}),
    selection(chosen) {
      let note = '';
      if (chosen.moduleId) {
        // A chosen Skill never silently falls back to a turn without it (as the old page's "不会自动换用其他功能").
        const entry = catalog.find(item => item.moduleId === chosen.moduleId);
        if (!entry || !plan.available.includes('load_skill') || !skills?.prepared.has(entry.name)) return { refused: 'TURN_SKILL_UNAVAILABLE' };
        note += `\nThe user chose the Skill "${entry.name}" for this message: call load_skill with that name first.`;
      }
      if (chosen.references?.length) {
        if (!plan.available.includes('read_source')) return { refused: 'TURN_REFERENCES_UNAVAILABLE' };
        note += `\nThe user attached ${chosen.references.map((_item, index) => `doc-${index + 1}`).join(', ')}: read them with read_source before answering.`;
      }
      return { note };
    },
    context: { tools: [...plan.offered], ...(research.length ? { research: { freeChat: FREE_CHAT_RESEARCH } } : {}),
      ...(skillOffered ? { skillCatalog: skills!.catalog } : {}),
      ...(sourceOffered ? { libraryRetrieval: true } : {}) },
    async build(calls, extra) {
      const built = turnTools({ plan, calls, research: setup, callGate: extra.callGate,
        suppliers: { slots: extra.slots, timeLeft: () => extra.deadline - Date.now() - REPLY_RESERVE_MS,
          ...(input.tools.vendors ? { vendors: input.tools.vendors } : {}) },
        accounts: { benchmark, currentMessage: extra.currentMessage }, onCall: extra.onCall,
        ...(skillOffered ? { skills: new Map(allowedSkills(catalog, extra.gated).flatMap(entry => {
          const prepared = skills!.prepared.get(entry.name);
          return prepared === undefined ? [] : [[entry.name, prepared] as const];
        })) } : {}),
        ...(sourceOffered ? { readSource: typeof input.tools.library === 'function' ? input.tools.library(input.actorId, input.sessionId)
          : libraryTurnReader(input.read, input.actorId, input.sessionId, input.chosen?.references) } : {}) });
      // A stop raised inside a tool (paused for credits, a tombstone) reaches the turn, not the SDK's error wrapper.
      const tools: RuntimeTool[] = built.tools.map(tool => ({ ...tool, async execute(args, callId) {
        try { return await tool.execute(args, callId); }
        catch (error) { if (error instanceof TurnStop) extra.onStop(error); throw error; }
      } }));
      return { ...built, tools };
    },
  };
}
