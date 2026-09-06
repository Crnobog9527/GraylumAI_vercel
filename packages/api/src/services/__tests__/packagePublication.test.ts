import { describe,it,expect,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { publishSkillPackage,type PackagePublication } from '../skills/publication';
import { packageHash,sha256,type PackageDescriptor } from '../skills/loader';
const make=()=>{
 const id=randomUUID(),revisionId=randomUUID(),text='---\nname: sample\ndescription: Synthetic public description\n---\nPrivate test method.\n';
 const descriptor:PackageDescriptor={packageId:id,revisionId,directoryName:'sample',files:[{path:'SKILL.md',bytes:Buffer.byteLength(text),mediaType:'text/markdown',sha256:sha256(text),requires:[]}],tasks:{},requiredCapabilities:['documents.read'],packageHash:''};descriptor.packageHash=packageHash(descriptor);
 const input:PackagePublication={id,revisionId,requestId:randomUUID(),expectedVersion:0,resourcePlanReviewed:true,descriptor,files:[{path:'SKILL.md',base64:Buffer.from(text).toString('base64')}]};return input;
};
describe('complete publication validation before RPC',()=>{
 it.each(['tamper','missing','duplicate','path','unicode','format','review'])('rejects %s without a database write',async kind=>{
  const p=make(),d=p.descriptor as PackageDescriptor,db={rpc:vi.fn()};
  if(kind==='tamper')p.files[0].base64=Buffer.from('tamper').toString('base64');
  if(kind==='missing')p.files=[];
  if(kind==='duplicate')p.files.push(p.files[0]);
  if(kind==='path'){d.files[0].path='../SKILL.md';d.packageHash=packageHash(d);}
  if(kind==='unicode'){d.files.push({...d.files[0],path:'😀.md'});d.packageHash=packageHash(d);p.files.push({...p.files[0],path:'😀.md'});}
  if(kind==='format'){const t='No frontmatter';d.files[0].bytes=Buffer.byteLength(t);d.files[0].sha256=sha256(t);d.packageHash=packageHash(d);p.files[0].base64=Buffer.from(t).toString('base64');}
  if(kind==='review')Object.assign(p,{resourcePlanReviewed:false});
  await expect(publishSkillPackage(db as never,randomUUID(),p)).rejects.toThrow();expect(db.rpc).not.toHaveBeenCalled();
 });
 it('returns only identifiers/version and uses one complete RPC',async()=>{
  const p=make(),db={rpc:vi.fn().mockResolvedValue({data:1,error:null})};const r=await publishSkillPackage(db as never,randomUUID(),p);expect(r).toEqual({revisionId:p.revisionId,packageHash:(p.descriptor as PackageDescriptor).packageHash,version:1});expect(db.rpc).toHaveBeenCalledTimes(1);
 });
});
