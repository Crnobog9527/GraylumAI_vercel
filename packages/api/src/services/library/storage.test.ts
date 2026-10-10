/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { libraryStorage } from './storage';
const path='11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/original';
function setup() {
 const bucket={listV2:vi.fn(),info:vi.fn(),remove:vi.fn(),createSignedUrl:vi.fn(),createSignedUploadUrl:vi.fn()};
 const from=vi.fn(()=>bucket);
 return {bucket,from,store:libraryStorage({storage:{from}} as unknown as SupabaseClient)};
}
afterEach(()=>vi.unstubAllGlobals());
describe('private library Storage adapter',()=>{
 it('checks successful complete listing instead of interpreting an error as absence',async()=>{
  const {store,bucket}=setup();
  bucket.listV2.mockResolvedValue({error:{message:'not authorized'}});
  await expect(store.absent(path)).rejects.toThrow('LIBRARY_STORAGE_UNAVAILABLE');
  bucket.listV2.mockResolvedValue({data:{hasNext:false,nextCursor:null,folders:[],objects:[]}});
  expect(await store.absent(path)).toBe(true);
  bucket.listV2.mockResolvedValue({data:{hasNext:true,nextCursor:'next',folders:[],objects:[{id:'object',key:path}]}});
  await expect(store.absent(path)).rejects.toThrow('LIBRARY_STORAGE_UNAVAILABLE');
 });
 it('malformed provider identities cannot become absence proof',async()=>{
  const {store,bucket}=setup();
  bucket.listV2.mockResolvedValue({data:{hasNext:false,folders:[],objects:[{id:'object'}]}});
  await expect(store.absent(path)).rejects.toThrow('LIBRARY_STORAGE_UNAVAILABLE');
 });
 it('does not mistake an adjacent path for the exact object',async()=>{
  const {store,bucket}=setup();
  bucket.listV2.mockResolvedValue({data:{hasNext:false,folders:[],objects:[{id:'object',key:path+'-other'}]}});
  expect(await store.absent(path)).toBe(true);
 });
 it('uses the private bucket, no overwrite, sixty-second signatures and attachment downloads',async()=>{
  const {store,bucket,from}=setup();
  bucket.createSignedUrl.mockResolvedValue({data:{signedUrl:'secret'}});
  bucket.createSignedUploadUrl.mockResolvedValue({data:{signedUrl:'upload',token:'secret'}});
  await store.signRead(path,true); await store.signRead(path,false); await store.signUpload(path);
  expect(from).toHaveBeenCalledWith('library-documents');
  expect(bucket.createSignedUrl.mock.calls).toEqual([[path,60,{download:true}],[path,60,undefined]]);
  expect(bucket.createSignedUploadUrl).toHaveBeenCalledWith(path,{upsert:false});
 });
 it('does not read a file over the actual byte limit',async()=>{
  const {store,bucket}=setup();
  bucket.info.mockResolvedValue({data:{size:10_000_001,contentType:'image/png'}});
  await expect(store.inspect(path,false)).rejects.toThrow('LIBRARY_SIZE');
  expect(bucket.createSignedUrl).not.toHaveBeenCalled();
 });
 it('reads only image magic even when a server ignores Range; does not decode it',async()=>{
  const {store,bucket}=setup();
  bucket.info.mockResolvedValue({data:{size:1_000_000,contentType:'image/png'}});
  bucket.createSignedUrl.mockResolvedValue({data:{signedUrl:'https://storage.test/private'}});
  const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new Uint8Array(1_000_000)));
  vi.stubGlobal('fetch',fetch);
  const file=await store.inspect(path,false);
  expect(file.bytes.length).toBe(32);
  expect(fetch.mock.calls[0][1]).toMatchObject({headers:{Range:'bytes=0-31'},redirect:'error',cache:'no-store'});
 });
 it('refuses arbitrary URL/path before making a provider call',async()=>{
  const {store,bucket}=setup();
  await expect(store.signRead('https://example.test',true)).rejects.toThrow();
  await expect(store.remove('../outside')).rejects.toThrow();
  expect(bucket.remove).not.toHaveBeenCalled();expect(bucket.createSignedUrl).not.toHaveBeenCalled();
 });
});
