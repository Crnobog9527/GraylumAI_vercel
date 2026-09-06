/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Independently written synthetic methods/configurations. No provider response or third-party template.
import {randomUUID} from 'node:crypto';
import {packageHash,sha256,type PackageDescriptor} from '../../skills/loader';
import type {Workflow} from '../../artifacts/workflow';
export function makePackage(skillId=randomUUID(),changed=false){
 const files=[{path:'SKILL.md',text:'---\nname: synthetic-method\ndescription: Fictional test method\n---\n# Synthetic method\nA private method canary: METHOD_CANARY.\n'},...Array.from({length:8},(_,i)=>({path:`references/step-${i}.md`,text:`Synthetic resource ${i}${changed&&i===0?' revised':''}.`}))];
 const descriptor:PackageDescriptor={packageId:skillId,revisionId:randomUUID(),packageHash:'',directoryName:'synthetic-method',tasks:{},requiredCapabilities:['documents.read'],files:files.map(f=>({path:f.path,bytes:Buffer.byteLength(f.text),sha256:sha256(f.text),mediaType:'text/markdown',requires:[]}))};
 descriptor.packageHash=packageHash(descriptor);
 return {id:skillId,revisionId:descriptor.revisionId,requestId:randomUUID(),expectedVersion:changed?1:0,resourcePlanReviewed:true as const,descriptor,files:files.map(f=>({path:f.path,base64:Buffer.from(f.text).toString('base64')}))};
}
export function makeWorkflow(n:number,social=false):Workflow {
 const titles=social?['需求确认','对标分析','定位','内容规划','运营','变现']:Array.from({length:n},(_,i)=>`Synthetic step ${i+1}`);
 return {id:social?'social-six':'generic-test',version:1,kind:social?'social':'document',
  steps:Array.from({length:n},(_,i)=>({id:`step-${i}`,title:titles[i],dependsOn:i>0?[`step-${i-1}`]:[],resources:[`references/step-${i}.md`],minLength:1,maxLength:20000,requiresEvidence:false,requiredCapabilities:['documents.read']})),
  report:{id:'confirmed-report',version:1,title:'Confirmed strategy',sections:titles.map((title,i)=>({title,stepId:`step-${i}`}))}};
}
