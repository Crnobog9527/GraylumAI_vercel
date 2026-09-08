/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
const mocked = vi.hoisted(() => ({ quote: vi.fn() }));
vi.mock('../services/artifacts/generation', async importOriginal => ({
  ...await importOriginal<typeof import('../services/artifacts/generation')>(),
  workbenchGeneration: () => ({ quote: mocked.quote }),
}));
import { workbenchRouter } from './workbench';
const id='00000000-0000-4000-8000-000000000001';
function caller() {
  const query={select(){return this;},eq(){return this;},single:async()=>({data:{id,role:'user',status:'active',nickname:'Fictional',email:'fixture@example.test',credits:100,created_at:'2020-01-01'},error:null})};
  const client={from:()=>query};
  return workbenchRouter.createCaller({user:{id,email:'fixture@example.test'},isEmailVerified:true,supabase:client,supabaseAuth:client,supabaseAdmin:client,hasSupabaseAdminPrivileges:true} as never);
}
const input={projectId:id,roundId:id,stepId:'step-0',instruction:'',expectedSteps:{'step-0':{version:0,reviewVersion:0}}};
describe('workbench preflight error transport',()=>{
  it.each(['TOO_MANY_REQUESTS','PRECONDITION_FAILED','FORBIDDEN','BAD_REQUEST'] as const)('preserves %s and its safe business message',async code=>{
    mocked.quote.mockRejectedValueOnce(new TRPCError({code,message:'Safe actionable preflight message'}));
    await expect(caller().generationQuote(input)).rejects.toMatchObject({code,message:'Safe actionable preflight message'});
  });
  it('still sanitizes unexpected implementation details',async()=>{
    mocked.quote.mockRejectedValueOnce(new Error('private internal diagnostic'));
    await expect(caller().generationQuote(input)).rejects.toMatchObject({code:'SERVICE_UNAVAILABLE',message:'工作台服务未配置或暂时不可用，请稍后重试。'});
  });
});
