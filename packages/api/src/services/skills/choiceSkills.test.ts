/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CHOICE_MODULES_AT_ONCE, listChoiceSkills, type ChoiceModule } from './choiceSkills';
import type { UserVisibleModule } from './databaseSource';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const moduleRow = (n: number, extra: Partial<ChoiceModule> = {}): ChoiceModule =>
  ({ id: id(n), skill_id: id(100 + n), title: `Skill ${n}`, model_id: id(900), required_member_level: null, ...extra });
const visibleOf = (modules: ChoiceModule[]) => modules.map(row => ({ id: row.id, active: true })) as unknown as UserVisibleModule[];

/** A fake of the per-module source: `plan[moduleId]` says what its package holds, or that it cannot be read. */
function harness(plan: Record<string, { revisions?: Array<{ revisionId: string; tasks?: Record<string, unknown> }>; fail?: boolean; waitMs?: number }>) {
  const getUser = vi.fn(async () => ({ data: { user: { id: id(9), email_confirmed_at: '2026-01-01' } }, error: null }));
  const userClient = { auth: { getUser } } as unknown as SupabaseClient;
  const sources: Array<Record<string, unknown>> = [];
  let running = 0, peak = 0;
  const sourceFor = (options: Record<string, unknown>) => {
    sources.push(options);
    const entry = plan[options.moduleId as string] ?? {};
    const revisions = entry.revisions ?? [{ revisionId: id(500) }];
    return {
      // Like the database source, every read asks the request who the caller is.
      list: async () => {
        running += 1; peak = Math.max(peak, running);
        await (options.authentication as () => Promise<unknown>)();
        await tick(entry.waitMs ?? 2);
        running -= 1;
        if (entry.fail) throw new Error('UNAVAILABLE');
        return revisions.map(revision => ({ revisionId: revision.revisionId, tasks: revision.tasks ?? {} }));
      },
      revisions,
    };
  };
  const discover = async (source: { revisions: Array<{ revisionId: string }> }) => {
    await tick(1);
    return source.revisions.map(revision => ({ selection: revision, public: { revisionId: revision.revisionId } }));
  };
  return { userClient, getUser, sources, peak: () => peak,
    seams: { sourceFor: sourceFor as never, discover: discover as never } };
}
const all = () => true;

describe('listChoiceSkills', () => {
  it('lists every runnable module in the order of the modules, however long each read takes', async () => {
    const modules = [moduleRow(1), moduleRow(2), moduleRow(3), moduleRow(4)];
    const h = harness({ [id(1)]: { waitMs: 30 }, [id(2)]: { waitMs: 1 }, [id(3)]: { waitMs: 15 }, [id(4)]: { waitMs: 1 } });
    const skills = await listChoiceSkills({ userClient: h.userClient, privateClient: null, visible: visibleOf(modules), modules,
      runnable: all, listed: all, tier: null, ...h.seams });
    expect(skills.map(skill => skill.name)).toEqual(['Skill 1', 'Skill 2', 'Skill 3', 'Skill 4']);
    expect(skills[0]).toEqual({ moduleId: id(1), revisionId: id(500), name: 'Skill 1', requiredMemberLevel: null, locked: false });
  });

  it('asks who the caller is once for the whole request, and reads a few modules at a time', async () => {
    const modules = Array.from({ length: 8 }, (_, index) => moduleRow(index + 1));
    const h = harness(Object.fromEntries(modules.map(row => [row.id, { waitMs: 10 }])));
    await listChoiceSkills({ userClient: h.userClient, privateClient: null, visible: visibleOf(modules), modules,
      runnable: all, listed: all, tier: null, ...h.seams });
    expect(h.getUser).toHaveBeenCalledTimes(1);
    expect(h.peak()).toBe(CHOICE_MODULES_AT_ONCE);
    // Every source is given the request's shared identity check and the user-scoped module row, never a fresh one.
    expect(new Set(h.sources.map(source => source.authentication)).size).toBe(1);
    expect(h.sources.every(source => (source.userVisibleModule as { id: string }).id === source.moduleId)).toBe(true);
  });

  it('leaves out a module without a Skill, one the host cannot run and one that is not listed, without reading them', async () => {
    const modules = [moduleRow(1, { skill_id: null }), moduleRow(2, { model_id: id(901) }), moduleRow(3, { model_id: id(902) }), moduleRow(4)];
    const h = harness({});
    const skills = await listChoiceSkills({ userClient: h.userClient, privateClient: null, visible: visibleOf(modules), modules,
      runnable: row => row.model_id !== id(901), listed: row => row.model_id !== id(902), tier: null, ...h.seams });
    expect(skills.map(skill => skill.moduleId)).toEqual([id(4)]);
    expect(h.sources.map(source => source.moduleId)).toEqual([id(4)]);
  });

  it('leaves out a module whose package cannot be read, and a package with tasks, without failing the list', async () => {
    const modules = [moduleRow(1), moduleRow(2), moduleRow(3)];
    const h = harness({ [id(1)]: { fail: true }, [id(2)]: { revisions: [{ revisionId: id(501), tasks: { plan: {} } }, { revisionId: id(502) }] } });
    const skills = await listChoiceSkills({ userClient: h.userClient, privateClient: null, visible: visibleOf(modules), modules,
      runnable: all, listed: all, tier: null, ...h.seams });
    expect(skills.map(skill => [skill.moduleId, skill.revisionId])).toEqual([[id(2), id(502)], [id(3), id(500)]]);
  });

  it('pins the work conversation\'s method revision on its module only', async () => {
    const modules = [moduleRow(1), moduleRow(2)];
    const h = harness({});
    await listChoiceSkills({ userClient: h.userClient, privateClient: null, visible: visibleOf(modules), modules,
      runnable: all, listed: all, tier: null, pin: { moduleId: id(2), revisionId: id(777) }, ...h.seams });
    expect(h.sources.map(source => source.revisionId)).toEqual([undefined, id(777)]);
  });

  it('marks a members-only Skill locked for a plan below it and open for a plan that has it', async () => {
    const modules = [moduleRow(1, { required_member_level: 'gold' }), moduleRow(2)];
    const h = harness({});
    const list = (tier: { level: string } | null) => listChoiceSkills({ userClient: h.userClient, privateClient: null, visible: visibleOf(modules),
      modules, runnable: all, listed: all, tier, ...h.seams });
    expect((await list({ level: 'free' })).map(skill => [skill.requiredMemberLevel, skill.locked])).toEqual([['gold', true], [null, false]]);
    expect((await list({ level: 'gold' })).map(skill => skill.locked)).toEqual([false, false]);
    // A plan that could not be read locks nothing (the real gate is the chat catalog's own check).
    expect((await list(null)).map(skill => skill.locked)).toEqual([false, false]);
  });
});
