/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {inferRouterContext} from '@trpc/server';
import {opcRouter} from './opc';

// The procedure has verified who is signed in (login and verified email) before the service runs. The service is handed that
// account and must not ask the session again: one draft read used to verify the same session three more times.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
beforeEach(() => vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321'));
afterEach(() => vi.unstubAllEnvs());

type Answer = {data: unknown; error: {code: string; message: string} | null};
function fixture(answers: (name: string, args: Record<string, unknown>) => unknown, verified = true) {
  const profile = {id:id(9), nickname:'Test', email:'fixture@example.test', role:'user', status:'active', is_deleted:'false',
    membership_level:'free'};
  const user = {id:profile.id, email:profile.email, email_confirmed_at:verified ? '2026-01-01' : null};
  const calls: Array<{name: string; args: Record<string, unknown>}> = [];
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    calls.push({name, args});
    const answer: Answer = {data:answers(name, args), error:null};
    return Object.assign(Promise.resolve(answer), {abortSignal:() => Promise.resolve(answer)});
  });
  const getUser = vi.fn(async () => ({data:{user}, error:null}));
  const db = {rpc, auth:{getUser}, from:() => ({select() {return this;}, eq() {return this;}, single:async () => ({data:profile, error:null})})};
  const ctx = {headers:new Headers(), user, isEmailVerified:verified, hasSupabaseAdminPrivileges:true,
    supabase:db, supabasePublic:db, supabaseAdmin:db} as unknown as inferRouterContext<typeof opcRouter>;
  return {caller:opcRouter.createCaller(ctx), calls, getUser};
}
const draft = {draftId:id(1), projectId:id(2), roundId:id(3), sessionId:id(4),
  snapshot:{projectId:id(2), roundId:id(3), state:'draft', workflow:{id:'w', version:1, steps:[]}, steps:{}}, information:{}, turns:[]};

it('reads a draft as the signed-in account with two queries and no further session check', async () => {
  const f = fixture(name => name === 'opc_query' ? draft : name === 'artifact_query' ? {moduleId:id(20), workflow:{}} : null);
  await expect(f.caller.read({draftId:id(1)})).resolves.toMatchObject({draftId:id(1), moduleId:id(20)});
  expect(f.calls).toEqual([
    {name:'opc_query', args:{p_draft_id:id(1), p_actor_id:id(9)}},
    {name:'artifact_query', args:{p_action:'resolve', p_project_id:id(2), p_round_id:id(3), p_actor_id:id(9)}},
  ]);
  expect(f.getUser).not.toHaveBeenCalled();
});

it('lists as the signed-in account without a session check', async () => {
  const f = fixture(() => ({drafts:[]}));
  await f.caller.list();
  expect(f.calls.map(call => call.args.p_actor_id)).toEqual([id(9)]);
  expect(f.getUser).not.toHaveBeenCalled();
});

it('still refuses an account whose email is not verified, before any query', async () => {
  const f = fixture(() => draft, false);
  await expect(f.caller.read({draftId:id(1)})).rejects.toMatchObject({code:'FORBIDDEN', message:'EMAIL_NOT_VERIFIED'});
  await expect(f.caller.list()).rejects.toMatchObject({code:'FORBIDDEN'});
  expect(f.calls).toEqual([]);
});
