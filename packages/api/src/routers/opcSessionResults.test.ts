/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {inferRouterContext} from '@trpc/server';
import {opcRouter} from './opc';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
beforeEach(() => vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321'));
afterEach(() => vi.unstubAllEnvs());
function fixture(result: {data?: unknown; error?: {code: string; message: string}}) {
  const profile = {id:id(9), nickname:'Test', email:'fixture@example.test', role:'user',
    status:'active', is_deleted:'false', membership_level:'free'};
  const user = {id:profile.id, email:profile.email, email_confirmed_at:'2026-01-01'};
  const rpc = vi.fn(async () => ({data:result.data ?? null, error:result.error ?? null}));
  const db = {rpc, auth:{getUser:async () => ({data:{user},error:null})},
    from:() => ({select() {return this;}, eq() {return this;}, single:async () => ({data:profile,error:null})})};
  const ctx = {headers:new Headers(), user, isEmailVerified:true, hasSupabaseAdminPrivileges:true,
    supabase:db, supabasePublic:db, supabaseAdmin:db} as unknown as inferRouterContext<typeof opcRouter>;
  return {caller:opcRouter.createCaller(ctx), rpc};
}
const item = {id:id(3), familyId:id(3), version:1, versions:1, resultType:'script', title:'早起口播稿', body:'今天早起……',
  sourceExecutionId:id(2), sourceAvailable:true, createdAt:'2026-10-23T00:00:00Z'};

it('saves a reply excerpt for the session owner: the actor comes from the session, not the input', async () => {
  const f = fixture({data:item});
  await expect(f.caller.sessionResultSave({sessionId:id(1), executionId:id(2), requestId:id(4), resultType:'script',
    title:null, excerpt:'今天早起'})).resolves.toEqual(item);
  expect(f.rpc).toHaveBeenCalledExactlyOnceWith('runtime_session_result_save', {p_actor_id:id(9), p_session_id:id(1),
    p_execution_id:id(2), p_request_id:id(4), p_result_type:'script', p_title:null, p_excerpt:'今天早起'});
});
it('lists, edits, reads versions and deletes through the owner-checked functions', async () => {
  let f = fixture({data:[item]});
  await expect(f.caller.sessionResults({sessionId:id(1)})).resolves.toEqual([item]);
  expect(f.rpc).toHaveBeenCalledWith('runtime_session_results_list', {p_actor_id:id(9), p_session_id:id(1)});
  f = fixture({data:{...item, id:id(5), version:2, versions:2, sourceExecutionId:null}});
  await f.caller.sessionResultEdit({familyId:id(3), requestId:id(6), expectedVersion:1, title:'改过', body:'新稿'});
  expect(f.rpc).toHaveBeenCalledWith('runtime_session_result_edit', {p_actor_id:id(9), p_family_id:id(3),
    p_request_id:id(6), p_expected_version:1, p_title:'改过', p_body:'新稿'});
  f = fixture({data:[item]});
  await f.caller.sessionResultVersions({familyId:id(3)});
  expect(f.rpc).toHaveBeenCalledWith('runtime_session_result_versions', {p_actor_id:id(9), p_family_id:id(3)});
  f = fixture({data:{familyId:id(3), deleted:2}});
  await expect(f.caller.sessionResultDelete({familyId:id(3)})).resolves.toEqual({familyId:id(3), deleted:2});
});
it.each([
  ['SESSION_RESULT_NOT_FOUND', 'OPC_RESULT_NOT_FOUND'],
  ['CONTENT_ERASED', 'OPC_CONVERSATION_ERASED'],
  ['SESSION_RESULT_SOURCE', 'OPC_RESULT_SOURCE'],
  ['SESSION_RESULT_INVALID', 'OPC_RESULT_INVALID'],
  ['SESSION_RESULT_VERSION_CONFLICT', 'OPC_VERSION_CONFLICT'],
  ['SESSION_RESULT_LIMIT', 'OPC_RESULT_LIMIT'],
])('denies a save with a bounded code when SQL refuses %s', async (sql, code) => {
  const f = fixture({error:{code:'42501', message:sql}});
  await expect(f.caller.sessionResultSave({sessionId:id(1), executionId:id(2), requestId:id(4), resultType:'copy'}))
    .rejects.toThrow(code);
});
it('reads no folder (null) for a conversation that is not an ordinary free one, never a server error', async () => {
  const f = fixture({error:{code:'42501', message:'SESSION_RESULT_NOT_FOUND'}});
  await expect(f.caller.sessionResults({sessionId:id(1)})).resolves.toBeNull();
  // Other refusals and failures are unchanged.
  await expect(fixture({error:{code:'42501', message:'CONTENT_ERASED'}}).caller.sessionResults({sessionId:id(1)}))
    .rejects.toThrow('OPC_CONVERSATION_ERASED');
  await expect(fixture({error:{code:'XX000', message:'boom'}}).caller.sessionResults({sessionId:id(1)})).rejects.toThrow();
});
it.each([['versions','sessionResultVersions',{familyId:id(3)}]] as const)(
  'keeps the bounded not-found refusal on the read route (%s) instead of a generic server error', async (_name, route, input) => {
  const f = fixture({error:{code:'42501', message:'SESSION_RESULT_NOT_FOUND'}});
  await expect((f.caller[route] as (value: unknown) => Promise<unknown>)(input)).rejects.toThrow('OPC_RESULT_NOT_FOUND');
});
it('rejects an actor in the input, an unknown type and over-long text before the database', async () => {
  const f = fixture({});
  const base = {sessionId:id(1), executionId:id(2), requestId:id(4), resultType:'script' as const};
  await expect(f.caller.sessionResultSave({...base, actorId:id(8)} as never)).rejects.toThrow();
  await expect(f.caller.sessionResultSave({...base, resultType:'minutes'} as never)).rejects.toThrow();
  await expect(f.caller.sessionResultSave({...base, excerpt:'x'.repeat(20001)})).rejects.toThrow();
  await expect(f.caller.sessionResultEdit({familyId:id(3), requestId:id(6), expectedVersion:1, title:null, body:''}))
    .rejects.toThrow();
  expect(f.rpc).not.toHaveBeenCalled();
});
it('keeps unexpected database text private', async () => {
  const f = fixture({error:{code:'XX000', message:'private detail'}});
  await expect(f.caller.sessionResultDelete({familyId:id(3)})).rejects.not.toThrow('private detail');
});
