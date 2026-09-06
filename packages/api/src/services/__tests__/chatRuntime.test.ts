import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { applyUserPromptTemplate, buildRuntimeSystemPrompt, resolveActiveModulePrompt } from '../chatRuntime';

const content = '  Published system\n';
function client(module: Record<string, unknown> | null, error: unknown = null) {
  const select = vi.fn();
  return { rpc: vi.fn().mockResolvedValue({ data: true, error: null }), select, from: (table: string) => {
    const query = {
      select: (columns: string) => { select(table, columns); return query; },
      eq: () => query,
      single: async () => table === 'modules' ? { data: module, error } : { data: {
        id: 'skill-a', skill_key: 'a', status: 'published', content_kind: 'text', published_content: content,
        published_version: 1, published_content_hash: createHash('sha256').update(content).digest('hex'),
      }, error: null },
    };
    return query;
  } };
}
describe('active module Skill prompt', () => {
  it('uses exact published bytes and ignores every legacy field', async () => {
    const db = client({ id: 'module-a', active: true, skill_id: 'skill-a', title: 'A', platform: 'web',
      description: 'BAD description', prompt_content: 'BAD content', system_prompt: 'BAD system', user_prompt_template: 'BAD {{input}}' });
    const prompt = await resolveActiveModulePrompt(db as any, { moduleId: 'module-a' });
    expect(buildRuntimeSystemPrompt(prompt)).toBe(content);
    expect(applyUserPromptTemplate(prompt, '  Original user\n')).toBe('  Original user\n');
    expect(Object.isFrozen(prompt)).toBe(true);
    expect(prompt.skillSnapshot?.moduleId).toBe('module-a');
    expect(db.select.mock.calls[0][1]).not.toMatch(/description|prompt_content|system_prompt|user_prompt_template/);
  });
  it.each([
    [{ id: 'module-a', active: false }, null, 'MODULE_INACTIVE'],
    [{ id: 'module-a', active: true, platform: 'mobile' }, null, 'MODULE_PLATFORM_UNSUPPORTED'],
    [{ id: 'module-a', active: true, description: 'must not fallback' }, null, 'MODULE_SKILL_UNAVAILABLE'],
    [null, null, 'MODULE_NOT_FOUND'],
    [null, { code: '08006' }, 'MODULE_SKILL_UNAVAILABLE'],
  ])('rejects unavailable modules (%j)', async (module, error, code) => {
    await expect(resolveActiveModulePrompt(client(module, error) as any, { moduleId: 'module-a' })).rejects.toMatchObject({ code });
  });
});
