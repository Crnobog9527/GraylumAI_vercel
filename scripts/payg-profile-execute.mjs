/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Separate paid entry point. Importing the offline planner never imports this file.
import {mkdtemp,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const args=process.argv.slice(2);
if(args.length!==5||args[0]!=='execute-approved'||!/^[a-f0-9]{64}$/.test(args[3])
 ||args[4]!=='owner-approved-test-balance-only')throw new Error('Explicit reviewed manifest and execution notice required');
const require=createRequire(new URL('../packages/api/package.json',import.meta.url));
const viteRequire=createRequire(require.resolve('vite'));
const {build}=await import(pathToFileURL(viteRequire.resolve('esbuild')).href);
const temporary=await mkdtemp(join(tmpdir(),'graylum-payg-executor-'));
let failureCode=()=> 'PAYG_EXECUTOR_STOPPED';
try{
 const compiled=join(temporary,'execute.cjs');
 await build({entryPoints:[resolve('scripts/payg-profile/execute-cli.ts')],outfile:compiled,bundle:true,platform:'node',format:'cjs'});
 const executor=require(compiled);
 failureCode=executor.failureCode;
 await executor.main(args);
}catch(error){console.error(failureCode(error));process.exitCode=1;}
finally{await rm(temporary,{recursive:true,force:true});}
