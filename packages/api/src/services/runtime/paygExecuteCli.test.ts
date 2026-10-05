/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import manifest from '../../../../../docs/launch/evidence/payg-profile-20261005-proxy-r2.manifest.json';
const state=vi.hoisted(()=>({home:''}));
vi.mock('node:os',async(importOriginal)=>({...await importOriginal<typeof import('node:os')>(),homedir:()=>state.home}));
vi.mock('../../../../../scripts/payg-profile/executor',async(importOriginal)=>({
 ...await importOriginal<typeof import('../../../../../scripts/payg-profile/executor')>(),
 verifyCatalog:vi.fn(),executePlan:vi.fn(),
}));
vi.mock('../../../../../scripts/payg-profile/proxy-preflight',()=>({verifyProxyCountry:vi.fn()}));
import {verifyProxyCountry} from '../../../../../scripts/payg-profile/proxy-preflight';
import {main} from '../../../../../scripts/payg-profile/execute-cli';
import {executePlan,verifyCatalog} from '../../../../../scripts/payg-profile/executor';
const root=fileURLToPath(new URL('../../../../../',import.meta.url));
const args=['execute-approved',resolve(root,'scripts/payg-profile/plan-prices.json'),
 resolve(root,'docs/launch/evidence/payg-profile-20261005-proxy-r2.manifest.json'),manifest.manifestHash,'owner-approved-test-balance-only'];
let cwd:string,exitCode:typeof process.exitCode;
beforeEach(async()=>{
 state.home=await mkdtemp(join(tmpdir(),'payg-cli-test-'));cwd=process.cwd();process.chdir(root);exitCode=process.exitCode;
 vi.stubEnv('GRAYLUM_PAYG_TEST_OPENROUTER_KEY','SYNTHETIC_TEST_ONLY');
 vi.mocked(verifyProxyCountry).mockReset().mockResolvedValue('US');
 vi.mocked(verifyCatalog).mockReset().mockResolvedValue();
 vi.mocked(executePlan).mockReset();
});
afterEach(async()=>{
 process.chdir(cwd);process.exitCode=exitCode;vi.unstubAllEnvs();vi.restoreAllMocks();
 await rm(state.home,{recursive:true,force:true});
});
it('missing credential creates no lock or event file and performs no catalog call',async()=>{
 vi.stubEnv('GRAYLUM_PAYG_TEST_OPENROUTER_KEY','');
 await expect(main(args)).rejects.toThrow('APPROVED_TEST_CREDENTIAL_MISSING');
 expect(await readdir(state.home)).toEqual([]);expect(verifyCatalog).not.toHaveBeenCalled();expect(executePlan).not.toHaveBeenCalled();
},30000);
it.each(['CATALOG_UNAVAILABLE','CATALOG_DRIFT_REPLAN_REQUIRED'])(
 'first preflight failure leaves no persistent claim: %s',async(reason)=>{
 vi.mocked(verifyCatalog).mockRejectedValue(new Error(reason));
 await expect(main(args)).rejects.toThrow(reason);
 expect(await readdir(state.home)).toEqual([]);expect(executePlan).not.toHaveBeenCalled();
},30000);
it('first preflight precedes exclusive claim; halt code is printed and restart cannot dispatch',async()=>{
 vi.mocked(verifyCatalog).mockImplementation(async()=>{expect(await readdir(state.home)).toEqual([]);});
 const output=vi.spyOn(console,'log').mockImplementation(()=>{});
 vi.mocked(executePlan).mockImplementation(async({journal,egressCountry,transport})=>{
  expect(egressCountry).toBe('US');expect(transport).toBe(fetch);
  const directory=join(state.home,'.local/state/graylum/payg-profile',manifest.manifestHash);
  expect(await readdir(directory)).toEqual(['attempted.lock','events.jsonl']);
  const event={type:'halt',reason:'CATALOG_UNAVAILABLE'};
  await journal.append(event);journal.events.push(event);
  return {} as Awaited<ReturnType<typeof executePlan>>;
 });
 await main(args);
 expect(verifyProxyCountry).toHaveBeenCalledTimes(1);
 expect(JSON.parse(String(output.mock.calls[0][0]))).toMatchObject({attempts:0,halted:true,reason:'CATALOG_UNAVAILABLE'});
 expect(process.exitCode).toBe(1);
 const directory=join(state.home,'.local/state/graylum/payg-profile',manifest.manifestHash);
 expect(await readFile(join(directory,'events.jsonl'),'utf8')).toBe('{"type":"halt","reason":"CATALOG_UNAVAILABLE"}\n');
 vi.mocked(verifyCatalog).mockResolvedValue();
 await expect(main(args)).rejects.toMatchObject({code:'EEXIST'});
 expect(executePlan).toHaveBeenCalledTimes(1);
},30000);

it.each(['PROXY_REQUIRED','PROXY_COUNTRY_NOT_ALLOWED','PROXY_COUNTRY_CHECK_FAILED'])(
 'proxy rejection occurs before locking or any catalog/model request: %s',async(code)=>{
 vi.mocked(verifyProxyCountry).mockRejectedValue(new Error(code));
 await expect(main(args)).rejects.toThrow(code);
 expect(await readdir(state.home)).toEqual([]);
 expect(verifyCatalog).not.toHaveBeenCalled();expect(executePlan).not.toHaveBeenCalled();
},30000);
