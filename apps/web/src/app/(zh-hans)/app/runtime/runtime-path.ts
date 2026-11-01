/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/*
 * CORE-PATH-V2 V2-10: which workspace a conversation opens in. The first message of a new conversation is left for the workspace in
 * a sessionStorage marker ('opc-runtime-send:<session>'); the old workspace consumes it on mount and prepares a run on the old
 * path. So no workspace may render before the path is decided, or a first send made from the start page would be taken by the old
 * workspace while the conversation then switches to the turn path, with the marker gone and nothing sent.
 */
export type RuntimePathInput = {
  routeSession: string;
  /** `runtime.choices` has answered, with data or with an error; until then the switch is unknown. */
  choicesSettled: boolean;
  corePathV2: boolean;
  /** The probe for turn-path replies has answered. */
  heldLoaded: boolean;
  held: boolean;
  /** `runtime.view` has answered (data or error); only read once the conversation is on the turn path. */
  viewSettled: boolean;
  scopeKind?: string;
};

export function runtimePathChoice(input: RuntimePathInput): 'loading' | 'turn' | 'work' | 'old' {
  // A new conversation (no session yet) has no marker to lose: the old workspace starts it.
  if (!input.routeSession) return 'old';
  if (!input.choicesSettled || !input.heldLoaded) return 'loading';
  if (!input.corePathV2 && !input.held) return 'old';
  if (!input.viewSettled) return 'loading';
  // With the switch on every free conversation and work item runs on the turn path, also one that holds old-path history (test data only:
  // the real database is built new, plan 5.4): it reads session_messages, so it sees only its new messages. V2-12 removes the old path.
  return input.scopeKind === 'positioning_draft' ? 'turn' : input.scopeKind === 'work_item' ? 'work' : 'old';
}
