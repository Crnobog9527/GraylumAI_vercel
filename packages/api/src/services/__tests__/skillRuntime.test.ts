import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { resolvePublishedSkillSnapshot, skillSnapshotMetadata } from '../skillRuntime';

const published = (content = '  Exact Skill A\n', version = 1) => ({
  id: 'skill-a', skill_key: 'skill-a', status: 'published', published_content: content,
  published_version: version, published_content_hash: createHash('sha256').update(content).digest('hex'),
});
function fixture(data: unknown, error: unknown = null, throws = false) {
  const eq = vi.fn();
  const select = vi.fn();
  return { eq, select, from: () => {
    const q = { select: (columns: string) => { select(columns); return q; },
      eq: (key: string, value: string) => { eq(key, value); return q; },
      single: async () => { if (throws) throw new Error('private secret'); return { data, error }; } };
    return q;
  } };
}
describe('Skill runtime snapshot', () => {
  it.each([
    ['missing', null], ['draft', { ...published(), status: 'draft' }],
    ['archived', { ...published(), status: 'archived' }],
    ['empty', { ...published(), published_content: '  ' }],
    ['null', { ...published(), published_content: null }],
    ['wrong hash', { ...published(), published_content_hash: '0'.repeat(64) }],
    ['invalid hash', { ...published(), published_content_hash: 'bad' }],
    ['invalid version', { ...published(), published_version: 0 }],
    ['wrong skill', { ...published(), id: 'skill-b' }],
    ['empty key', { ...published(), skill_key: '' }],
  ])('fails closed for %s', async (_name, data) => {
    await expect(resolvePublishedSkillSnapshot(fixture(data) as any, { id: 'module-a', skill_id: 'skill-a' }))
      .rejects.toMatchObject({ code: 'MODULE_SKILL_UNAVAILABLE', statusCode: 503 });
  });
  it.each([false, true])('normalizes returned/thrown DB errors (%s)', async (throws) => {
    await expect(resolvePublishedSkillSnapshot(fixture(null, { message: 'private secret' }, throws) as any, { id: 'module-a', skill_id: 'skill-a' }))
      .rejects.toMatchObject({ code: 'MODULE_SKILL_UNAVAILABLE', message: expect.not.stringContaining('private secret') });
  });
  it('does not query an unbound Skill', async () => {
    const db = fixture(published());
    await expect(resolvePublishedSkillSnapshot(db as any, { id: 'module-a', skill_id: null })).rejects.toMatchObject({ code: 'MODULE_SKILL_UNAVAILABLE' });
    expect(db.select).not.toHaveBeenCalled();
  });
  it('freezes exact bytes and identity; next request gets the newly published version', async () => {
    const row = published(); const db = fixture(row);
    const first = await resolvePublishedSkillSnapshot(db as any, { id: 'module-a', skill_id: 'skill-a' });
    Object.assign(row, published('New v2', 2));
    const second = await resolvePublishedSkillSnapshot(db as any, { id: 'module-a', skill_id: 'skill-a' });
    expect(first.publishedContent).toBe('  Exact Skill A\n');
    expect(Object.isFrozen(first)).toBe(true);
    expect(second.publishedVersion).toBe(2);
    expect(second.publishedContent).toBe('New v2');
    expect(db.eq).toHaveBeenNthCalledWith(1, 'id', 'skill-a');
    expect(db.select.mock.calls.every(([columns]) => !columns.includes('draft'))).toBe(true);
    expect(skillSnapshotMetadata(first)).toEqual({ skillId: 'skill-a', skillKey: 'skill-a', publishedVersion: 1,
      publishedContentHash: first.publishedContentHash, moduleId: 'module-a' });
  });
});
