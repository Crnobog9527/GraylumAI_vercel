import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { skillsRouter } from './skills';

const ID = '00000000-0000-4000-8000-000000000011';
const MODULE = '00000000-0000-4000-8000-000000000001';
const published = { id: ID, skill_key: 'writer', status: 'published', content_kind: 'text', published_content: 'System',
  published_version: 1, published_content_hash: createHash('sha256').update('System').digest('hex') };
const calls: [string, Record<string, unknown> | undefined][] = [
  ['list', undefined], ['get', { id: ID }], ['create', { skillKey: 'writer', draftContent: 'draft' }],
  ['editDraft', { id: ID, draftContent: 'draft' }], ['publish', { id: ID }], ['archive', { id: ID }],
  ['listModules', undefined], ['createModule', { title: 'Writer' }],
  ['bindModule', { id: MODULE, skillId: ID }], ['setModuleActive', { id: MODULE, active: true }],
];
function setup(role = 'admin', results: unknown[] = [{ id: ID }], privileges = true) {
  const operations: unknown[][] = [];
  const db = { from: vi.fn((table: string) => {
    const resolve = () => {
      const result = results.shift();
      return result && typeof result === 'object' && 'error' in result ? result : { data: result, error: null, count: 1 };
    };
    const q: any = {
      select: (...args: unknown[]) => { operations.push([table, 'select', ...args]); return q; },
      insert: (payload: unknown) => { operations.push([table, 'insert', payload]); return q; },
      update: (payload: unknown) => { operations.push([table, 'update', payload]); return q; },
      eq: (...args: unknown[]) => { operations.push([table, 'eq', ...args]); return q; },
      order: () => q, range: () => q,
      single: async () => resolve(),
      then: (onResolve: (result: unknown) => unknown) => Promise.resolve(resolve()).then(onResolve),
    };
    return q;
  }), rpc: vi.fn().mockImplementation(async (name: string) => ({ data: name === 'is_text_skill_executable' ? true : [{ skill_id: ID }], error: null })) };
  const authDb = { from: () => {
    const q = { select: () => q, eq: () => q, single: async () => ({ data: {
      id: 'admin-user', role, status: 'active', email: 'admin@example.com', nickname: 'Admin',
    }, error: null }) };
    return q;
  } };
  const caller = skillsRouter.createCaller({
    headers: new Headers(), user: role === 'anonymous' ? null : {
      id: 'admin-user', email: 'admin@example.com', app_metadata: { provider: 'email' }, user_metadata: {},
    },
    isEmailVerified: true, authProvider: 'email', supabase: authDb, supabaseAuth: authDb,
    supabasePublic: {}, supabaseAdmin: db, hasSupabaseAdminPrivileges: privileges,
  } as any);
  return { caller, db, operations };
}

