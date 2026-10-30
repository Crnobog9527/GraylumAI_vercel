/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ResearchCallResult } from '../../research/vendors/types';
import type { RuntimeTool } from '../../runtime/runner';
import type { TurnDatabase } from '../db';

/*
 * CORE-PATH-V2 V2-6: the tool layer of a turn (docs/launch/tasks/CORE-PATH-V2.md 2.5.2, 2.5.3, 2.7). This file is the
 * interface the kinds (chat, mentor V2-5, report V2-7a) build against; the implementation is in the sibling files.
 *
 * - Before turn_open, `planTurnTools` decides from the catalog cache which tools this session kind offers (the definitions
 *   never change within a session, 2.9 rule 2), which of them this turn can use (capacity, switches, prices, keys), and the
 *   limits and upper bounds that go into turnPolicy (limits.paidTools/freeTools, paidToolUpperUsd).
 * - The `opened` event carries `ToolAvailability`: what is usable and what was trimmed and why (2.7: never a silent drop).
 * - After turn_open, `turnTools` builds the RuntimeTools for the runner. Every paid tool call is one turn_calls row
 *   (begin before any supplier request, record after the last subcall); its supplier subcalls are counted in Node.
 * - At close, `TurnTools.summary()` gives what the kind writes with turn_close (research rounds for opc_drafts).
 */

/** Tools a turn may offer. Research names come from research/tools/names.ts. */
export type FreeToolName = 'read_source' | 'load_skill' | 'read_skill_file';
export type GeneralResearchToolName = 'social_search' | 'social_account' | 'web_search' | 'web_fetch';
export type TurnToolName = FreeToolName | GeneralResearchToolName;

/** Why a tool the session offers cannot be used this turn. */
export type TrimReason =
  | 'capacity' // the input budget cannot hold the tool's result reserve next to the required context
  | 'disabled' // the admin switch (chat research, research config) is off
  | 'no_route' // no priced, verified supplier route
  | 'no_key' // the supplier key slot is empty
  | 'limit'; // the turn's call limits leave no room

export type ToolAvailability = {
  /** Usable this turn, in offer order. */
  available: TurnToolName[];
  /** Offered by the session kind but not usable this turn (their definitions stay on the request, 2.9 rule 2). */
  trimmed: Array<{ name: TurnToolName; reason: TrimReason }>;
};

/** The plan a kind feeds into turnPolicy and the opened event. Built before turn_open; no database writes. */
export type ToolPlan = ToolAvailability & {
  /** Definitions on every request of this session kind (stable across turns). */
  offered: TurnToolName[];
  /** For turnPolicy: one entry per allowed paid tool call; the sum bounds every subcall of the turn (2.5.3). */
  paidToolUpperUsd: string[];
  /** For turnPolicy.limits. */
  limits: { paidTools: number; freeTools: number };
  /** Supplier subcalls the whole turn may spend (research config, e.g. 12 for a free chat). */
  subcalls: number;
  /** Appended to the current user message (never to the cached system prompt) when something was trimmed. */
  note: string | null;
  /** Input bytes kept free for one tool result and the reply after it (counted in the input budget). */
  reserveBytes: number;
};

/** Where the turn writes its money evidence: the same begin/record as model calls (2.5.2). */
export type ToolCallDeps = {
  db: Pick<TurnDatabase, 'begin' | 'record'>;
  actorId: string; turnId: number;
  /** The next free call sequence of this turn, shared with model calls. */
  nextSeq: () => number;
};

/** One supplier subcall as the meter sees it: what came back and its known cost (USD), or null when unknown. */
export type SubcallReceipt = {
  result: ResearchCallResult;
  /** The supplier's cost at the frozen price; null when the outcome or the usage is unknown. */
  costUsd: string | null;
  /** The route's frozen multiplier m. */
  multiplier: string;
};

/**
 * The settled form of one paid tool call (meter.ts settleToolCall):
 * - 'not_sent': no subcall reached a supplier: n=0, the call does not count against the limits.
 * - 'delivered': at least one subcall returned data; the user pays the call's known cost (status ok).
 * - 'no_data': subcalls ran but none returned data ("这次没取到数据"): the user pays 0; the platform's cost is kept
 *   (status unusable). Shown to the model as an explicit empty state, never as an empty list.
 * - 'unknown': some subcall may have reached the supplier without a usable answer: no receipt is written; turn_close marks
 *   the row unknown, the user pays 0 for it (third-party tool rule, Owner 10-13) and its stop-loss reserve waits for recovery.
 */
export type ToolCallOutcome = 'not_sent' | 'delivered' | 'no_data' | 'unknown';

/** Research rounds this turn completed, for the benchmark fallback (Owner 10-20, 10-27: a pasted-link check is a round). */
export type ResearchRounds = { keywordSearches: number; linkChecks: number };

export type ToolSummary = {
  paidCalls: number; freeCalls: number; subcalls: number;
  outcomes: Partial<Record<ToolCallOutcome, number>>;
  rounds: ResearchRounds;
};

/** What the runner gets. `maxToolCalls` bounds the tool rounds (the last model call is offered no tool, runner.ts). */
export type TurnTools = { tools: RuntimeTool[]; maxToolCalls: number; summary(): ToolSummary };
