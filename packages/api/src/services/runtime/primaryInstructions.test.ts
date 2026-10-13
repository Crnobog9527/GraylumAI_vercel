/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe, expect, it} from 'vitest';
import {withPrimaryAddenda} from './primaryInstructions';
import {sourceToolBytes} from './sourceRuntimeTool';

describe('workspace context instructions', () => {
  it('lets free conversations read confirmed positioning through read_source', () => {
    const text=withPrimaryAddenda('base',{workspaceContext:true});
    expect(text).toContain('confirmed positioning, account strategy or topic');
    expect(text).toContain('call read_source with no query');
    // The tool description the model sees names positioning in its index too.
    expect(sourceToolBytes(['read_source'],true)).toBe(Buffer.byteLength(JSON.stringify([{name:'read_source',
      description:'Read owned business context only when relevant. Omit query to list positioning/account/topic metadata; '+
        'pass an exact returned id to read that source. Read-only; no internet access.'}])));
  });

  it('reads positioning without a clarification round unless names tell several apart', () => {
    const text=withPrimaryAddenda('base',{workspaceContext:true});
    expect(text).toContain('when one is listed, read it directly');
    expect(text).toContain('ask which one by name');
    // 0117 names every business 未命名业务 until the user renames it.
    expect(text).toContain('share a name or carry the default name 未命名业务, read the most recently confirmed one');
    expect(text).toContain('by its confirmation date and that the user can switch');
    expect(text).toContain('Never show source ids to the user');
    expect(text).not.toContain('intended positioning or account is ambiguous');
  });

  it('adds nothing for conversations without workspace context', () => {
    expect(withPrimaryAddenda('base',{})).toBe('base');
  });
});
