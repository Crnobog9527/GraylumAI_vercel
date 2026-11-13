/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { TurnReplay } from '../resume';
import { swallow } from '../../../lib/swallow';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CanonicalAccount } from '../../research/tools/accountLinks';
import { GENERAL_RESEARCH_TOOLS } from '../../research/tools/names';
import { platformSecretReader, type SecretReader } from '../../research/runtime/secrets';
import type { VendorCalls } from '../../research/runtime/subcall';
import { researchToolBytes } from '../research/researchAdmission';
import { FREE_CHAT_RESEARCH } from '../research/researchTurn';
import { chatResearchEnabled } from '../research/freeChatResearch';
import { admitLibraryRetrieval } from '../admission/libraryAdmission';
import { libraryAddendum, WORKSPACE_CONTEXT_INSTRUCTIONS, WORKSPACE_STRATEGY_INSTRUCTIONS,
  WORKSPACE_STRATEGY_RESULT_BYTES } from '../agent/primaryInstructions';
import { OWN_POSTS_INSTRUCTIONS, OWN_POSTS_RESERVE } from '../agent/workspacePosts';
import { loadSkillToolBytes } from '../skills/loadSkillTool';
import { skillCatalogInstructions, type SkillCatalogEntry } from '../skills/skillCatalog';
import type { ConfigurationRows } from '../settings/settingsRows';
import { TurnStop } from '../call';
import type { CounterStore } from '../limiter';
import type { TurnClients } from '../db';
import { libraryTurnReader } from './source';
import { COACH_REVIEW_INSTRUCTIONS } from './coachReview';
import { withStepEvents } from './announce';
import type { StepEvent } from '../sse';
import { COACH_CAPTURE_INSTRUCTIONS } from '../../publishMonitor/coach/screenshots';
import { NO_ACCESS, sourceDescription, workspaceTurnReader, type WorkspaceAccess } from './workspace';
import { planTurnTools, READ_SOURCE_CALLS, RESEARCH_INPUT_BYTES, type ResearchSetup } from './plan';
import { researchInstructions, READ_SOURCE_DESCRIPTION, turnTools, type SourceReader } from './index';
import type { PreparedSkills } from './skills';
import { IMAGE_TOOL_NAMES, IMAGE_TOOLS_INSTRUCTIONS, imageToolBytes, type ConversationPhoto, type ImageToolCalls } from './imageTools';
import type { ToolCallDeps, ToolPlan, TurnToolName } from './types';

/*
 * CORE-PATH-V2 V2-6: the tools of a free chat (kind=chat, 2.7). The session's whitelist is the general research lookups
 * (when the chat research switch is on and the route profile's tool ceiling holds them), load_skill (when the account has a
 * Skill catalog) and read_source (when the deployment enables the library read); its definitions and the research/catalog instructions are
 * the same on every turn of the session. What this turn can use, and its limits and bounds, come from planTurnTools before turn_open.
 */
export type ChatToolDeps = {
  /** The account's Skill catalog and each entry's prepared load result (read before turn_open; cached by package hash). */
  skills?: (actorId: string, pin?: WorkSkill) => Promise<{ catalog: SkillCatalogEntry[]; prepared: PreparedSkills; contentSource?: 'script' | 'storyboard' }>;
  /** The confirmed voice of the catalog's writing Skills: a per-user system paragraph, and the version turn_open freezes. */
  voice?: (actorId: string, catalog: SkillCatalogEntry[]) => Promise<{ text: string; versionId?: string } | undefined>;
  /** Offer read_source over the user's own library (library_turn_read through the read client) while the two library switches are
   *  on; tests may give their own reader. */
  library?: boolean | ((actorId: string, sessionId: string) => SourceReader);
  /** The user's confirmed workspace and own posts: what the checks before turn_open allow this turn (read_source reads inside it). */
  workspace?: (actorId: string, configuration: Promise<ConfigurationRows>) => Promise<WorkspaceAccess>;
  /** Accounts from the user's benchmark table that social_account may look up. */
  benchmarkAccounts?: (actorId: string, sessionId: string) => Promise<CanonicalAccount[]>;
  /** Tests and the load-test stub only; production reads the admin Vault and calls the real suppliers. */
  readKey?: SecretReader; vendors?: VendorCalls;
  /** INTEGRATION-SHOTVIVA: present when this deployment has the Shotviva connector configured (then the image tools are offered on
   *  every turn); `ready` says whether this account may use them this turn, `calls` makes them. */
  images?: { ready: (actorId: string) => Promise<true | 'not_entitled' | 'not_linked' | 'disabled'>;
    /** `current`: this message's turn and its photos as they are kept (chat.ts), so a photo sent now can be used now. */
    calls: (actorId: string, sessionId: string, current: { turnId: number; kept: Promise<readonly ConversationPhoto[]> | null }) => ImageToolCalls };
};

