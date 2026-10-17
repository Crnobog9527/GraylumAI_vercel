/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { RateLimitError } from '../lib/rateLimitError';
const mocked = vi.hoisted(() => ({ read: vi.fn(), start: vi.fn(), execute: vi.fn(), isLegacyProject: vi.fn() }));
vi.mock('../services/artifacts/workbench', async importOriginal => ({
  ...await importOriginal<typeof import('../services/artifacts/workbench')>(),
  workbenchService: () => mocked,
}));
import { legacyReadOnlyMessage, workbenchRouter } from './workbench';
const id='00000000-0000-4000-8000-000000000001';
function caller() {
  const query={select(){return this;},eq(){return this;},single:async()=>({data:{id,role:'user',status:'active',nickname:'Fictional',email:'fixture@example.test',credits:100,created_at:'2020-01-01'},error:null})};
  const client={from:()=>query};
  return workbenchRouter.createCaller({user:{id,email:'fixture@example.test'},isEmailVerified:true,supabase:client,supabaseAuth:client,supabaseAdmin:client,hasSupabaseAdminPrivileges:true} as never);
}
const input={projectId:id,roundId:id};
describe('workbench preflight error transport',()=>{
  it.each(['TOO_MANY_REQUESTS','PRECONDITION_FAILED','FORBIDDEN','BAD_REQUEST'] as const)('preserves %s and its safe business message',async code=>{
    mocked.read.mockRejectedValueOnce(new TRPCError({code,message:'Safe actionable preflight message'}));
    await expect(caller().read(input)).rejects.toMatchObject({code,message:'Safe actionable preflight message'});
  });
  it('still sanitizes unexpected implementation details',async()=>{
    mocked.read.mockRejectedValueOnce(new Error('private internal diagnostic'));
    await expect(caller().read(input)).rejects.toMatchObject({code:'SERVICE_UNAVAILABLE',message:'工作台服务未配置或暂时不可用，请稍后重试。'});
  });
});

it('preserves a rate-limit backend failure and retry hint', async () => {
  const error = new RateLimitError('unavailable', 60);
  mocked.read.mockRejectedValueOnce(error);
  await expect(caller().read(input)).rejects.toBe(error);
});

describe('LEGACY-CLOSE: old workbench projects are read-only on the server', () => {
  const save = { action: 'save' as const, projectId: id, roundId: id, requestId: id, stepId: 'step', expectedVersion: 0,
    body: 'edit', evidenceIds: [] };
  const refused = { code: 'FORBIDDEN', message: legacyReadOnlyMessage };
  it('refuses every workbench.start before the service writes anything', async () => {
    mocked.start.mockReset();
    await expect(caller().start({ projectId: id, roundId: id, requestId: id, registration: 'r' })).rejects.toMatchObject(refused);
    expect(mocked.start).not.toHaveBeenCalled();
  });
  it('refuses execute on an old workbench project and never reaches the write', async () => {
    mocked.execute.mockReset(); mocked.isLegacyProject.mockReset().mockResolvedValueOnce(true);
    await expect(caller().execute(save)).rejects.toMatchObject(refused);
    expect(mocked.isLegacyProject).toHaveBeenCalledWith(id);
    expect(mocked.execute).not.toHaveBeenCalled();
  });
  it('lets a positioning draft project write as before', async () => {
    mocked.execute.mockReset().mockResolvedValueOnce({ accepted: true });
    mocked.isLegacyProject.mockReset().mockResolvedValueOnce(false);
    await expect(caller().execute(save)).resolves.toEqual({ accepted: true });
    expect(mocked.execute).toHaveBeenCalledWith(save);
  });
  it('fails closed when the project kind cannot be read', async () => {
    mocked.execute.mockReset(); mocked.isLegacyProject.mockReset().mockRejectedValueOnce(new Error('ARTIFACT_UNAVAILABLE'));
    await expect(caller().execute(save)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(mocked.execute).not.toHaveBeenCalled();
  });
  it('keeps read open for old projects', async () => {
    mocked.read.mockReset().mockResolvedValueOnce({ state: 'published' });
    await expect(caller().read(input)).resolves.toEqual({ state: 'published' });
  });
});
