/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeAll, afterAll, it, expect, vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {confirmedPreferences} from '../agentSlice/preferences';

const url=process.env.V3_LOCAL_REST!;
if(!url?.startsWith('http://127.0.0.1:') || !process.env.V3_LOCAL_DB?.endsWith('/v3_disposable')) throw new Error('disposable local database required');
const sql=new pg.Client({connectionString:process.env.V3_LOCAL_DB});
const admin=createClient(url,process.env.V3_LOCAL_SERVICE_JWT!,{auth:{persistSession:false}});
const actor=randomUUID(), other=randomUUID(), moduleId=randomUUID(), skillId=randomUUID();
function service(id=actor) {
 const user=createClient(url,process.env.V3_LOCAL_USER_JWT!,{auth:{persistSession:false}});
 // This suite uses synthetic Auth; HTTP/RPC/SQL and role denial are real.
 vi.spyOn(user.auth,'getUser').mockResolvedValue({data:{user:{id,email_confirmed_at:'2026-01-01T00:00:00Z'}},error:null} as never);
 return confirmedPreferences(user,admin);
}
beforeAll(async()=>{
 await sql.connect();
 await sql.query("INSERT INTO profiles(id,email) VALUES($1,'slice-a@example.test'),($2,'slice-b@example.test')",[actor,other]);
 await sql.query('INSERT INTO skills(id,skill_key,created_by) VALUES($1,$2,$3)',[skillId,`slice-${skillId}`,actor]);
 await sql.query("INSERT INTO modules(id,title,skill_id,active) VALUES($1,'Synthetic slice', $2,true)",[moduleId,skillId]);
 await sql.query("INSERT INTO artifact_accounts VALUES($1,$2,$3,'synthetic:channel')",[actor,moduleId,skillId]);
});
afterAll(async()=>{await sql.end();});

it('confirms, replays, corrects and deletes without retaining old plaintext',async()=>{
 const api=service(),scope='user', name='表达';
 const change={scope,name,value:'短句',expectedVersion:0,confirmed:true as const,requestId:randomUUID(),action:'confirm' as const};
 expect(await api.change(change)).toEqual({version:1});
 expect(await api.change(change)).toEqual({version:1});
 await expect(api.change({...change,action:'delete'})).rejects.toThrow('PREFERENCE_CONFLICT');
 expect(await service().read({scope})).toMatchObject([{value:'短句',version:1,active:true}]);
 expect(await service().resolve([{scope,name,version:1}])).toMatchObject([{value:'短句'}]);
 const corrected={...change,value:'自然段',expectedVersion:1,requestId:randomUUID()};
 expect(await api.change(corrected)).toEqual({version:2});
 await expect(service().resolve([{scope,name,version:1}])).rejects.toThrow('PREFERENCE_CONFLICT');
 await expect(api.change({...change,requestId:randomUUID()})).rejects.toThrow('PREFERENCE_CONFLICT');
 expect(await api.change({...corrected,action:'delete',expectedVersion:2,requestId:randomUUID()})).toEqual({version:3});
 const deleted=await service().read({scope});
 await expect(service().resolve([{scope,name,version:2}])).rejects.toThrow('PREFERENCE_CONFLICT');
 expect(deleted).toMatchObject([{value:null,version:3,active:false}]);
 const stored=await sql.query('SELECT value FROM agent_confirmed_preferences WHERE actor_id=$1',[actor]);
 expect(stored.rows).toEqual([{value:null}]);
 // A new page can recreate the preference using the tombstone version, without old content.
 expect(await api.change({...change,value:'简洁',expectedVersion:deleted[0]!.version,requestId:randomUUID()})).toEqual({version:4});
 expect((await sql.query('SELECT * FROM agent_preference_requests WHERE actor_id=$1',[actor])).rows.every(r=>!JSON.stringify(r).includes('短句'))).toBe(true);
});

it('separates user/account scope and denies another actor, revoked account and deleted identity',async()=>{
 const change={scope:'account:synthetic:channel',name:'风格',value:'平实',expectedVersion:0,confirmed:true as const,requestId:randomUUID(),action:'confirm' as const};
 await service().change(change);
 expect(await service(other).read({scope:'user'})).toEqual([]);
 await expect(service(other).read({scope:change.scope})).rejects.toThrow();
 await expect(service(other).change(change)).rejects.toThrow();
 await sql.query('DELETE FROM artifact_accounts WHERE actor_id=$1',[actor]);
 await expect(service().read({scope:change.scope})).rejects.toThrow();
 await sql.query("UPDATE profiles SET is_deleted='true' WHERE id=$1",[other]);
 await expect(service(other).read({scope:'user'})).rejects.toThrow();
});

it('serializes concurrent edits and rejects unconfirmed writes and direct table access',async()=>{
 const change={scope:'user',name:'concurrent',value:'one',expectedVersion:0,confirmed:true as const,requestId:randomUUID(),action:'confirm' as const};
 const results=await Promise.allSettled([service().change(change),service().change({...change,value:'two',requestId:randomUUID()})]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 const rejected=await admin.rpc('agent_preference',{p_actor_id:actor,p_action:'confirm',p_payload:{...change,name:'unconfirmed',confirmed:false}});
 expect(rejected.error).not.toBeNull();
 const publicClient=createClient(url,process.env.V3_LOCAL_USER_JWT!,{auth:{persistSession:false}});
 expect((await publicClient.rpc('agent_preference',{p_actor_id:actor,p_action:'read',p_payload:{scope:'user'}})).error).not.toBeNull();
 expect((await publicClient.from('agent_confirmed_preferences').select('*')).error).not.toBeNull();
 expect((await admin.from('agent_confirmed_preferences').select('*')).error).not.toBeNull();
});
