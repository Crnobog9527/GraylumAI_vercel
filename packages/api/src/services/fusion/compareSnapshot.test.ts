/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { POSITIONING_FALLBACK_INSTRUCTIONS } from '../runtime/positioningFallback';
import { FREE_CHAT_BASE_INSTRUCTIONS, REPLY_LANGUAGE_INSTRUCTIONS } from '../runtime/primaryInstructions';
import { replySettingInstructions } from '../runtime/replyLanguage';
const REPLY_RULE = replySettingInstructions('zh-Hans');
import { runtimeScopeInput } from '../runtime/context';
import { assertCompareFits, compareInput, compareInstructions, compareRequest, compareRequestBytes, snapshotHash, workspaceDependencies,
  type CompareParts } from './compareSnapshot';
import { fusionRequestBytes } from './request';
import { FUSION_INPUT_CAP } from './request';

const parts = (patch: Partial<CompareParts> = {}): CompareParts => ({ skill: null, positioningFallback: false, history: [], workspace: [],
  references: [], question: '哪个开头更好？', replyLocale: 'zh-Hans', ...patch });
const skill = { moduleId: 'm', revisionId: 'r', skillId: 's', instructions: 'SKILL TEXT', resources: [{ path: 'a.md', hash: 'h1' }], socialMedia: false };

describe('compare snapshot (FUSION-COMPARE §3.2)', () => {
  it('starts from the ordinary free-conversation instruction and reply-language rule, with no brand identity statement', () => {
    expect(compareInstructions(parts())).toBe(FREE_CHAT_BASE_INSTRUCTIONS + REPLY_RULE);
    expect(compareInstructions(parts())).not.toMatch(/Graylum/);
  });
  it('a Skill replaces the base instruction, as in an ordinary turn; the fallback rule only when the turn carries it', () => {
    expect(compareInstructions(parts({ skill }))).toBe('SKILL TEXT' + REPLY_RULE);
    expect(compareInstructions(parts({ positioningFallback: true }))).toBe(FREE_CHAT_BASE_INSTRUCTIONS + REPLY_RULE
      + POSITIONING_FALLBACK_INSTRUCTIONS);
  });
  it('carries the language set in the profile; the language is not part of the request identity (Owner 2026-10-24)', () => {
    for (const locale of ['zh-Hant', 'en'] as const) {
      expect(compareInstructions(parts({ replyLocale: locale }))).toBe(FREE_CHAT_BASE_INSTRUCTIONS + replySettingInstructions(locale));
      expect(compareRequest(parts({ replyLocale: locale })).instructions).toContain(replySettingInstructions(locale));
      // A retry after the user changed the setting must still match the request (and group) frozen by the first attempt.
      expect(snapshotHash(parts({ replyLocale: locale }))).toBe(snapshotHash(parts()));
    }
  });
  it('keeps the identity of compares recorded before the setting existed (the pre-setting formula, byte for byte)', () => {
    // The formula as it was before CHAT-LANGUAGE: the free-chat (or Skill) instruction plus the v1 reply-language rule.
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    const before = (p: CompareParts) => {
      const request = compareRequest({ ...p, positioningFallback: false });
      return sha(JSON.stringify({ instructions: (p.skill ? p.skill.instructions : FREE_CHAT_BASE_INSTRUCTIONS) + REPLY_LANGUAGE_INSTRUCTIONS,
        history: request.history, input: request.input,
        skill: p.skill && { moduleId: p.skill.moduleId, revisionId: p.skill.revisionId, resources: p.skill.resources },
        workspace: p.workspace.map(({ sourceVersionId, body }) => [sourceVersionId, sha(body)]),
        references: p.references.map(({ documentId, version, hash }) => [documentId, version, hash]) }));
    };
    for (const p of [parts(), parts({ skill, replyLocale: 'en' }), parts({ history: [{ role: 'user', text: '早' }], replyLocale: 'zh-Hant',
      workspace: [{ sourceVersionId: 'v1', kind: 'positioning', body: '定位' }] })]) expect(snapshotHash(p)).toBe(before(p));
  });
  it('the user message is byte-identical to an ordinary turn without sources or documents', () => {
    expect(compareInput(parts())).toBe('哪个开头更好？');
    const material = { brief: '选题简报' };
    expect(compareInput(parts({ scopeMaterial: material }))).toBe(runtimeScopeInput('哪个开头更好？', material));
  });
  it('workspace sources and library documents are added as data beside the request, without their ids', () => {
    const input = JSON.parse(compareInput(parts({ workspace: [{ sourceVersionId: 'v1', kind: 'positioning', body: 'P' }],
      references: [{ documentId: 'd1', version: '3', hash: 'x', title: '文档', text: 'T' }] })));
    expect(input).toMatchObject({ workspaceSources: [{ kind: 'positioning', body: 'P' }], libraryDocuments: [{ title: '文档', text: 'T' }],
      userRequest: '哪个开头更好？' });
    expect(JSON.stringify(input)).not.toMatch(/v1|d1/);
  });
  it('carries the earlier turns as plain messages in order', () => {
    const request = compareRequest(parts({ history: [{ role: 'user', text: 'Q1' }, { role: 'assistant', text: 'A1' }] }));
    expect(request.history).toEqual([{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }]);
    expect(fusionRequestBytes(request)).toBeGreaterThan(fusionRequestBytes(compareRequest(parts())));
  });
  it('refuses a snapshot over the interactive cap and never shortens it', () => {
    expect(() => assertCompareFits(compareRequest(parts()))).not.toThrow();
    const big = compareRequest(parts({ history: [{ role: 'user', text: 'x'.repeat(FUSION_INPUT_CAP) }] }));
    expect(compareRequestBytes(big)).toBeGreaterThan(FUSION_INPUT_CAP);
    expect(() => assertCompareFits(big)).toThrow('FUSION_COMPARE_INPUT_TOO_LARGE');
  });
  it('hashes everything a column receives except the fallback flag, so the hash is known before the paid judgement', () => {
    const base = snapshotHash(parts());
    expect(snapshotHash(parts({ positioningFallback: true }))).toBe(base);
    for (const patch of [{ question: '另一个问题' }, { history: [{ role: 'user' as const, text: 'x' }] }, { skill },
      { workspace: [{ sourceVersionId: 'v1', kind: 'positioning', body: 'P' }] },
      { references: [{ documentId: 'd', version: '1', hash: 'h', title: 't', text: 'T' }] }, { scopeMaterial: { a: 1 } }])
      expect(snapshotHash(parts(patch))).not.toBe(base);
    expect(snapshotHash(parts({ skill }))).not.toBe(snapshotHash(parts({ skill: { ...skill, revisionId: 'r2' } })));
  });
  it('records frozen workspace sources as [{ sourceVersionId }] objects, which the erasure code recognises', () => {
    expect(workspaceDependencies(parts({ workspace: [{ sourceVersionId: 'v1', kind: 'a', body: '1' }, { sourceVersionId: 'v1', kind: 'b', body: '2' },
      { sourceVersionId: 'v2', kind: 'c', body: '3' }] }))).toEqual([{ sourceVersionId: 'v1' }, { sourceVersionId: 'v2' }]);
    expect(workspaceDependencies(parts())).toEqual([]);
  });
});
