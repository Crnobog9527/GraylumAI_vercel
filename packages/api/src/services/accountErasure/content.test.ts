/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe,it,expect,vi} from 'vitest';
import {contentConfirmation,contentVisibilityFence,previewContentErasure,confirmContentErasure} from './content';
const id='00000000-0000-4000-8000-000000000001';
const actor='00000000-0000-4000-8000-000000000002';
const hash='a'.repeat(64);
describe('content erasure API boundary',()=>{
 it('binds the authenticated actor and exact preview identity',async()=>{
  const result={kind:'answer',id,alreadyDeleted:false,affectedExecutions:1,affectedSources:[],preservedSavedVersions:0,previewHash:hash};
  const database={rpc:vi.fn().mockResolvedValue({data:result,error:null})};
  expect(await previewContentErasure(database,actor,{kind:'answer',id})).toEqual(result);
  expect(database.rpc).toHaveBeenCalledWith('content_erasure_preview',{a:actor,k:'answer',target:id});
  database.rpc.mockResolvedValue({data:{...result,id:actor},error:null});
  await expect(previewContentErasure(database,actor,{kind:'answer',id})).rejects.toMatchObject({code:'SERVICE_UNAVAILABLE'});
 });
 it('requires explicit impact acknowledgement and does not accept caller ownership',()=>{
  const input={kind:'session',id,previewHash:hash,acknowledged:true};
  expect(contentConfirmation.safeParse(input).success).toBe(true);
  for(const bad of [{...input,acknowledged:false},{...input,actorId:actor},{...input,previewHash:'old'}])
   expect(contentConfirmation.safeParse(bad).success).toBe(false);
 });
 it.each([
  ['CONTENT_NOT_FOUND','NOT_FOUND'],['CONTENT_ERASED','PRECONDITION_FAILED'],
  ['CONTENT_ERASURE_PREVIEW_CHANGED','CONFLICT'],['CONTENT_ERASURE_BUSY','CONFLICT'],
 ])('maps %s without exposing database details',async(message,code)=>{
  const db={rpc:vi.fn().mockResolvedValue({data:null,error:{message}})};
  await expect(confirmContentErasure(db,actor,{kind:'answer',id,previewHash:hash,acknowledged:true}))
   .rejects.toMatchObject({code,message});
 });
 it('fails closed on private errors and rechecks visibility every time',async()=>{
  const db={rpc:vi.fn().mockResolvedValue({data:true,error:null})};
  const visible=contentVisibilityFence(db,actor,id);await visible();
  db.rpc.mockResolvedValue({data:null,error:{message:'CONTENT_ERASED',code:'42501'}});
  await expect(visible()).rejects.toMatchObject({message:'CONTENT_ERASED'});
  db.rpc.mockResolvedValue({data:null,error:{message:'PRIVATE_DATABASE_BODY'}});
  await expect(visible()).rejects.toMatchObject({message:'CONTENT_ERASURE_UNAVAILABLE',cause:undefined});
  expect(db.rpc).toHaveBeenCalledTimes(3);
 });
});
