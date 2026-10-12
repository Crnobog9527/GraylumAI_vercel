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

  it('adds nothing for conversations without workspace context', () => {
    expect(withPrimaryAddenda('base',{})).toBe('base');
  });
});
