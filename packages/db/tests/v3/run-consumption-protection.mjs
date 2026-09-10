/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Reuse the disposable SQL/Auth/HTTP runner with repository-shaped privileges.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
const baseline = process.argv.includes('--baseline');
const regression = process.argv.includes('--regression');
if ((baseline && regression) || process.argv.slice(2).some(v => !['--baseline','--regression'].includes(v))) throw new Error('Invalid option');
let source = readFileSync(new URL('./run-workbench.mjs', import.meta.url), 'utf8');
function replace(from, to) {
  if (source.split(from).length !== 2) throw new Error('Shared fixture boundary changed: ' + from.slice(0, 80));
  source = source.replace(from, to);
}
replace('const args = process.argv.slice(2);', "const args = ['--ai-only'];");
replace('...(aiOnly ? ["--testNamePattern", testPattern] : []),', baseline ? '"--testNamePattern", "^CONSUMPTION: .*narrow ACL hourly",' : regression ? '"--testNamePattern", "^(AI:|CHAT: (HTTP 429|summary HTTP 429|late initial read|durable multi-turn|[3468] configured steps|prepared|free and document UI))",' : '"--testNamePattern", "^CONSUMPTION:",');
if (baseline) replace('const tag = `graylum-wb-', `
for(const path of ['packages/api/src/middleware/securityChecks.ts','packages/api/src/services/artifacts/generation.ts','packages/api/src/services/research/workbenchSearch.ts']) {
  writeFileSync(resolve(root,path),execFileSync('git',['show','0a422ef228207e48c93959b3cede65953c149900:'+path],{cwd:source}));
}
console.log('BASELINE_RUNTIME 0a422ef228207e48c93959b3cede65953c149900');
const tag = \`graylum-wb-`);
replace('console.log("SQL additive migration and repeat application PASS");', `
  sql('REVOKE SELECT ON billing_history FROM service_role; REVOKE SELECT(user_id) ON billing_history FROM service_role; GRANT SELECT(operation_type,amount,created_at) ON billing_history TO service_role');
  sql('REVOKE ALL ON profiles FROM service_role; GRANT SELECT(id,email,nickname,role,status,membership_level,credits,created_at,is_deleted) ON profiles TO service_role');
  apply('packages/db/migrations/0078_ordinary_chat_requests.sql');
  console.log('Repository-shaped narrow billing ACL ready');
`);
replace('"PGRST_DB_ANON_ROLE=anon",', '"PGRST_DB_ANON_ROLE=anon", "-e", "PGRST_DB_MAX_ROWS=1000",');
// HTTP response corruption is confined to the disposable gateway. SQL/Auth are real.
replace('let modelCalls = 0;', "let modelCalls = 0; let consumptionFault = 'none';");
replace('gateway = createServer(async (req, res) => {', `gateway = createServer(async (req, res) => {
    if(req.url?.startsWith('/__consumption_fault/')) { consumptionFault=req.url.split('/').at(-1);res.writeHead(200).end('{}');return; }
`);
replace('res.writeHead(response.status, Object.fromEntries(response.headers));', `
      if(req.url?.startsWith('/rest/v1/billing_history?') && response.ok && consumptionFault!=='none') {
        const headers=Object.fromEntries(response.headers);delete headers['content-length'];delete headers['content-encoding'];
        let data=await response.json();
        if(consumptionFault==='missing-data') { data=null; headers['content-range']='*/0'; }
        else if(consumptionFault==='missing-count') delete headers['content-range'];
        else { data=[consumptionFault==='missing-amount'?{}:{amount:consumptionFault==='string-amount'?'-1':null}]; headers['content-range']='0-0/1'; }
        res.writeHead(200,headers).end(JSON.stringify(data));return;
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
`);
replace('...cleanEnv,\n    ...(args.includes', `...cleanEnv,\n    V3_CONSUMPTION_SUITE: '1',\n    ...(args.includes`);
const temporary = new URL(`./.consumption-${randomUUID()}.mjs`, import.meta.url);
writeFileSync(temporary, source);
try {
  const child = spawn(process.execPath, [temporary.pathname], { stdio: 'inherit' });
  process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code ?? 1)); });
} finally { unlinkSync(temporary); }
