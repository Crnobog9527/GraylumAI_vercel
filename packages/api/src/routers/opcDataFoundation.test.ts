/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {inferRouterContext} from '@trpc/server';
import {opcRouter} from './opc';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = {id:id(5), platform:'x', account:'main', title:'用户采用标题', brief:'摘要', day:'2026-10-11'};
const draft = {draftId:id(1), requestId:id(2), expectedVersion:0, sourceVersionId:id(3), body:[item]};
beforeEach(() => vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321'));
afterEach(() => vi.unstubAllEnvs());
function fixture(options: {authenticated?:boolean; verified?:boolean; status?:string; error?:string} = {}) {
  const profile = {id:id(9), nickname:'Test', email:'fixture@example.test', role:'user',
    status:options.status ?? 'active', is_deleted:'false', membership_level:'free'};
  const user = {id:profile.id, email:profile.email, email_confirmed_at:options.verified === false ? null : '2026-01-01'};
  const rpc = vi.fn((name:string, args:Record<string,unknown>) => ({abortSignal:async () => ({
    data: {name, actorId:args.p_actor_id, recorded:true},
    error:options.error ? {code:'P0001', message:options.error} : null,
  })}));
  const db = {rpc, auth:{getUser:async () => ({data:{user:options.authenticated === false ? null : user},error:null})},
    from:() => ({select() {return this;}, eq() {return this;}, single:async () => ({data:profile,error:null})})};
  const ctx = {headers:new Headers(), user:options.authenticated === false ? null : user,
    isEmailVerified:options.verified !== false, hasSupabaseAdminPrivileges:true,
    supabase:db, supabasePublic:db, supabaseAdmin:db} as unknown as inferRouterContext<typeof opcRouter>;
  return {caller:opcRouter.createCaller(ctx),rpc};
}
it('routes topic saves and adoption through authenticated source binding RPCs', async () => {
  const f = fixture();
  await f.caller.saveTopicDraft({...draft, executionId:id(4)});
  expect(f.rpc).toHaveBeenLastCalledWith('opc_topic_draft_from_execution', expect.objectContaining({
    p_actor_id:id(9), p_execution_id:id(4), p_body:[item],
  }));
  const sources = [{itemId:id(5), executionId:id(4)}];
  await f.caller.adoptTopics({...draft, sources, sourceDraftVersionId:id(7), accounts:[{platform:'x', account:'main', expectedRevision:null}]});
  expect(f.rpc).toHaveBeenLastCalledWith('opc_adopt_topics_with_source', expect.objectContaining({p_sources:sources,p_source_draft_version_id:id(7),p_actor_id:id(9)}));
});
it.each(['OPC_DATA_SOURCE_DENIED','OPC_TOPIC_SOURCE_INVALID','OPC_TOPIC_SOURCE_REQUIRED'])
('makes permanent topic source refusal actionable for existing clients: %s', async error => {
  const f = fixture({error});
  await expect(f.caller.saveTopicDraft({...draft,executionId:id(4)})).rejects.toMatchObject({message:'OPC_SOURCE_DENIED'});
  await expect(f.caller.adoptTopics({...draft,accounts:[{platform:'x',account:'main',expectedRevision:null}]}))
    .rejects.toMatchObject({message:'OPC_SOURCE_DENIED'});
});
