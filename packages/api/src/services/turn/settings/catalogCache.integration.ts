/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {ensurePositioningProfilePlans} from '../../__tests__/fixtures/positioningProfilePlans';
const connectionString=process.env.V3_LOCAL_DB!;
if(!connectionString?.startsWith('postgres://postgres@127.0.0.1:')||!connectionString.endsWith('/v3_disposable'))
 throw new Error('isolated runner required');
const db=new pg.Client({connectionString});
const admin=createClient(process.env.V3_LOCAL_REST!,process.env.V3_LOCAL_SERVICE_JWT!,{auth:{persistSession:false}});
beforeAll(async()=>{await db.connect();await ensurePositioningProfilePlans(db);});
afterAll(()=>db.end());
const versions=async()=>Object.fromEntries((await db.query('select name,version::int v from catalog_versions')).rows.map(r=>[r.name,r.v]));

it('RUNTIME: DB-RW PR-B catalog versions move on real changes only and are readable by the service role only',async()=>{
 const before=await versions();
 // An unchanged UPDATE and an ON CONFLICT DO NOTHING change no row: no version moves (the capacity marker cron does this).
 await db.query("insert into system_settings(key,value) values('catalog_versions_probe','1') on conflict(key) do update set value=excluded.value");
 const probe=await versions();
 expect(probe.settings).toBe(before.settings+1);
 await db.query("update system_settings set value=value where key='catalog_versions_probe'");
 await db.query("insert into system_settings(key,value) values('catalog_versions_probe','2') on conflict(key) do nothing");
 expect(await versions()).toEqual(probe);
 const model=randomUUID();
 await db.query("insert into ai_models(id,name,model_id,provider,is_active) values($1,'Catalog probe','catalog-probe','fixture','true')",[model]);
 await db.query("update ai_models set max_tokens=2000 where id=$1",[model]);
 expect(await versions()).toEqual({...probe,models:probe.models+2});
 await db.query("delete from system_settings where key='catalog_versions_probe'");
 expect((await versions()).settings).toBe(probe.settings+1);
 // The snapshot is the service role's; a signed-in user and the anonymous key are refused.
 const snapshot=await admin.rpc('catalog_versions_snapshot',{});
 expect(snapshot.error).toBeNull();
 expect(snapshot.data).toMatchObject({enabled:false,settings:expect.any(Number),models:expect.any(Number),skills:expect.any(Number)});
 const anon=createClient(process.env.V3_LOCAL_REST!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});
 expect((await anon.rpc('catalog_versions_snapshot',{})).error).toBeTruthy();
 expect((await anon.from('catalog_versions').select('name')).data??[]).toEqual([]);
});
