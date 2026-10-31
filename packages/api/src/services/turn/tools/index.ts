/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { TurnReplay } from '../resume';
import type { CanonicalAccount } from '../../research/tools/accountLinks';
import { GENERAL_RESEARCH_TOOLS } from '../../research/tools/names';
import { FREE_CHAT_RESEARCH_INSTRUCTIONS } from '../../runtime/freeChatResearch';
import { loadSkillTool, SKILL_LOAD_REFUSED } from '../../runtime/loadSkillTool';
import type { RuntimeTool } from '../../runtime/runner';
import type { VendorCalls } from '../../research/runtime/subcall';
import type { CounterStore } from '../limiter';
import { LOAD_SKILL_CALLS, READ_SOURCE_CALLS, type ResearchSetup } from './plan';
import { researchTools, type ResearchToolsInput } from './research';
import { researchRounds } from './rounds';
import { READ_SOURCE_GUIDE } from './source';
import { skillFileTool } from '../../runtime/skillFile';
import { turnLoadSkillTool, turnSkillFileTool, type PreparedSkillFiles, type PreparedSkills } from './skills';
import type { GeneralResearchToolName, ToolCallDeps, ToolCallOutcome, ToolPlan, ToolSummary, TurnTools } from './types';

export { planTurnTools, paidToolBounds, RESEARCH_INPUT_BYTES, type ResearchSetup } from './plan';
export { prepareSkills, prepareSkillFiles } from './skills';
export { paidToolCall, settleToolCall, ToolLimitReached } from './meter';
export { libraryTurnReader, READ_SOURCE_GUIDE } from './source';
export { supplierSubcall } from './suppliers';
export { researchRounds, fallbackEligible } from './rounds';

/*
 * CORE-PATH-V2 V2-6: the RuntimeTools of one turn, built after turn_open from its ToolPlan. Every offered definition is
 * present with the same bytes on every turn (2.9 rule 2); a tool the plan trimmed answers unavailable without a write, and
 * the runner stops offering tools after maxToolCalls, so a call to a trimmed tool never exceeds the frozen model calls M. The kinds pass in what they prepared
 * before turn_open (Skill results, a Skill package, the account sources); nothing here reads the database.
 */
export const TOOL_UNAVAILABLE = JSON.stringify({ status: 'unavailable', reason: 'TOOL_UNAVAILABLE_THIS_TURN',
  note: 'This tool cannot be used in this reply. Answer without it and say so if it matters.' });
/** One description whatever this turn can use, so the tool list stays byte-stable across the session (2.9 rule 2). */
export const READ_SOURCE_DESCRIPTION = 'Read the user\'s own library documents. Read-only.' + READ_SOURCE_GUIDE;

/** The owned-source read of a turn (source.ts libraryTurnReader): one read-only query, no row (Owner 10-28). */
export type SourceReader = (query: string) => Promise<{ text: string }>;

export type TurnToolsInput = {
  replay?: TurnReplay;
  plan: ToolPlan; calls: ToolCallDeps;
  research: ResearchSetup | null;
  suppliers: { slots: CounterStore; timeLeft?: () => number; vendors?: VendorCalls };
  /** Checked before each paid tool call with its subcall count (newWorkGate); throws TurnStop to refuse. */
  callGate?: (subcalls: number) => Promise<void>;
  accounts?: { benchmark: readonly CanonicalAccount[]; currentMessage: string };
  skills?: PreparedSkills; skillFiles?: PreparedSkillFiles; readSource?: SourceReader;
  onCall?: ResearchToolsInput['onCall'];
};

/** The extra instructions of a turn whose research tools are usable (frozen with the tools, so stable within a session). */
export const researchInstructions = (plan: ToolPlan) =>
  plan.offered.some(name => (GENERAL_RESEARCH_TOOLS as readonly string[]).includes(name)) ? FREE_CHAT_RESEARCH_INSTRUCTIONS : '';

export function turnTools(input: TurnToolsInput): TurnTools {
  const { plan } = input;
  const outcomes: Partial<Record<ToolCallOutcome, number>> = {};
  let paidCalls = 0, freeCalls = 0, subcalls = 0;
  const rounds = researchRounds();
  const usable = (name: string) => plan.available.includes(name as never);
  const offeredResearch = plan.offered.filter((name): name is GeneralResearchToolName =>
    (GENERAL_RESEARCH_TOOLS as readonly string[]).includes(name));
  const research = offeredResearch.length ? researchTools({
    calls: input.calls, config: input.research?.config ?? { version: 1, enabled: false, vendors: {
      tikhub: { enabled: false, hardCapAttested: null }, parallel: { enabled: false, hardCapAttested: null },
      firecrawl: { enabled: false, hardCapAttested: null } }, verifiedPlatforms: [], benchmarkPlatforms: [], routes: [],
      limits: { maxSubcallsPerRound: 1, discoverSubcalls: 1 }, recentGrowth: { maxFirstPostAgeDays: 30, minViewsToFollowers: '0' } },
    names: input.research ? offeredResearch.filter(usable) : [], offered: offeredResearch,
    maxCalls: plan.limits.paidTools, maxSubcalls: plan.subcalls,
    suppliers: { keys: input.research?.keys ?? {}, policies: input.research?.policies ?? [], ...input.suppliers },
    accounts: input.accounts ?? { benchmark: [], currentMessage: '' },
    ...(input.callGate ? { callGate: input.callGate } : {}),
    ...(input.onCall ? { onCall: input.onCall } : {}),
    ...(input.replay ? { replay: input.replay } : {}),
    onOutcome: (_name, outcome, sent) => {
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      if (outcome !== 'not_sent') paidCalls++;
      subcalls += sent;
    },
  }) : [];

  const tools: RuntimeTool[] = [];
  for (const name of plan.offered) {
    if ((GENERAL_RESEARCH_TOOLS as readonly string[]).includes(name)) { tools.push(research.find(tool => tool.name === name)!); continue; }
    if (name === 'load_skill') {
      tools.push(usable(name) && input.skills
        ? turnLoadSkillTool(input.skills, LOAD_SKILL_CALLS, () => { freeCalls++; })
        : loadSkillTool(async () => SKILL_LOAD_REFUSED));
      continue;
    }
    if (name === 'read_skill_file') {
      tools.push(input.skillFiles ? turnSkillFileTool(input.skillFiles) : skillFileTool(async () => TOOL_UNAVAILABLE));
      continue;
    }
    // read_source
    const reader = input.readSource;
    let reads = 0;
    tools.push({ name, description: READ_SOURCE_DESCRIPTION, enabled: () => reads < READ_SOURCE_CALLS,
    async execute(arguments_) {
      if (!usable(name) || !reader || reads >= READ_SOURCE_CALLS) return TOOL_UNAVAILABLE;
      const query = typeof arguments_.query === 'string' ? arguments_.query : '';
      // Counted before the read: a failed read still used its model continuation.
      reads++; freeCalls++;
      try { return (await reader(query)).text; }
      catch { return JSON.stringify({ kind: 'unavailable', reason: 'read_failed' }); }
    } });
  }
  return {
    tools,
    // The runner offers no tool once this many ran, so the last model call can only answer (2.5.3).
    maxToolCalls: plan.limits.paidTools + plan.limits.freeTools,
    summary: (): ToolSummary => ({ paidCalls, freeCalls, subcalls, outcomes: { ...outcomes }, rounds: rounds.value() }),
  };
}
