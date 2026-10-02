/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { POSTGRES_IMAGE } from '../v3/images.mjs';
import { buildFromFiles, installPgCronStub } from '../baseline/build-from-files.mjs';
export const root = resolve(import.meta.dirname, '../../../..');
export const read = path => readFileSync(resolve(root, path), 'utf8');
export async function localDb() {
  assert.equal(process.argv[2], '--local-only');
  assert.ok(!process.env.CI);
  const run = (cmd, args, input) => spawnSync(cmd, args, { input, encoding: 'utf8', cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME }, maxBuffer: 64 * 1024 * 1024, timeout: 300000 });
  const ok = r => { if (r.status !== 0 || r.error) throw new Error((r.stderr || String(r.error)).slice(-5000)); return r.stdout.trim(); };
  const endpoint = ok(run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']));
  assert.ok(endpoint.startsWith('unix:///') && !endpoint.includes('\n'));
  const docker = (args, input) => run('docker', ['--host', endpoint, ...args], input);
  ok(docker(['image', 'inspect', POSTGRES_IMAGE]));
  const name = `graylum-runtime-perf-${randomUUID().slice(0, 8)}`;
  const sql = input => docker(['exec', '-i', name, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'perf', '-v', 'ON_ERROR_STOP=1'], input);
  let client;
  const close = async () => { await client?.end(); ok(docker(['rm', '-f', '-v', name])); };
  try {
    ok(docker(['run', '-d', '--pull=never', '--name', name, '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_DB=perf', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE,
      '-c', 'track_functions=all']));
    for (let i=0;i<300;i++) {
      if (docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'perf']).status===0) break;
      await new Promise(r=>setTimeout(r,200));
    }
    installPgCronStub(root,name,(args,input)=>ok(docker(['exec',...args],input)));
    const outcome = r=>({ok:r.status===0&&!r.error,error:r.stderr});
    const build = buildFromFiles(root, {
      applyFile: path=>outcome(sql(read(path))),
      applyServerOnly: input=>outcome(docker(['exec',name,'psql','-X','-qAt','-U','postgres','-d','perf','-c',input])),
    });
    assert.equal(build.failed,null,JSON.stringify(build.failed));
    const require = createRequire(resolve(root,'package.json'));
    const {Client} = require('pg');
    const address=ok(docker(['port',name,'5432/tcp']));
    assert.match(address,/^127\.0\.0\.1:\d+$/);
    client=new Client({connectionString:`postgres://postgres@${address}/perf`});
    await client.connect();
    return {client,build,close,sql:input=>ok(sql(input))};
  } catch(e) {await close();throw e;}
}
