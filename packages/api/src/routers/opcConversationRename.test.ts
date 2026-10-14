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
it('allows the owner to rename: the actor comes from the session, not the input', async () => {
  const f = fixture({data:{sessionId:id(1), name:'周末选题'}});
  await expect(f.caller.conversationRename({sessionId:id(1), name:' 周末选题 '})).resolves.toEqual({sessionId:id(1), name:'周末选题'});
  expect(f.rpc).toHaveBeenCalledExactlyOnceWith('opc_conversation_rename', {p_actor_id:id(9), p_session_id:id(1), p_name:' 周末选题 '});
});
it.each([
  ['CONVERSATION_NOT_FOUND', 'OPC_CONVERSATION_NOT_FOUND'],
  ['CONTENT_ERASED', 'OPC_CONVERSATION_ERASED'],
  ['CONVERSATION_NAME_INVALID', 'OPC_CONVERSATION_NAME_INVALID'],
])('denies with a bounded code when SQL refuses %s', async (sql, code) => {
  const f = fixture({error:{code:'42501', message:sql}});
  await expect(f.caller.conversationRename({sessionId:id(1), name:'x'})).rejects.toThrow(code);
});
it('rejects extra fields, a non-uuid id and an over-long name before the database', async () => {
  const f = fixture({});
  await expect(f.caller.conversationRename({sessionId:id(1), name:'x', actorId:id(2)} as never)).rejects.toThrow();
  await expect(f.caller.conversationRename({sessionId:'nope', name:'x'})).rejects.toThrow();
  await expect(f.caller.conversationRename({sessionId:id(1), name:'x'.repeat(201)})).rejects.toThrow();
  expect(f.rpc).not.toHaveBeenCalled();
});
it('keeps unexpected database text private', async () => {
  const f = fixture({error:{code:'XX000', message:'private detail'}});
  await expect(f.caller.conversationRename({sessionId:id(1), name:'x'})).rejects.not.toThrow('private detail');
});