export type ChatToolsSetup = {
  plan: ToolPlan; research: ResearchSetup | null; inputLimit: number;
  /** Request bytes of the offered tool definitions (the history may not take them). */
  definitionBytes: number;
  /** The reply may end with a hidden coach_diag block (the numbers read from screenshots): the stream holds it back, the close saves it. */
  coachCapture: boolean;
  /** Appended to the shared (cached) instructions: fixed per session. `gated`: an account without a confirmed positioning. */
  sharedInstructions: (gated: boolean) => string;
  /** The per-user segment's part (2.9 rule 3): the catalog voice and the workspace reading rules. */
  userInstructions: string;
  /** Frozen into the turn: revoking this version stops the turn (voice tombstone). */
  voiceVersionId?: string;
  /** What the user chose for this message, as a line for the model, or the code that refuses it before anything opens. */
  selection(chosen: ChatSelection): { note: string; skill?: WorkSkill; social?: true; contentSource?: 'script' | 'storyboard' } | { refused: string };
  /** Context fields of the request format (providerRequest.ts): the tools it may carry. */
  context: { tools: string[]; research?: { freeChat: string }; skillCatalog?: SkillCatalogEntry[]; libraryRetrieval?: boolean; workspaceContext?: boolean;
    imageGeneration?: boolean };
  build(calls: ToolCallDeps, extra: { slots: CounterStore; currentMessage: string; deadline: number; callGate: (subcalls: number) => Promise<void>;
    onStop: (stop: TurnStop) => void; gated: boolean; onCall: NonNullable<Parameters<typeof turnTools>[0]['onCall']>;
    /** Told when each tool starts and ends (toolStage.ts), so the page can list the steps of the reply. */
    announce?: (event: StepEvent) => void;
    /** This message's chat photos as they are kept (chat.ts keepTurnPhotos), for the image tools. */
    photos?: Promise<readonly ConversationPhoto[]> | null;
    replay?: TurnReplay }): Promise<ReturnType<typeof turnTools>>;
};

/** A Skill by its exact revision: frozen in a work item's turn, so its result names the method that wrote it. */
export type WorkSkill = { moduleId: string; skillId: string; revisionId: string };
export type ChatSelection = { moduleId?: string; references?: ReadonlyArray<{ documentId: string; version: number }> };

/** POSITIONING-GATE: an account without a confirmed positioning neither sees nor loads a social-media Skill. */
const allowedSkills = (catalog: readonly SkillCatalogEntry[], gated: boolean) => gated ? catalog.filter(entry => !entry.social) : catalog;

/** read_source calls of a member with own post data (the old path's limit: the index, two sources, two post reads). */
const OWN_POSTS_READS = 5;
/** Leave this much of the turn's 300 s for the reply after the last supplier answer. */
const REPLY_RESERVE_MS = 60_000;