describe('skillsRouter actual admin authorization', () => {
  it.each(calls)('rejects ordinary user for %s before accessing privileged data', async (name, input) => {
    const { caller, db } = setup('user');
    await expect((caller as any)[name](input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.from).not.toHaveBeenCalled(); expect(db.rpc).not.toHaveBeenCalled();
  });
  it.each(calls)('rejects anonymous access for %s', async (name, input) => {
    const { caller, db } = setup('anonymous');
    await expect((caller as any)[name](input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(db.from).not.toHaveBeenCalled(); expect(db.rpc).not.toHaveBeenCalled();
  });
  it('rejects admin when service role is absent', async () => {
    const { caller, db } = setup('admin', [], false);
    await expect(caller.list()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(db.from).not.toHaveBeenCalled();
  });
  it.each(calls)('allows admin to execute %s using the privileged client', async (name, input) => {
    const results = name === 'setModuleActive' ? [{ id: MODULE, skill_id: ID }, published, { id: MODULE, active: true }]
      : name === 'bindModule' ? [{ id: ID }, { id: MODULE, skill_id: ID }] : [{ id: ID }];
    const { caller, db } = setup('admin', results);
    await (caller as any)[name](input);
    expect(db.from.mock.calls.length + db.rpc.mock.calls.length).toBeGreaterThan(0);
  });
});

describe('skillsRouter contract writes', () => {
  it('creates only draft state with server-owned audit identity', async () => {
    const { caller, operations } = setup();
    await caller.create({ skillKey: 'writer', draftContent: 'Draft' });
    expect(operations).toContainEqual(['skills', 'insert', { skill_key: 'writer', draft_content: 'Draft',
      status: 'draft', created_by: 'admin-user', updated_by: 'admin-user' }]);
  });
  it('edits only draft fields without replacing the current published snapshot', async () => {
    const { caller, operations } = setup();
    await caller.editDraft({ id: ID, draftContent: 'Next' });
    expect(operations).toContainEqual(['skills', 'update', { draft_content: 'Next', updated_by: 'admin-user' }]);
  });
  it('publishes through the atomic SKILL-1A RPC without table writes', async () => {
    const { caller, db } = setup();
    await caller.publish({ id: ID });
    expect(db.from).not.toHaveBeenCalled();
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith('atomic_publish_skill', {
      p_skill_id: ID, p_published_by: 'admin-user', p_publish_metadata: { source: 'admin_skills' },
    });
  });
  it('archives with server-owned audit fields', async () => {
    const { caller, operations } = setup();
    await caller.archive({ id: ID });
    expect(operations).toContainEqual(['skills', 'update', expect.objectContaining({ status: 'archived', archived_by: 'admin-user', archived_at: expect.any(String) })]);
  });
  it('creates inactive modules without accepting legacy prompts', async () => {
    const { caller, operations } = setup();
    await caller.createModule({ title: 'Writer' });
    expect(operations).toContainEqual(['modules', 'insert', expect.objectContaining({ active: false, skill_id: null })]);
    await expect(caller.createModule({ title: 'Writer', active: true } as any)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
  it('requires inactive state while rebinding and CAS checks enable binding', async () => {
    const binding = setup('admin', [{ id: ID }, { id: MODULE }]);
    await binding.caller.bindModule({ id: MODULE, skillId: ID });
    expect(binding.operations).toContainEqual(['modules', 'eq', 'active', false]);
    const activation = setup('admin', [{ id: MODULE, skill_id: ID }, published, { id: MODULE }]);
    await activation.caller.setModuleActive({ id: MODULE, active: true });
    expect(activation.operations).toContainEqual(['modules', 'eq', 'skill_id', ID]);
  });
  it.each(['draft', 'archived'])('rejects enabling %s Skill', async (status) => {
    const { caller } = setup('admin', [{ id: MODULE, skill_id: ID }, { ...published, status }]);
    await expect(caller.setModuleActive({ id: MODULE, active: true })).rejects.toMatchObject({ message: expect.stringContaining('MODULE_SKILL_UNAVAILABLE') });
  });
  it('allows disabling without any Skill read', async () => {
    const { caller, db } = setup('admin', [{ id: MODULE }]);
    await caller.setModuleActive({ id: MODULE, active: false });
    expect(db.from).toHaveBeenCalledExactlyOnceWith('modules');
  });
  it.each(['create', 'editDraft', 'publish'])('rejects client-injected published fields in %s', async (name) => {
    const { caller, db } = setup();
    const input = calls.find(([key]) => key === name)![1];
    await expect((caller as any)[name]({ ...input, published_version: 999, published_content: 'Injected' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.from).not.toHaveBeenCalled(); expect(db.rpc).not.toHaveBeenCalled();
  });
  it('reports DB failure without private database details', async () => {
    const { caller } = setup('admin', [{ data: null, error: { message: 'secret database URL' } }]);
    await expect(caller.get({ id: ID })).rejects.toMatchObject({ message: 'Skill 不存在或读取失败' });
  });
});
