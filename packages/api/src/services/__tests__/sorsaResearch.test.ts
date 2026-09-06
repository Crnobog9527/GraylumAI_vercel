import {describe,it,expect} from 'vitest';
import {sorsaContract as c,SORSA_PROFILE as P,SORSA_TWEETS as T,sorsaSchemas,sorsaCapabilities} from '../research/sorsaContract';
import {contractHash} from '../research/agentKey';
import {sampleProfile,sampleTweets,sampleDiscovery,sampleDescription} from './fixtures/sorsaResponses';
const context=(canonicalName=P,params:Record<string,unknown>={username:'sample_lab'})=>({canonicalName,params});
describe('observed Sorsa contracts with fictional derived samples',()=>{
 it('reads the actual discovery envelope and leaves whitelist intersection to the adapter',()=>{
  expect(c.discovery(sampleDiscovery).names).toEqual([P,T,'Unreviewed/Write']);
  expect(()=>c.discovery({names:[P]})).toThrow('PROVIDER_CONTRACT_INVALID');
  expect(()=>c.discovery({tools:[{name:2}]})).toThrow('PROVIDER_CONTRACT_INVALID');
 });
 it.each([P,T] as const)('validates %s same-name empty template without altering raw schema/hash',name=>{
  const d=sampleDescription(name);const parsed=c.description(d);
  expect(parsed).toEqual({name,schema:d.params,creditsPerCall:1});
  expect(contractHash(parsed.schema)).toBe(sorsaCapabilities.find(x=>x.canonicalName===name)!.schemaHash);
  expect(parsed.schema).not.toHaveProperty('required');expect(d.execute_as).toEqual({name,params:{}});
 });
 it.each(['name','implicit','unknown','route','root-route','unhealthy','schema','price','missing-template'])('rejects %s description drift',mode=>{
  const d:Record<string,any>=sampleDescription(P);
  if(mode==='name')d.execute_as.name=T;
  if(mode==='implicit')d.execute_as.params.username='someone_else';
  if(mode==='unknown')d.execute_as.extra=true;
  if(mode==='route')d.execute_as.route='alternate';
  if(mode==='root-route')d.route='alternate';
  if(mode==='unhealthy')d.health.healthy=false;
  if(mode==='schema')d.params.required=['username'];
  if(mode==='price')d.cost={billing_note:'route dependent'};
  if(mode==='missing-template')delete d.execute_as;
  expect(()=>c.description(d)).toThrow();
 });
 it.each([{}, {username:''},{username:' sample_lab'},{username:'sample_lab',user_id:'1'},{user_id:123}, {user_link:'https://x.com/sample_lab?private=1'}, {user_link:'https://evil.test/sample_lab'}, {user_link:'https://x.com/sample_lab/posts'}, {username:'sample_lab',rawSkill:'private'}, {username:'sample_lab',next_cursor:''}])('rejects invalid host identity %j',params=>{
  expect(()=>c.validateInput!(context(T,params))).toThrow();
 });
 it.each([{username:'SAMPLE_LAB'},{user_id:'1234567890123456789'},{user_link:'https://x.com/sample_lab'}])('binds a public profile to exactly one supported identity %j',params=>{
  const r=c.result(sampleProfile,context(P,params));
  expect(r.actualCredits).toBeNull();expect(r.objects[0].id).toBe('1234567890123456789');
  expect(r.objects[0].observedAt).toBeNull();expect(r.objects[0]).not.toHaveProperty('sourceUrl');
  expect(r.objects[0].fields).toMatchObject({kind:'profile',pinned_tweet_ids:null,bio_urls:null});
 });
 it.each(['wrong-kind','wrong-identity','numeric-id','missing-date','private','provider','unsupported'])('rejects %s result',mode=>{
  const r:Record<string,any>=structuredClone(sampleProfile);
  if(mode==='wrong-kind')r.data=sampleTweets.data;
  if(mode==='wrong-identity')r.data.username='another_lab';
  if(mode==='numeric-id')r.data.id=123;
  if(mode==='missing-date')delete r.data.created_at;
  if(mode==='private')r.data.protected=true;
  if(mode==='provider')r.provider='Other';
  expect(()=>c.result(r,context(mode==='unsupported'?'Other/get_info':P))).toThrow();
 });
 it('projects fields, preserving null, missing, empty arrays, nested original posts and incomplete pagination',()=>{
  const raw:Record<string,any>=structuredClone(sampleTweets);delete raw.data.tweets[0].quote_count;
  raw.private_manifest='PRIVATE_CANARY';raw.data.tweets[0].api_key='SECRET_CANARY';
  const r=c.result(raw,context(T));
  expect(r.pagination).toEqual({complete:false,nextCursor:'synthetic-next-page'});expect(r.actualCredits).toBeNull();
  expect(r.objects[0]).toMatchObject({observedAt:null,missingFields:['quote_count'],fields:{bookmark_count:null,entities:[],quoted_status:null}});
  expect(r.objects[0].fields.retweeted_status).toMatchObject({id:'3234567890123456789',full_text:'Fictional original post',view_count:null,user:{username:'sample_origin'}});
  expect(JSON.stringify(r)).not.toMatch(/PRIVATE_CANARY|SECRET_CANARY|took_ms|api_key|private_manifest/);
  raw.data.next_cursor=null;expect(c.result(raw,context(T)).pagination.complete).toBe(true);
 });
 it.each(['missing-cursor','empty-cursor','mismatched-author','duplicate','missing-text','wrong-profile-shape'])('rejects ambiguous tweets: %s',mode=>{
  const r:Record<string,any>=structuredClone(sampleTweets);
  if(mode==='missing-cursor')delete r.data.next_cursor;
  if(mode==='empty-cursor')r.data.next_cursor='';
  if(mode==='mismatched-author')r.data.tweets[0].user.username='other';
  if(mode==='duplicate')r.data.tweets.push(r.data.tweets[0]);
  if(mode==='missing-text')delete r.data.tweets[0].full_text;
  if(mode==='wrong-profile-shape')r.data=sampleProfile.data;
  expect(()=>c.result(r,context(T))).toThrow();
 });
 it('never substitutes an upstream quoted/claimed cost for missing observed billing contract',()=>{
  expect(c.result({...sampleProfile,actualCredits:0,cost:{actual:1}},context()).actualCredits).toBeNull();
  expect(sorsaSchemas[P]).not.toHaveProperty('required');
 });
});
