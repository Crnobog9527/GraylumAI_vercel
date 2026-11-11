/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { opcService } from './service';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(9);
type Answer = { data: unknown; error: { code?: string; message: string } | null };

/** Clients as the router hands them over: the session client (asked who is signed in) and the service-role client. */
function clients(answers: (name: string, args: Record<string, unknown>) => unknown,
  session: { id: string; email_confirmed_at?: string | null } | null = { id: ACTOR, email_confirmed_at: '2026-01-01' }) {
  const getUser = vi.fn(async () => ({ data: { user: session }, error: null }));
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    const answer: Answer = { data: answers(name, args), error: null };
    return Object.assign(Promise.resolve(answer), { abortSignal: () => Promise.resolve(answer) });
  });
  const visible = { data: [{ id: id(20), active: true }], error: null };
  const user = { auth: { getUser }, from: () => ({ select() { return this; }, in() { return this; }, eq: async () => visible }) };
  return { user: user as never, admin: { rpc } as never, getUser, calls };
}

const draft = {
  draftId: id(1), projectId: id(2), roundId: id(3), sessionId: id(4),
  snapshot: { projectId: id(2), roundId: id(3), state: 'draft', workflow: { id: 'w', version: 1, steps: [] }, steps: {} },
  information: {}, turns: [],
};
const frozen = { moduleId: id(20), workflow: { reportGeneration: { resources: ['SKILL.md'], sections: ['一'], maxCharacters: 9000 } } };
const readAnswers = (name: string) => name === 'opc_query' ? draft : name === 'artifact_query' ? frozen : null;

describe('opcService with the account the procedure already verified', () => {
  it('reads a draft with two queries and never asks the session again', async () => {
    const c = clients(readAnswers);
    const result = await opcService(c.user, c.admin, undefined, ACTOR).read(id(1));

    expect(result).toMatchObject({ draftId: id(1), moduleId: id(20), runtimeMode: 'isolated' });
    expect((result as { snapshot: { workflow: { reportGeneration: unknown } } }).snapshot.workflow.reportGeneration).toBe(true);
    // The frozen round is looked up once and serves both the report flag and the module.
    expect(c.calls).toEqual([
      { name: 'opc_query', args: { p_draft_id: id(1), p_actor_id: ACTOR } },
      { name: 'artifact_query', args: { p_action: 'resolve', p_project_id: id(2), p_round_id: id(3), p_actor_id: ACTOR } },
    ]);
    expect(c.getUser).not.toHaveBeenCalled();
    // Only the flag leaves the server, never the report manifest.
    expect(JSON.stringify(result)).not.toMatch(/SKILL\.md|maxCharacters/);
  });

  it('runs every query as that account, whatever the session client would answer', async () => {
    const c = clients(() => ({ drafts: [] }), { id: id(77), email_confirmed_at: '2026-01-01' });
    const service = opcService(c.user, c.admin, undefined, ACTOR);
    await service.list();
    await service.topicDraftRead(id(1));
    expect(c.calls.map(call => call.args.p_actor_id)).toEqual([ACTOR, ACTOR]);
    expect(c.getUser).not.toHaveBeenCalled();
  });

  it('reads the positioning catalog with one catalog query and applies the positioning rule to its rows', async () => {
    const step = (profileKey?: string) => ({ id: 's', title: '目标', dependsOn: [], resources: ['SKILL.md'], minLength: 1, maxLength: 200,
      information: [{ id: 'f', title: '领域', required: true, ...(profileKey ? { profileKey } : {}) }], requiresEvidence: false, requiredCapabilities: [] });
    const registration = (n: number, profileKey?: string) => ({
      id: id(n), label: `r${n}`, moduleId: id(20), skillId: id(21), revisionId: id(22), packageHash: 'h', accounts: [],
      workflow: { id: 'w', version: 1, kind: 'social', steps: [step(profileKey)],
        report: { id: 'r', version: 1, title: '报告', sections: [{ title: '一', stepId: 's' }] } },
    });
    const rows = [registration(30, 'niche'), registration(31)];
    const c = clients(name => name === 'artifact_query' ? rows : null);
    const catalog = await opcService(c.user, c.admin, undefined, ACTOR).catalog();
    // Only the workflow that feeds the positioning profile is offered.
    expect(catalog.map(item => item.id)).toEqual([id(30)]);
    expect(c.calls.filter(call => call.name === 'artifact_query')).toEqual([
      { name: 'artifact_query', args: { p_actor_id: ACTOR, p_action: 'catalog', p_project_id: null, p_round_id: null } },
    ]);
    expect(c.getUser).not.toHaveBeenCalled();
  });
});

describe('opcService built from the clients alone (scripts, tests)', () => {
  it('verifies the session before each query and runs as the signed-in account', async () => {
    const c = clients(readAnswers);
    const result = await opcService(c.user, c.admin).read(id(1));
    expect(result).toMatchObject({ moduleId: id(20) });
    expect(c.getUser).toHaveBeenCalledTimes(2);
    expect(c.calls.map(call => call.args.p_actor_id)).toEqual([ACTOR, ACTOR]);
  });

  it.each([
    ['nobody is signed in', null],
    ['the email is not verified', { id: ACTOR, email_confirmed_at: null }],
  ])('refuses before any query when %s', async (_name, session) => {
    const c = clients(readAnswers, session);
    await expect(opcService(c.user, c.admin).read(id(1))).rejects.toThrow('OPC_AUTH_REQUIRED');
    await expect(opcService(c.user, c.admin).list()).rejects.toThrow('OPC_AUTH_REQUIRED');
    expect(c.calls).toEqual([]);
  });
});
