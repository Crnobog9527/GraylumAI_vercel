/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { libraryService } from './service';
import { cleanupLibrary, cleanupOrphanPage } from './cleanup';
import type { LibraryStorage } from './storage';
vi.mock('../../middleware/securityChecks',()=>({checkRateLimitAsync:vi.fn()}));
const a='11111111-1111-4111-8111-111111111111';
const id='22222222-2222-4222-8222-222222222222';
const path=`${a}/${id}/original`;
let deleted=false;
let rpc: ReturnType<typeof vi.fn>;
let client: SupabaseClient;
let storage: LibraryStorage;
const row={actor_id:a,document_id:id,original_path:path,text_path:null,status:'deleting',closed:false,
  cleanup:true,original_guard_until:new Date(Date.now()+3600000).toISOString(),text_guard_until:null};
beforeEach(()=>{
  deleted=false;
  rpc=vi.fn(async(name:string)=>{
    if(name==='library_document_read') return deleted ? {error:{message:'LIBRARY_NOT_FOUND'}}
      : {data:{id,kind:'image',format:'png',path,status:'uploading'}};
    if(name==='library_delete') {deleted=true;return {data:{status:'deleting'}};}
    if(name==='library_cleanup_candidates') return {data:[row]};
    if(name==='library_cleanup_backlog') return {data:{pending:1,overdue:0,oldestDeletedAt:null}};
    if(name==='library_publish') return {data:{status:'ready'}};
    return {data:false};
  });
  client={rpc} as unknown as SupabaseClient;
  storage={signUpload:vi.fn(),signRead:vi.fn(async()=>'signed-private-url'),inspect:vi.fn(),scan:vi.fn(),
    absent:vi.fn(async()=>true),remove:vi.fn()} as unknown as LibraryStorage;
});
describe('library service boundaries',()=>{
  it('publishes image without any content transformation or model call',async()=>{
    vi.mocked(storage.inspect).mockResolvedValue({size:8,contentType:'image/png',bytes:Buffer.from([137,80,78,71,13,10,26,10])});
    await libraryService(client,a,storage).complete(id);
    expect(storage.inspect).toHaveBeenCalledWith(path,false);
    expect(rpc).toHaveBeenCalledWith('library_publish',{a,did:id,actual:8,segments:[]});
  });
  it('forged type clears content before deleting storage and never publishes',async()=>{
    vi.mocked(storage.inspect).mockResolvedValue({size:7,contentType:'image/png',bytes:Buffer.from('<html/>')});
    await expect(libraryService(client,a,storage).complete(id)).rejects.toThrow('LIBRARY_TYPE');
    expect(deleted).toBe(true); expect(rpc.mock.calls.some(c=>c[0]==='library_publish')).toBe(false);
    expect(rpc).toHaveBeenCalledWith('library_cleanup_candidates',{a,n:1,did:id});
  });
  it('denies a signed link after concurrent deletion',async()=>{
    vi.mocked(storage.signRead).mockImplementation(async()=>{deleted=true;return 'must-not-escape';});
    await expect(libraryService(client,a,storage).signedUrl(id,true)).rejects.toThrow('LIBRARY_NOT_FOUND');
  });
  it('never treats uncertain absence/removal as release proof',async()=>{
    vi.mocked(storage.absent).mockResolvedValue(false);
    vi.mocked(storage.remove).mockRejectedValue(new Error('timeout'));
    const result=await cleanupLibrary(client,{actorId:a,storage});
    expect(result.failed).toBe(1);
    expect(rpc.mock.calls.some(c=>c[0]==='library_cleanup_observe')).toBe(false);
    expect(rpc).toHaveBeenCalledWith('library_cleanup_touch',{a,did:id});
  });
  it('observes before attempting retry and after removal',async()=>{
    vi.mocked(storage.absent).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await cleanupLibrary(client,{actorId:a,storage});
    expect(storage.remove).toHaveBeenCalledWith(path);
    expect(storage.absent).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith('library_cleanup_observe',{a,did:id,absent:true});
  });
  it('duplicate request cannot mint another upload token',async()=>{
    rpc.mockImplementation(async(name:string)=>({data:name==='library_cleanup_candidates'?[]:
      {documentId:id,status:'uploading',dispatch:false}}));
    const result=await libraryService(client,a,storage).begin({requestId:id,filename:'a.png',contentType:'image/png',bytes:8,purpose:'reference'});
    expect(result.upload).toBeNull(); expect(storage.signUpload).not.toHaveBeenCalled();
  });
});

it('advances a full claimed page with one ownership RPC even when the time budget is exhausted',async()=>{
  const paths=Array.from({length:100},(_,i)=>`${a}/22222222-2222-4222-8222-${String(i).padStart(12,'0')}/original`);
  rpc.mockResolvedValue({data:paths});
  const result=await cleanupOrphanPage(client,storage,{paths,cursor:'next-page'},Date.now()-46000);
  expect(result.complete).toBe(true);
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith('library_paths_claimed',{paths});
  expect(storage.remove).not.toHaveBeenCalled();
});

it('reaches an orphan behind retained objects without 99 sequential ownership calls',async()=>{
  const paths=Array.from({length:100},(_,i)=>`${a}/22222222-2222-4222-8222-${String(i).padStart(12,'0')}/original`);
  rpc.mockResolvedValue({data:paths.slice(0,99)});
  vi.mocked(storage.absent).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const result=await cleanupOrphanPage(client,storage,{paths,cursor:'next-page'},Date.now()-40000);
  expect(result).toMatchObject({complete:true,orphans:1});
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(storage.remove).toHaveBeenCalledWith(paths[99]);
});

it('does not remove storage when an expired snapshot has already published successfully',async()=>{
  rpc.mockImplementation(async(name:string)=>{
    if(name==='library_cleanup_candidates') return {data:[{...row,status:'uploading',cleanup:false,
      original_guard_until:new Date(Date.now()-1000).toISOString()}]};
    if(name==='library_delete') return {data:{status:'ready'}};
    if(name==='library_cleanup_backlog') return {data:{pending:0,overdue:0,oldestDeletedAt:null}};
    return {data:false};
  });
  await cleanupLibrary(client,{actorId:a,storage});
  expect(rpc).toHaveBeenCalledWith('library_delete',{a,did:id,closed:true,unfinished_only:true,expiry_only:true});
  expect(storage.remove).not.toHaveBeenCalled();
  expect(storage.absent).not.toHaveBeenCalled();
});
it('only explicit erasure candidates use unconditional deletion',async()=>{
  rpc.mockImplementation(async(name:string)=>{
    if(name==='library_cleanup_candidates') return {data:[{...row,status:'ready',closed:true,cleanup:false}]};
    if(name==='library_delete') return {data:{status:'deleting'}};
    if(name==='library_cleanup_backlog') return {data:{pending:1,overdue:0,oldestDeletedAt:null}};
    return {data:false};
  });
  await cleanupLibrary(client,{actorId:a,storage});
  expect(rpc).toHaveBeenCalledWith('library_delete',{a,did:id,closed:true,unfinished_only:false,expiry_only:false});
});
