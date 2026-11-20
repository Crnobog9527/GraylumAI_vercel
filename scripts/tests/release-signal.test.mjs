/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

for (const signal of ['SIGINT', 'SIGTERM']) test(`${signal} during stack initialization cleans its container and network`, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'release-signal-')), bin = join(temp, 'bin'), log = join(temp, 'docker.log');
  mkdirSync(bin);
  const docker = join(bin, 'docker');
  writeFileSync(docker, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\ncase "$*" in *pg_isready*) exit 1;; esac\nexit 0\n`);
  chmodSync(docker, 0o755);
  const child = spawn(process.execPath, [resolve('scripts/e2e-sim/run.mjs'), '--release-preflight'], {
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: temp }, stdio: 'ignore',
  });
  const done = new Promise(ok => child.once('exit', code => ok(code)));
  try {
    let saw = false;
    for (let n = 0; n < 100; n++) {
      if (existsSync(log) && readFileSync(log, 'utf8').includes('pg_isready')) { saw = true; break; }
      await delay(50);
    }
    assert.ok(saw, 'stack initialization reached the readiness check');
    child.kill(signal);
    const code = await Promise.race([done, delay(10000, null, { ref: false })]);
    assert.notEqual(code, 0); assert.notEqual(code, null);
    const calls = readFileSync(log, 'utf8');
    assert.match(calls, /rm -f -v graylum-sim-/); assert.match(calls, /network rm graylum-sim-/);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); rmSync(temp, { recursive: true, force: true }); }
});

test('a child that ignores SIGTERM is killed before cleanup proceeds', async () => {
  const { stopProcessGroup } = await import('../e2e-sim/process-control.mjs');
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise(ok => child.stdout.once('data', ok));
  await stopProcessGroup(child, 50);
  assert.equal(child.signalCode, 'SIGKILL');
});

test('a running child that ignores SIGTERM cannot trap its parent waiting for exit', async () => {
  const modulePath = new URL('../e2e-sim/process-control.mjs', import.meta.url).href;
  const source = `import {spawn} from 'node:child_process'; import {stopProcessGroup} from ${JSON.stringify(modulePath)};
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],
      {detached:true,stdio:['ignore','pipe','ignore']});
    process.once('SIGTERM',()=>void stopProcessGroup(child,50));
    child.stdout.once('data',()=>console.log('ready'));
    await new Promise(ok=>child.once('exit',ok)); console.log('finished');`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise(ok => parent.stdout.once('data', ok));
    const done = new Promise(ok => parent.once('exit', ok));
    parent.kill('SIGTERM');
    const code = await Promise.race([done, delay(5000, null, { ref: false })]);
    assert.equal(code, 0);
  } finally { if (parent.exitCode === null) parent.kill('SIGKILL'); }
});

test('an exited group leader does not leave a running descendant behind', async () => {
  const { stopProcessGroup } = await import('../e2e-sim/process-control.mjs');
  const source = `const {spawn}=require('node:child_process');
    const sub=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],{stdio:'ignore'});
    console.log(sub.pid); setTimeout(()=>process.exit(0),100);`;
  const leader = spawn(process.execPath, ['-e', source], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = ''; leader.stdout.on('data', chunk => { output += chunk; });
  await new Promise(ok => leader.once('exit', ok));
  const descendant = Number(output.trim()); assert.ok(descendant > 0);
  try {
    process.kill(descendant, 0);
    await stopProcessGroup(leader);
    let alive = true;
    for (let n = 0; n < 50 && alive; n++) {
      await delay(20);
      try { process.kill(descendant, 0); } catch { alive = false; }
    }
    assert.equal(alive, false, 'descendant exited');
  } finally { try { process.kill(descendant, 'SIGKILL'); } catch {} }
});
