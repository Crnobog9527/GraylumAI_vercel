/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const denied=async(promise,code)=>{await assert.rejects(promise,error=>{if(!String(error.message).includes(code))throw error;return true;},code);};

/** profiles.reply_language: clients only read their own row's value; only the server writes it, only one of three values,
 * and the grant does not open any other column. */
export async function runCases({db,report}) {
 const owner=randomUUID(),other=randomUUID();
 // The owner never set a nickname: the client update policy would refuse them, which is why the server writes this column.
 await db.query(`INSERT INTO profiles(id,email,nickname) VALUES ($1,'owner@example.test',NULL),($2,'other@example.test','Other')`,[owner,other]);
 const as=async(role,sub,text,args=[])=>{
  await db.query('BEGIN');
  try{
   await db.query(`SELECT set_config('request.jwt.claims',$1,true)`,[JSON.stringify(sub?{sub,role}:{role})]);
   await db.query(`SET LOCAL ROLE ${role}`);
   const result=await db.query(text,args);await db.query('COMMIT');return result;
  }catch(error){await db.query('ROLLBACK');throw error;}
 };
 const value=async id=>(await db.query('SELECT reply_language v FROM profiles WHERE id=$1',[id])).rows[0].v;

 // Clients: no write to this column, on their own row or anyone else's; no insert or delete through it.
 for(const target of [owner,other]){
  await denied(as('authenticated',owner,'UPDATE profiles SET reply_language=$2 WHERE id=$1',[target,'en']),'permission denied');
  await denied(as('authenticated',owner,'UPDATE profiles SET reply_language=$2, credits=99999 WHERE id=$1',[target,'en']),'permission denied');
 }
 await denied(as('anon',null,'UPDATE profiles SET reply_language=$1',['en']),'permission denied');
 assert.equal(await value(owner),null);assert.equal(await value(other),null);
 report.checks.push('authenticated/anon cannot write reply_language on any row, alone or with another column');

 // Reads: the owner sees only their own row's value; anon reads nothing.
 const read=await as('authenticated',owner,'SELECT id, reply_language FROM profiles');
 assert.deepEqual(read.rows,[{id:owner,reply_language:null}]);
 await denied(as('anon',null,'SELECT reply_language FROM profiles'),'permission denied');
 report.checks.push('owner reads only their own reply_language; anon cannot read it');

 // Server: writes exactly this column, one of three values; the grant opens nothing else.
 for(const locale of ['zh-Hant','en','zh-Hans']){
  const updated=await as('service_role',null,'UPDATE profiles SET reply_language=$2 WHERE id=$1 RETURNING reply_language',[owner,locale]);
  assert.deepEqual(updated.rows,[{reply_language:locale}]);
 }
 assert.equal(await value(other),null,'only the targeted row changes');
 for(const bad of ['fr','zh-hant','','EN'])
  await denied(as('service_role',null,'UPDATE profiles SET reply_language=$2 WHERE id=$1',[owner,bad]),'profiles_reply_language_check');
 await denied(as('service_role',null,'UPDATE profiles SET reply_language=$2, credits=1 WHERE id=$1',[owner,'en']),'permission denied');
 await denied(as('service_role',null,'UPDATE profiles SET reply_language=$2, nickname=$3 WHERE id=$1',[owner,'en','x']),'permission denied');
 assert.equal(await value(owner),'zh-Hans');
 report.checks.push('service_role writes only reply_language, only zh-Hans/zh-Hant/en, and cannot change other columns with it');

 // Entry language (applyEntryReplyLanguage): set only while empty, never over a choice.
 const once=async id=>(await as('service_role',null,
  'UPDATE profiles SET reply_language=$2 WHERE id=$1 AND reply_language IS NULL RETURNING id',[id,'zh-Hant'])).rowCount;
 assert.equal(await once(owner),0);assert.equal(await value(owner),'zh-Hans');
 assert.equal(await once(other),1);assert.equal(await value(other),'zh-Hant');
 assert.equal(await once(other),0);
 report.checks.push('entry language applies only while empty and never overrides a choice');
}
