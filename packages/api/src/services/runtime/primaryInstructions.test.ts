/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe, expect, it} from 'vitest';
import {FREE_CHAT_BASE_INSTRUCTIONS,FREE_CHAT_POSITIONING_REDIRECT,freeChatInstructions,REPLY_LANGUAGE,REPLY_LANGUAGE_INSTRUCTIONS,VOICE_GUIDE,VOICE_GUIDES,WORKSPACE_STRATEGY_GUIDE,voiceAddendum,withPrimaryAddenda} from './primaryInstructions';
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

describe('REPORT-VISUAL strategy read guide', () => {
  const plain=withPrimaryAddenda('base',{workspaceContext:true});
  it('is added only to executions admitted with it, so older executions replay byte-identical', () => {
    expect(withPrimaryAddenda('base',{workspaceContext:true,workspaceGuide:'strategy-read-v0'})).toBe(plain);
    expect(withPrimaryAddenda('base',{workspaceGuide:WORKSPACE_STRATEGY_GUIDE})).toBe('base');
    const guided=withPrimaryAddenda('base',{workspaceContext:true,workspaceGuide:WORKSPACE_STRATEGY_GUIDE});
    expect(guided.startsWith(plain)).toBe(true);
    expect(guided).toContain('strategyReport id');
    expect(guided).toContain('make your one read that id');
  });
});


describe('VOICE writing addendum', () => {
  const profile = { tone: '像跟朋友唠嗑', sentenceLength: '短句多', openings: '', stance: '', phrases: ['咋整', '搞定'], avoid: ['家人们'],
    platforms: '', samples: ['哎下班到家都七点了，咋整。'] };
  it('appends the confirmed profile only with the frozen guide', () => {
    const text = withPrimaryAddenda('BASE', { voice: { guide: VOICE_GUIDE, profile } });
    expect(text.startsWith('BASE\n\nWriting voice (host rule)')).toBe(true);
    expect(text).toContain('<user_voice>\n- 语气：像跟朋友唠嗑\n- 句子长短：短句多\n- 常用表达：咋整、搞定\n- 不会用的表达：家人们');
    expect(text).not.toContain('原文片段');
    expect(text).not.toContain('哎下班到家都七点了');
    expect(text).not.toContain('开头方式');
    expect(withPrimaryAddenda('BASE', { voice: { guide: 'voice-v0', profile } })).toBe('BASE');
    expect(withPrimaryAddenda('BASE', {})).toBe('BASE');
  });
  it('is the same text voiceAddendum gives admission to size', () => {
    expect(withPrimaryAddenda('B', { voice: { guide: VOICE_GUIDE, profile } })).toBe('B' + voiceAddendum(profile));
  });
});

describe('VOICE wording versions (acceptance step 8: the draft must not copy the samples)', () => {
  const profile = { tone: '口语', sentenceLength: '短', openings: '', stance: '', phrases: ['咋整'], avoid: [], platforms: '',
    samples: ['第一段原文', '第二段原文'] };
  it('the current wording gives no sample passage at all and lists only word-sized phrases', () => {
    const long = '哎下班到家都七点了咋整啊真的是服了';
    const text = voiceAddendum({ ...profile, phrases: ['咋整', long] });
    expect(VOICE_GUIDE).toBe('voice-v3');
    expect(text).toContain('No sample passages are given on purpose');
    expect(text).toContain('- 常用表达：咋整\n');
    expect(text).not.toContain(long);
    expect(text).not.toContain('第一段原文');
    expect(text).not.toContain('原文片段');
  });
  it('an execution frozen with voice-v2 replays its own text, samples labelled as style only', () => {
    const text = voiceAddendum(profile, 'voice-v2');
    expect(text).toContain('Never copy a sentence from them');
    expect(text).toContain('原文片段 1（只看语气，不可照抄）：第一段原文');
    expect(withPrimaryAddenda('B', { voice: { guide: 'voice-v2', profile } })).toBe('B' + text);
  });
  it('an execution frozen with voice-v1 replays its own earlier text byte for byte', () => {
    const text = voiceAddendum(profile, 'voice-v1');
    expect(text).not.toContain('Never copy a sentence');
    expect(text).toContain('- 原文片段 1：第一段原文');
    expect(withPrimaryAddenda('B', { voice: { guide: 'voice-v1', profile } })).toBe('B' + text);
    expect(VOICE_GUIDES).toEqual(['voice-v1', 'voice-v2', 'voice-v3']);
  });
  it('an unknown wording adds nothing', () => {
    expect(withPrimaryAddenda('B', { voice: { guide: 'voice-v0', profile } })).toBe('B');
  });
});


// REL-1 core 4③ (Codex batch 10 B ③ step 5): "帮我重新做一次账号定位" in free chat read the positioning and then asked the
// positioning questions itself. Free chat must send the user to the positioning entry instead.
describe('free chat positioning redirect', () => {
  it('sends a redo or change of positioning to its own page instead of interviewing in chat', () => {
    expect(freeChatInstructions(true)).toBe(FREE_CHAT_BASE_INSTRUCTIONS+FREE_CHAT_POSITIONING_REDIRECT);
    expect(FREE_CHAT_POSITIONING_REDIRECT).toContain('do, redo or restart their account positioning');
    expect(FREE_CHAT_POSITIONING_REDIRECT).toContain('change to a different positioning or direction');
    expect(FREE_CHAT_POSITIONING_REDIRECT).toContain('do not ask them positioning questions here');
    expect(FREE_CHAT_POSITIONING_REDIRECT).toContain('[对话首页](/app/positioning)');
    expect(FREE_CHAT_POSITIONING_REDIRECT).toContain('「梳理账号定位」');
    expect(FREE_CHAT_POSITIONING_REDIRECT).toContain('「修改定位」');
    // Questions about the current positioning stay ordinary answers.
    expect(FREE_CHAT_POSITIONING_REDIRECT).toContain('Questions about their current positioning');
  });
  it('is left out where the positioning check or another host applies', () => {
    expect(freeChatInstructions(false)).toBe(FREE_CHAT_BASE_INSTRUCTIONS);
  });
});
