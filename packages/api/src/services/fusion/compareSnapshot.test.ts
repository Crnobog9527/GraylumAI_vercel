/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { POSITIONING_FALLBACK_INSTRUCTIONS } from '../runtime/positioningFallback';
import { FREE_CHAT_BASE_INSTRUCTIONS, REPLY_LANGUAGE_INSTRUCTIONS } from '../runtime/primaryInstructions';
import { runtimeScopeInput } from '../runtime/context';
import { assertCompareFits, compareInput, compareInstructions, compareRequest, compareRequestBytes, snapshotHash, workspaceDependencies,
  type CompareParts } from './compareSnapshot';
import { fusionRequestBytes } from './request';
import { FUSION_INPUT_CAP } from './request';

const parts = (patch: Partial<CompareParts> = {}): CompareParts => ({ skill: null, positioningFallback: false, history: [], workspace: [],
  references: [], question: '哪个开头更好？', ...patch });
const skill = { moduleId: 'm', revisionId: 'r', skillId: 's', instructions: 'SKILL TEXT', resources: [{ path: 'a.md', hash: 'h1' }], socialMedia: false };

describe('compare snapshot (FUSION-COMPARE §3.2)', () => {
  it('starts from the ordinary free-conversation instruction and reply-language rule, with no brand identity statement', () => {
    expect(compareInstructions(parts())).toBe(FREE_CHAT_BASE_INSTRUCTIONS + REPLY_LANGUAGE_INSTRUCTIONS);
    expect(compareInstructions(parts())).not.toMatch(/Graylum/);
  });
  it('a Skill replaces the base instruction, as in an ordinary turn; the fallback rule only when the turn carries it', () => {
    expect(compareInstructions(parts({ skill }))).toBe('SKILL TEXT' + REPLY_LANGUAGE_INSTRUCTIONS);
    expect(compareInstructions(parts({ positioningFallback: true }))).toBe(FREE_CHAT_BASE_INSTRUCTIONS + REPLY_LANGUAGE_INSTRUCTIONS
      + POSITIONING_FALLBACK_INSTRUCTIONS);
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
