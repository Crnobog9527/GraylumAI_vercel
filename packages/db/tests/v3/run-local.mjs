import { execFileSync, spawn } from 'node:child_process';
import { randomUUID, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
const root=resolve(import.meta.dirname,'../../../..');
const tag=`graylum-v3-${randomUUID().slice(0,8)}`, db=`${tag}-db`, rest=`${tag}-rest`;
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
let gateway;
const secret=randomUUID()+randomUUID();
const jwt=(role)=>{const a=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'); const b=Buffer.from(JSON.stringify({role,exp:Math.floor(Date.now()/1000)+7200})).toString('base64url');return `${a}.${b}.${createHmac('sha256',secret).update(`${a}.${b}`).digest('base64url')}`;};
const apply=(path)=>execFileSync('docker',['exec','-i',db,'psql','-U','postgres','-d','v3_disposable','-v','ON_ERROR_STOP=1'],{input:readFileSync(resolve(root,path)),stdio:['pipe','pipe','pipe']});
try {
  docker('network','create',tag);
  docker('run','-d','--name',db,'--network',tag,'-p','127.0.0.1::5432','-e','POSTGRES_DB=v3_disposable','-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17-alpine');
  for(let i=0;i<50;i++){try{docker('exec',db,'pg_isready','-h','127.0.0.1','-U','postgres');break;}catch{await new Promise(r=>setTimeout(r,200));}}
  apply('packages/db/tests/v3/bootstrap.sql');
  apply('packages/db/migrations/0039_normalize_module_policy_shape.sql');
  apply('packages/db/migrations/0062_skill_1a_db_publish_contract.sql');
  for(let i=0;i<2;i++) {
    apply('packages/db/migrations/0064_v3_private_skill_packages.sql');
    apply('packages/db/migrations/0065_v3_research_operations.sql');
  }
  console.log('SQL migrations: applied including repeat application');
  docker('run','-d','--name',rest,'--network',tag,'-p','127.0.0.1::3000','-e',`PGRST_DB_URI=postgres://authenticator@${db}:5432/v3_disposable`,'-e','PGRST_DB_SCHEMAS=public','-e','PGRST_DB_ANON_ROLE=anon','-e',`PGRST_JWT_SECRET=${secret}`,'public.ecr.aws/supabase/postgrest:v14.13');
  const port=(name,internal)=>docker('port',name,internal).split(':').at(-1);
  const restUrl=`http://127.0.0.1:${port(rest,'3000')}`;
  for(let i=0;i<50;i++){try {if((await fetch(restUrl)).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
  gateway=createServer(async(req,res)=>{
    if(!req.url?.startsWith('/rest/v1/')){res.writeHead(404).end();return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const headers={...req.headers};delete headers.host;delete headers.connection;delete headers['content-length'];
    try{const response=await fetch(restUrl+req.url.slice('/rest/v1'.length),{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks),redirect:'error'});
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}
    catch{res.writeHead(502).end();}
  });
  await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
  const apiUrl=`http://127.0.0.1:${gateway.address().port}`;
  // Allowlisted environment only; no inherited .env or real credentials.
  const env={PATH:process.env.PATH,HOME:process.env.HOME,CI:'true',V3_LOCAL_DB:`postgres://postgres@127.0.0.1:${port(db,'5432')}/v3_disposable`,
    V3_LOCAL_REST:apiUrl,V3_LOCAL_SERVICE_JWT:jwt('service_role'),V3_LOCAL_USER_JWT:jwt('authenticated'),V3_LOCAL_JWT_SECRET:secret};
  const child=spawn('pnpm',['--filter','@repo/api','exec','vitest','run','--config','vitest.integration.config.ts'],{cwd:root,env,stdio:'inherit'});
  const code=await new Promise(r=>child.on('exit',r));if(code!==0)throw new Error(`integration failed: ${code}`);
} catch(error) {
  for(const name of [rest,db]){try{console.error(docker('logs',name));}catch{}}
  throw error;
} finally {
  if(gateway){gateway.closeAllConnections();await new Promise(r=>gateway.close(r));}
  for(const name of [rest,db]){try{docker('rm','-f',name);}catch{}}
  try{docker('network','rm',tag);}catch{}
}
