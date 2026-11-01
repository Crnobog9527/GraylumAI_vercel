/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { runtimePathChoice, type RuntimePathInput } from './runtime-path';

const base: RuntimePathInput = { routeSession: 's1', choicesSettled: true, corePathV2: true, heldLoaded: true, held: false, viewSettled: true,
  scopeKind: 'positioning_draft', oldHistory: false };
const choose = (over: Partial<RuntimePathInput>) => runtimePathChoice({ ...base, ...over });

describe('which workspace a conversation opens in', () => {
  it('renders nothing until the switch and the probe have answered (the old workspace would take the first-send marker)', () => {
    // The first send from the start page lands here with the switch on: before `choices` answers the old workspace must not mount.
    expect(choose({ choicesSettled: false })).toBe('loading');
    expect(choose({ choicesSettled: false, corePathV2: false })).toBe('loading');
    expect(choose({ heldLoaded: false })).toBe('loading');
    expect(choose({ choicesSettled: false, heldLoaded: false })).toBe('loading');
  });
  it('opens the turn workspace for a conversation without old history once the view has answered', () => {
    expect(choose({ viewSettled: false })).toBe('loading');
    expect(choose({})).toBe('turn');
  });
  it('keeps a conversation with old-path history or a failed view on the old workspace; a work item without history moves', () => {
    expect(choose({ oldHistory: true })).toBe('old');
    expect(choose({ scopeKind: 'work_item' })).toBe('work');
    expect(choose({ scopeKind: 'work_item', oldHistory: true })).toBe('old');
    expect(choose({ scopeKind: undefined })).toBe('old');
  });
  it('follows the switch only: off and nothing of the turn path held is the old workspace, held replies stay on the turn path', () => {
    expect(choose({ corePathV2: false })).toBe('old');
    expect(choose({ corePathV2: false, held: true })).toBe('turn');
  });
  it('a new conversation page without a session has no marker to lose and starts on the old workspace', () => {
    expect(choose({ routeSession: '', choicesSettled: false })).toBe('old');
  });
});
