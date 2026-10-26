/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import {beforeEach, expect, it, vi} from 'vitest';
import {eraseConversation} from './content';
const logs=vi.hoisted(()=>({error:vi.fn(),info:vi.fn()}));
vi.mock('../../lib/logger',()=>({logger:logs}));
vi.mock('./offdbManifest',()=>({scheduleErasureManifestSync:vi.fn()}));
const actor='00000000-0000-4000-8000-000000000001';
const sessionId='00000000-0000-4000-8000-000000000002';
beforeEach(()=>vi.clearAllMocks());
it.each([
 ['55P03','DATABASE_LOCKED'],['P0001','DATABASE_REJECTED'],
 ['08006','DATABASE_CONNECTION'],['XX000','DATABASE_ERROR'],
])('records the reason for database refusal %s without private error text',async(code,reasonCode)=>{
 const db={rpc:vi.fn().mockResolvedValue({data:null,error:{code,message:'PRIVATE_DATABASE_CONTENT'}})};
 await expect(eraseConversation(db,actor,{sessionId})).rejects.toMatchObject({code:'SERVICE_UNAVAILABLE'});
 expect(logs.error).toHaveBeenCalledWith('api','content_erasure_unavailable',expect.objectContaining({
  operation:'conversation_mark',reasonCode,sessionId,databaseCode:code,
 }));
 expect(JSON.stringify(logs.error.mock.calls)).not.toContain('PRIVATE_DATABASE_CONTENT');
});
it('logs unavailable database, mismatched result, and thrown transport failures',async()=>{
 await expect(eraseConversation(null,actor,{sessionId})).rejects.toMatchObject({code:'SERVICE_UNAVAILABLE'});
 expect(logs.error).toHaveBeenLastCalledWith('api','content_erasure_unavailable',expect.objectContaining({reasonCode:'DATABASE_UNCONFIGURED'}));
 const malformed={rpc:vi.fn().mockResolvedValue({data:{kind:'session',id:actor},error:null})};
 await expect(eraseConversation(malformed,actor,{sessionId})).rejects.toMatchObject({code:'SERVICE_UNAVAILABLE'});
 expect(logs.error).toHaveBeenLastCalledWith('api','content_erasure_unavailable',expect.objectContaining({reasonCode:'INVALID_RESPONSE'}));
 const transport={rpc:vi.fn().mockRejectedValue(new Error('PRIVATE transport token'))};
 await expect(eraseConversation(transport,actor,{sessionId})).rejects.toMatchObject({code:'SERVICE_UNAVAILABLE',cause:undefined});
 expect(logs.error).toHaveBeenLastCalledWith('api','content_erasure_unavailable',expect.objectContaining({reasonCode:'TRANSPORT_FAILURE'}));
 expect(JSON.stringify(logs.error.mock.calls)).not.toContain('PRIVATE transport token');
});
it('logs a busy rollback as busy and preserves the actionable refusal',async()=>{
 const db={rpc:vi.fn().mockResolvedValue({data:null,error:{code:'55P03',message:'CONTENT_ERASURE_BUSY'}})};
 await expect(eraseConversation(db,actor,{sessionId})).rejects.toMatchObject({code:'CONFLICT',message:'CONTENT_ERASURE_BUSY'});
 expect(logs.error).not.toHaveBeenCalled();
});

it('turns a confirmed SQL statement-timeout rollback into an actionable refusal, never an uncertain automatic retry',async()=>{
 const db={rpc:vi.fn().mockResolvedValue({data:null,error:{code:'57014',message:'canceling statement due to statement timeout'}})};
 await expect(eraseConversation(db,actor,{sessionId})).rejects.toMatchObject({code:'PRECONDITION_FAILED',message:'CONTENT_ERASURE_TIMEOUT'});
 expect(logs.error).toHaveBeenCalledWith('api','content_erasure_unavailable',expect.objectContaining({reasonCode:'DATABASE_TIMEOUT',databaseCode:'57014'}));
});
