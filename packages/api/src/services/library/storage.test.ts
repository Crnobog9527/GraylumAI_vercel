/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
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
  bucket.createSignedUrl.mockResolvedValue({data:{signedUrl:'https://storage.test/object/sign/library-documents/original?token=secret'}});
  bucket.createSignedUploadUrl.mockResolvedValue({data:{signedUrl:'upload',token:'secret'}});
  await store.signRead(path,'原文件.png'); await store.signRead(path,false); await store.signUpload(path);
  expect(from).toHaveBeenCalledWith('library-documents');
  expect(bucket.createSignedUrl.mock.calls).toEqual([[path,60],[path,60]]);
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
  await expect(store.signRead('https://example.test','file.txt')).rejects.toThrow();
  await expect(store.remove('../outside')).rejects.toThrow();
  expect(bucket.remove).not.toHaveBeenCalled();expect(bucket.createSignedUrl).not.toHaveBeenCalled();
 });
});

 it.each([
  '中文报告 2026.pdf', 'notes &token=attacker#fragment?.txt', '100%+完成;"quoted".docx',
  'literal%0d%0aX-Header%3Ayes.txt', '<img src=x onerror=alert(1)>.txt',
 ])('keeps %s as one literal filename without changing the token or fragment', async filename => {
  const {store,bucket}=setup();
  bucket.createSignedUrl.mockResolvedValue({data:{signedUrl:'https://storage.test/original?token=signed%2Bvalue'}});
  const url=new URL(await store.signRead(path,filename));
  expect([...url.searchParams]).toEqual([['token','signed+value'],['download',filename]]);
  expect(url.hash).toBe('');
  expect(url.pathname).toBe('/original');
 });
 it('neutralizes header controls and path separators in stored filenames',async()=>{
  const {store,bucket}=setup();
  bucket.createSignedUrl.mockResolvedValue({data:{signedUrl:'https://storage.test/original?token=signed'}});
  const url=new URL(await store.signRead(path,'../evil\\name\r\nX-Test:yes\0.txt'));
  expect(url.searchParams.get('download')).toBe('.._evil_name__X-Test:yes_.txt');
 });
 it('keeps previews inline and uses a safe fallback for an empty legacy name',async()=>{
  const {store,bucket}=setup();
  const signed='https://storage.test/original?token=signed';
  bucket.createSignedUrl.mockResolvedValue({data:{signedUrl:signed}});
  expect(await store.signRead(path,false)).toBe(signed);
  expect(new URL(await store.signRead(path,'')).searchParams.get('download')).toBe('download');
 });

it('encodes the download name exactly once through the real Storage SDK',async()=>{
 const fetch=vi.fn<typeof globalThis.fetch>(async()=>new Response(JSON.stringify({
  signedURL:'/object/sign/library-documents/'+path+'?token=signed.jwt.token',
 }),{headers:{'Content-Type':'application/json'}}));
 const client=createClient('https://storage.test','test-only-key',{
  global:{fetch},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
 });
 const filename='中文 100% + &token=evil#片段;".pdf';
 const url=new URL(await libraryStorage(client).signRead(path,filename));
 expect([...url.searchParams]).toEqual([['token','signed.jwt.token'],['download',filename]]);
 expect(url.hash).toBe('');
 expect(fetch).toHaveBeenCalledTimes(1);
 expect(String(fetch.mock.calls[0][0])).toBe('https://storage.test/storage/v1/object/sign/library-documents/'+path);
 expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({expiresIn:60});
});
