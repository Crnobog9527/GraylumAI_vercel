/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
export function syntheticSdk(createClient,profileId){
 const objects=new Set(['a','b','c'].map(name=>`${profileId}/${name}.png`));
 const calls=[];let mode='normal';let auth='present';
 const response=(value,status=200)=>new Response(JSON.stringify(value),{status,
  headers:{'Content-Type':'application/json','X-Supabase-Api-Version':'2024-01-01'}});
 const fetcher=async(url,init)=>{
  const target=new URL(String(url));assert.equal(target.origin,'https://erasure.invalid','all SDK I/O stays synthetic');
  const method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):null;
  calls.push({path:target.pathname,method,body});
  if(target.pathname===`/auth/v1/admin/users/${profileId}`){
   if(method==='DELETE'){
    assert.deepEqual(body,{should_soft_delete:false});auth=mode==='auth_unknown'?'unknown':'absent';
    if(mode==='auth_unknown')throw new Error('synthetic timeout');return response({id:profileId});
   }
   assert.equal(method,'GET');
   return auth==='present'?response({id:profileId}):auth==='absent'?response({code:'user_not_found'},404):response({},503);
  }
  if(target.pathname==='/storage/v1/object/list-v2/ticket-attachments'){
   assert.equal(body.limit,1000);assert.equal(body.with_delimiter,false);assert.equal(body.offset,undefined);
   if(mode==='page_failure'&&body.cursor)return response({},403);
   const rows=[...objects].filter(key=>key.startsWith(body.prefix)).sort();
   const offset=body.cursor?Number(body.cursor.slice(7)):0;const end=offset+2;
   return response({hasNext:end<rows.length,nextCursor:end<rows.length?`opaque:${end}`:null,folders:[],
    objects:rows.slice(offset,end).map(key=>({key,id:key}))});
  }
  assert.equal(target.pathname,'/storage/v1/object/ticket-attachments');assert.equal(method,'DELETE');
  assert.ok(body.prefixes.length);for(const path of body.prefixes){assert.ok(objects.has(path));objects.delete(path);}
  return response([]);
 };
 const client=createClient('https://erasure.invalid','synthetic-key',{global:{fetch:fetcher},
  auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
 return {client,objects,calls,setMode:value=>{mode=value;},setAuth:value=>{auth=value;},
  authDeletes:()=>calls.filter(c=>c.method==='DELETE'&&c.path.startsWith('/auth/')).length,
  storageDeletes:()=>calls.filter(c=>c.method==='DELETE'&&c.path.startsWith('/storage/')).length};
}
