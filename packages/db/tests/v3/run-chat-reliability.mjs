/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Reuse the existing disposable SQL/Auth/HTTP/browser runner without changing
// #402's shared runner or fixtures. All substitutions affect a temporary copy.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const baseline = process.argv.includes('--baseline');
const regression = process.argv.includes('--regression');
const searchEvidence = process.argv.includes('--search');
const searchBaseline = process.argv.includes('--search-baseline');
if (process.argv.slice(2).some(v => !['--baseline', '--regression', '--search', '--search-baseline'].includes(v))) throw new Error('Invalid option');
let source = readFileSync(new URL('./run-workbench.mjs', import.meta.url), 'utf8');
function replace(from, to) {
  if (source.split(from).length !== 2) throw new Error('Shared fixture boundary changed: ' + from.slice(0, 80));
  source = source.replace(from, to);
}
replace('const args = process.argv.slice(2);', "const args = ['--chat-only'];");
if (baseline) replace('const tag = `graylum-wb-', `
// Reproduce the immutable admission-protected starting runtime, retaining this
// task's test fixtures. No checkout, shared file, or remote ref is modified.
for(const path of ['apps/web/src/app/api/ai/stream/route.ts','apps/web/src/hooks/useStreamingChat.ts','apps/web/src/app/chat/standard-conversation.tsx','packages/api/src/services/providerUsage.ts']) {
  writeFileSync(resolve(root,path),execFileSync('git',['show','cba14c40499d3f770f7a91b14e211b130278f6c6:'+path],{cwd:source}));
}
console.log('BASELINE_RUNTIME cba14c40499d3f770f7a91b14e211b130278f6c6');
const tag = \`graylum-wb-`);

if (!regression) replace('src/services/__tests__/workbench.integration.ts', searchEvidence || searchBaseline ? 'src/routers/searchEvidence.integration.ts' : 'src/routers/ordinaryChatReliability.integration.ts');
replace('...(aiOnly ? ["--testNamePattern", testPattern] : []),', regression
  ? '"--testNamePattern", "^CHAT: (durable multi-turn linkage|homepage entry|[3468] configured steps|HTTP 429|summary HTTP 429|late initial read)",'
  : '');

replace('console.log("SQL additive migration and repeat application PASS");', `
  // Real column grants from 0063, and own-row policies from 0001.
  sql('REVOKE SELECT ON billing_history FROM service_role; REVOKE SELECT(user_id) ON billing_history FROM service_role; GRANT SELECT(operation_type,amount,created_at) ON billing_history TO service_role');
  sql('REVOKE ALL ON profiles FROM service_role; GRANT SELECT(id,email,nickname,role,status,membership_level,credits,created_at,is_deleted) ON profiles TO service_role');
  const canonical = readFileSync(resolve(root, 'packages/db/migrations/0001_ai_billing_tables.sql'), 'utf8');
  // The shared runner now installs billing_history's canonical own-row policy.
  for (const table of ['ai_usage_logs']) {
    const policy = 'users_own_' + table + '_select';
    const start = canonical.indexOf('CREATE POLICY "' + policy + '"'), end = canonical.indexOf(';', start) + 1;
    if(start < 0 || end <= start) throw new Error('Missing own-row policy');
    sql('GRANT SELECT ON ' + table + ' TO authenticated'); sql(canonical.slice(start, end));
  }
  ${baseline ? '' : "apply('packages/db/migrations/0078_ordinary_chat_requests.sql'); apply('packages/db/migrations/0078_ordinary_chat_requests.sql');"}
  console.log('SQL additive/repeat application and repository-shaped billing ACL ready');
`);
replace('let modelCalls = 0;', "let modelCalls = 0; const { chatProviderFixture } = await import('./chat-provider-fixture.mjs'); const chatFixture = chatProviderFixture();");
replace('gateway = createServer(async (req, res) => {', 'gateway = createServer(async (req, res) => { if (await chatFixture(req, res)) return;');
replace('...cleanEnv,\n    ...(args.includes', `...cleanEnv,\n    CHAT_BASELINE: '${baseline ? '1' : '0'}',\n    ...(args.includes`);
if (searchEvidence || searchBaseline) {
  replace("CHAT_BASELINE: '0',", "CHAT_BASELINE: '0', SEARCH_BASELINE: '"+(searchBaseline?'1':'0')+"',");
  replace("const { chatProviderFixture } = await import('./chat-provider-fixture.mjs');", "const { searchProviderFixture: chatProviderFixture } = await import('./search-provider-fixture.mjs');");
  replace("const u=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!", "const u=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(u.hostname==='generativelanguage.googleapis.com'&&u.pathname.endsWith(':streamGenerateContent'))return original('"+"${apiUrl}"+"/__gemini_search_fixture',init);if(!");
  if(searchBaseline) replace('const tag = `graylum-wb-', `
for(const path of ['apps/web/src/app/api/ai/stream/route.ts','packages/api/src/services/modelRouter.ts','packages/api/src/services/chatRuntime.ts','packages/api/src/routers/settings.ts','packages/api/src/services/research/workbenchSearch.ts']) {
 writeFileSync(resolve(root,path),execFileSync('git',['show','1482a9f4185358711c7d6913a196e6c5e22e23c0:'+path],{cwd:source}));
}
console.log('SEARCH_BASELINE_RUNTIME 1482a9f4185358711c7d6913a196e6c5e22e23c0');
const tag = \`graylum-wb-`);
}
const temporary = new URL(`./.chat-reliability-${randomUUID()}.mjs`, import.meta.url);
writeFileSync(temporary, source);
try {
  const child = spawn(process.execPath, [fileURLToPath(temporary)], { stdio: 'inherit' });
  process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code ?? 1)); });
} finally { unlinkSync(temporary); }