export async function prepareChatTools(input: { admin: SupabaseClient; read: TurnClients['read'];
  configuration: Promise<ConfigurationRows>; tools: ChatToolDeps;
  actorId: string; sessionId: string; pin?: WorkSkill; requiredBytes: number; interactiveBytes: number; quotedBytes: number; chosen?: ChatSelection;
  modelMultiplier: string; defaultMultiplier: string;
  /** The route profile's tool ceiling: a group that does not fit is not offered at all (payg-three-tools rule). */
  maxTools: number }): Promise<ChatToolsSetup> {
  // The Skill list, the research switch, the library switch and the workspace access need nothing from each other, so they are read
  // together (each already answers its own failure); the rest below follows in the order it always did.
  const [skills, researchOn, library, access, imagesReady] = await Promise.all([
    input.tools.skills ? swallow('turn_tools_skills_unavailable', input.tools.skills(input.actorId, input.pin), null) : null,
    swallow('turn_tools_research_switch_unavailable', chatResearchEnabled(input.admin, input.configuration), false),
    input.tools.library === true ? swallow('turn_tools_library_switch_unavailable',
      admitLibraryRetrieval(input.admin, true, 'ordinary', [], input.configuration), false) : Boolean(input.tools.library),
    input.tools.workspace ? swallow('turn_tools_workspace_unavailable', input.tools.workspace(input.actorId, input.configuration), NO_ACCESS)
      : NO_ACCESS,
    input.tools.images ? swallow('turn_tools_images_unavailable', input.tools.images.ready(input.actorId), 'disabled' as const) : null,
  ]);
  // Whole groups in this order, each only if it still fits the profile's ceiling; the result depends on configuration only,
  // so it is the same on every turn of the session (2.9 rule 2).
  const offered: TurnToolName[] = [];
  const workspaceOn = Boolean(input.tools.workspace);
  for (const group of [library || workspaceOn ? ['read_source' as const] : [], skills?.catalog.length ? ['load_skill' as const] : [],
    researchOn ? [...GENERAL_RESEARCH_TOOLS] as TurnToolName[] : [], input.tools.images ? [...IMAGE_TOOL_NAMES] as TurnToolName[] : []])
    if (offered.length + group.length <= input.maxTools) offered.push(...group);
  const imagesOffered = offered.includes('generate_image');
  const research = offered.filter(name => (GENERAL_RESEARCH_TOOLS as readonly string[]).includes(name)) as typeof GENERAL_RESEARCH_TOOLS[number][];
  const skillOffered = offered.includes('load_skill'), sourceOffered = offered.includes('read_source');
  const description = workspaceOn ? sourceDescription(Boolean(library)) : READ_SOURCE_DESCRIPTION;
  const definitionBytes = (research.length ? researchToolBytes(research, false, true) : 0) + (skillOffered ? loadSkillToolBytes() : 0)
    + (sourceOffered ? Buffer.byteLength(description) + 256 : 0) + (imagesOffered ? imageToolBytes() : 0);
  const catalog = skillOffered ? skills!.catalog : [];
  const catalogText = skillCatalogInstructions(catalog);
  const libraryText = libraryAddendum(false, sourceOffered && Boolean(library));
  const workspaceRead = sourceOffered && workspaceOn;
  const workspaceText = workspaceRead ? WORKSPACE_CONTEXT_INSTRUCTIONS : '';
  const coachText = COACH_REVIEW_INSTRUCTIONS + COACH_CAPTURE_INSTRUCTIONS;
  const postsText = workspaceRead && access.posts ? OWN_POSTS_INSTRUCTIONS + (access.posts.coach ? coachText : '') : '';
  const voice = input.tools.voice && catalog.length
    ? await swallow('turn_tools_voice_unavailable', input.tools.voice(input.actorId, catalog), undefined) : undefined;
  const { plan, research: setup } = await planTurnTools({ admin: input.admin, configuration: input.configuration, offered,
    freeReady: { load_skill: Boolean(skills?.prepared.size) },
    ...(workspaceRead ? { source: { strategyBytes: WORKSPACE_STRATEGY_RESULT_BYTES,
      ...(access.posts ? { posts: access.posts.windowDays > 0 ? { bytes: OWN_POSTS_RESERVE, calls: OWN_POSTS_READS }
        : { bytes: 1200, calls: READ_SOURCE_CALLS } } : {}) } } : {}),
    requiredBytes: input.requiredBytes + definitionBytes + Buffer.byteLength(catalogText + libraryText + (voice?.text ?? '')
      + workspaceText + WORKSPACE_STRATEGY_INSTRUCTIONS + postsText + (imagesOffered ? IMAGE_TOOLS_INSTRUCTIONS : '')),
    ...(imagesOffered && imagesReady !== null ? { imagesReady } : {}),
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
    coachCapture: Boolean(plan.sourceRoom?.posts && access.posts?.coach && access.posts.windowDays > 0),
    sharedInstructions: gated => researchInstructions(plan) + libraryText + skillCatalogInstructions(allowedSkills(catalog, gated))
      + (imagesOffered ? IMAGE_TOOLS_INSTRUCTIONS : ''),
    userInstructions: (voice?.text ?? '') + workspaceText + (plan.sourceRoom?.strategy ? WORKSPACE_STRATEGY_INSTRUCTIONS : '')
      + (plan.sourceRoom?.posts ? postsText : ''), ...(voice?.versionId ? { voiceVersionId: voice.versionId } : {}),
    selection(chosen) {
      let note = '', skill: WorkSkill | undefined, social = false;
      if (chosen.moduleId) {
        // A chosen Skill never silently falls back to a turn without it (as the old page's "不会自动换用其他功能").
        const entry = catalog.find(item => item.moduleId === chosen.moduleId);
        if (!entry || !plan.available.includes('load_skill') || !skills?.prepared.has(entry.name)) return { refused: 'TURN_SKILL_UNAVAILABLE' };
        note += `\nThe user chose the Skill "${entry.name}" for this message: call load_skill with that name first.`;
        skill = { moduleId: entry.moduleId, skillId: entry.skillId, revisionId: entry.revisionId };
        social = Boolean(entry.social);
      }
      if (chosen.references?.length) {
        if (!plan.available.includes('read_source')) return { refused: 'TURN_REFERENCES_UNAVAILABLE' };
        note += `\nThe user attached ${chosen.references.map((_item, index) => `doc-${index + 1}`).join(', ')}: read them with read_source before answering.`;
      }
      // Only the pinned Skill: the saved content a derived work method reads (workflow.yaml contentSource).
      const contentSource = skill && skill.moduleId === input.pin?.moduleId ? skills?.contentSource : undefined;
      return { note, ...(skill ? { skill } : {}), ...(social ? { social: true as const } : {}), ...(contentSource ? { contentSource } : {}) };
    },
    context: { tools: [...plan.offered], ...(research.length ? { research: { freeChat: FREE_CHAT_RESEARCH } } : {}),
      ...(skillOffered ? { skillCatalog: skills!.catalog } : {}),
      ...(sourceOffered && library ? { libraryRetrieval: true } : {}), ...(workspaceRead ? { workspaceContext: true } : {}),
      ...(imagesOffered ? { imageGeneration: true } : {}) },
    async build(calls, extra) {
      const chatReader = () => {
        const shelf = !library ? undefined : typeof input.tools.library === 'function' ? input.tools.library(input.actorId, input.sessionId)
          : libraryTurnReader(input.read, input.actorId, input.sessionId, input.chosen?.references);
        if (!workspaceRead) return shelf;
        return workspaceTurnReader(input.read, input.actorId, input.sessionId,
          { ...access, posts: plan.sourceRoom?.posts ? access.posts : null, strategy: Boolean(plan.sourceRoom?.strategy) }, shelf);
      };
      const built = turnTools({ plan, calls, research: setup, callGate: extra.callGate,
        suppliers: { slots: extra.slots, timeLeft: () => extra.deadline - Date.now() - REPLY_RESERVE_MS,
          ...(input.tools.vendors ? { vendors: input.tools.vendors } : {}) },
        accounts: { benchmark, currentMessage: extra.currentMessage }, onCall: extra.onCall, ...(extra.replay ? { replay: extra.replay } : {}),
        ...(skillOffered ? { skills: new Map(allowedSkills(catalog, extra.gated).flatMap(entry => {
          const prepared = skills!.prepared.get(entry.name);
          return prepared === undefined ? [] : [[entry.name, prepared] as const];
        })) } : {}),
        ...(sourceOffered ? { sourceDescription: description, readSource: chatReader() } : {}),
        ...(imagesOffered && input.tools.images ? { images: input.tools.images.calls(input.actorId, input.sessionId,
          { turnId: calls.turnId, kept: extra.photos ?? null }) } : {}) });
      // A stop raised inside a tool (paused for credits, a tombstone) reaches the turn, not the SDK's error wrapper.
      // The step line names a loaded Skill by its display title only (LOAD-SKILL): a Skill without one is shown unnamed.
      const skillTitles: ReadonlyMap<string, string> = new Map(allowedSkills(catalog, extra.gated)
        .flatMap(entry => entry.title ? [[entry.name, entry.title] as const] : []));
      const tools = withStepEvents(built.tools, extra.announce, skillTitles, extra.onStop);
      return { ...built, tools };
    },
  };
}
