/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe, expect, it} from 'vitest';
import {REPLY_LANGUAGE,REPLY_LANGUAGE_INSTRUCTIONS,withPrimaryAddenda} from './primaryInstructions';
import {sourceToolBytes} from './sourceRuntimeTool';
import {agentTurnInstructions} from '../opc/agentTurnPrompt';

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

  it('adds nothing for conversations without workspace context beyond the frozen reply-language rule', () => {
    expect(withPrimaryAddenda('base',{})).toBe('base');
    expect(withPrimaryAddenda('base',{replyLanguage:REPLY_LANGUAGE})).toBe('base'+REPLY_LANGUAGE_INSTRUCTIONS);
  });
});

describe('reply language (SKILL-I18N-HOOK)', () => {
  it('answers in the user language even though the Skill is written in Chinese', () => {
    const text=withPrimaryAddenda('完整的中文 Skill 正文',{replyLanguage:REPLY_LANGUAGE});
    // Appended after the Skill, so cached Skill prefixes are unchanged.
    expect(text.startsWith('完整的中文 Skill 正文\nReply language (host rule)')).toBe(true);
    expect(text).toContain("write replies, questions, card options and reports in the user's language");
    expect(text).toContain('Traditional Chinese uses Taiwan usage');
    expect(text).toContain('A language the user explicitly asks for wins');
    expect(text).toContain('else Simplified Chinese');
    // Report headings are checked verbatim (report/contract.ts), so they must stay as written.
    expect(text).toContain('Keep required exact strings (report headings, ids, JSON keys) unchanged');
  });

  it('applies with every other addendum, exactly once', () => {
    const text=withPrimaryAddenda('base',{workspaceContext:true,network:'require_latest',positioningGate:'fallback-v1',
      replyLanguage:REPLY_LANGUAGE});
    expect(text.split('Reply language (host rule)')).toHaveLength(2);
  });

  it('leaves contexts admitted before this rule byte-identical, so their crash replay keeps its request hash', () => {
    expect(withPrimaryAddenda('base',{workspaceContext:true})).not.toContain('Reply language');
    expect(withPrimaryAddenda('base',{replyLanguage:'reply-language-v0'})).toBe('base');
  });

  it('also applies to positioning mentor turns, whose host rules carry only the short version', () => {
    expect(withPrimaryAddenda('base',{mentorText:'append-card-v1',replyLanguage:REPLY_LANGUAGE} as never))
      .toBe('base'+REPLY_LANGUAGE_INSTRUCTIONS);
    expect(agentTurnInstructions()).toContain("Reply in the user's language");
    expect(agentTurnInstructions()).not.toContain('Taiwan usage');
  });
});
