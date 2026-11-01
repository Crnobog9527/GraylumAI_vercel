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
  oldHistory: boolean;
};

export function runtimePathChoice(input: RuntimePathInput): 'loading' | 'turn' | 'work' | 'old' {
  // A new conversation (no session yet) has no marker to lose: the old workspace starts it.
  if (!input.routeSession) return 'old';
  if (!input.choicesSettled || !input.heldLoaded) return 'loading';
  if (!input.corePathV2 && !input.held) return 'old';
  if (!input.viewSettled) return 'loading';
  // A conversation that already holds old-path history stays on the old path: the turn path reads session_messages only, so it would
  // show the earlier talk without the model having it. V2-12 removes the old path with it.
  if (input.oldHistory) return 'old';
  return input.scopeKind === 'positioning_draft' ? 'turn' : input.scopeKind === 'work_item' ? 'work' : 'old';
}
