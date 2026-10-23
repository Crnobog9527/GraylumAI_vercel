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
  const answer = {data:result.data ?? null, error:result.error ?? null};
  type Answer = {data: unknown; error: {code: string; message: string} | null};
  const rpc = vi.fn((_name?: string, _args?: Record<string, unknown>) =>
    Object.assign(Promise.resolve<Answer>(answer), {abortSignal:() => Promise.resolve<Answer>(answer)}));
  const db = {rpc, auth:{getUser:async () => ({data:{user},error:null})},
    from:() => ({select() {return this;}, eq() {return this;}, single:async () => ({data:profile,error:null})})};
  const ctx = {headers:new Headers(), user, isEmailVerified:true, hasSupabaseAdminPrivileges:true,
    supabase:db, supabasePublic:db, supabaseAdmin:db} as unknown as inferRouterContext<typeof opcRouter>;
  return {caller:opcRouter.createCaller(ctx), rpc};
}
const draft = (confirmed: boolean) => ({conversationDeleted:true, draftId:id(1), projectId:id(2), roundId:id(3), sessionId:id(4),
  snapshot:{state:'draft', workflow:{steps:[{id:'s1', title:'目标'}]}, steps:{s1:{version:1, reviewVersion:0, valid:false}}},
  information:{s1:{schema:[{id:'goal', title:'目标'}], values:confirmed ? {goal:{value:'已确认目标', status:'confirmed'}} : {}}}});
it('lets the owner read a deleted conversation that still has confirmed content', async () => {
  const f = fixture({data:draft(true)});
  await expect(f.caller.read({draftId:id(1)})).resolves.toMatchObject({conversationDeleted:true,
    information:{s1:{values:{goal:{value:'已确认目标'}}}}});
});
const listed = (f: ReturnType<typeof fixture>, rows: unknown[]) => f.rpc.mockImplementation((_name?: string, args?: Record<string, unknown>) => {
  const answer = {data:args?.p_draft_id ? draft(false) : rows, error:null};
  return Object.assign(Promise.resolve(answer), {abortSignal:() => Promise.resolve(answer)});
});
it('reads a deleted conversation with nothing confirmed as not found', async () => {
  const f = fixture({data:draft(false)});
  listed(f, []);
  await expect(f.caller.read({draftId:id(1)})).rejects.toMatchObject({code:'NOT_FOUND'});
});
it('keeps a deleted conversation that the sidebar list still holds for its published version', async () => {
  const f = fixture({data:draft(false)});
  listed(f, [{draftId:id(1)}]);
  await expect(f.caller.read({draftId:id(1)})).resolves.toMatchObject({conversationDeleted:true});
});
it.each(['read', 'topicWorkspace', 'topicDraft', 'positionHistory'] as const)(
  'answers another account\'s draft on %s with not found, not a server error', async (name) => {
    const f = fixture({error:{code:'P0001', message:'OPC_DENIED'}});
    const error = await f.caller[name]({draftId:id(1)}).catch((e: unknown) => e);
    expect(error).toMatchObject({code:'NOT_FOUND', message:'OPC_NOT_FOUND'});
    expect(JSON.stringify(error)).not.toMatch(/OPC_DENIED/);
  });
it('keeps a real server fault on a query as a server error', async () => {
  const f = fixture({error:{code:'XX000', message:'private detail'}});
  await expect(f.caller.read({draftId:id(1)})).rejects.toMatchObject({code:'INTERNAL_SERVER_ERROR'});
});
