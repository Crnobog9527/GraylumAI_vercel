/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {bindFormalArtifactReader} from './artifactReader';

function fixture(){
 const selection={projectId:randomUUID(),roundId:randomUUID(),versionId:randomUUID(),version:1,hash:'a'.repeat(64),targetProjectId:randomUUID(),targetRoundId:randomUUID(),account:'synthetic:channel',sections:['script'],maxChars:2000};
 const workbench={
  projects:vi.fn(async()=>[{projectId:selection.projectId,account:selection.account},{projectId:selection.targetProjectId,account:null,linkedAccount:selection.account}]),
  read:vi.fn(async()=>({})),
  report:vi.fn(async()=>({available:true,id:selection.versionId,version:1,hash:selection.hash,report:{title:'A',sections:[{stepId:'script',title:'脚本',body:'A version one',evidenceIds:['source-only']},{stepId:'unused',title:'Other',body:'Not selected'}]}})),
 };
 return {selection,workbench,read:()=>bindFormalArtifactReader(workbench as never,selection)()};
}
it('reads only selected sections and rechecks exact version on every read',async()=>{
 const f=fixture();expect(JSON.parse(await f.read())).toEqual({kind:'formal_report',version:1,sections:[{title:'脚本',body:'A version one'}]});
 f.workbench.report.mockResolvedValue({...await f.workbench.report(),version:2});
 await expect(f.read()).rejects.toThrow('ARTIFACT_EVIDENCE_UNAVAILABLE');
 expect(f.workbench.read).toHaveBeenCalledWith(f.selection.targetProjectId,f.selection.targetRoundId);
});
it('rejects revoked content, foreign target and missing sections without silently choosing latest',async()=>{
 const f=fixture();f.workbench.report.mockResolvedValue({...await f.workbench.report(),available:false});
 await expect(f.read()).rejects.toThrow('ARTIFACT_EVIDENCE_UNAVAILABLE');
 const g=fixture();g.workbench.projects.mockResolvedValue([{projectId:g.selection.projectId,account:g.selection.account}]);
 await expect(g.read()).rejects.toThrow('ARTIFACT_DENIED');expect(g.workbench.report).not.toHaveBeenCalled();
 const h=fixture();h.selection.sections=['missing'];await expect(h.read()).rejects.toThrow('ARTIFACT_EVIDENCE_UNAVAILABLE');
});
