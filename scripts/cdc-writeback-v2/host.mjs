/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, repo, save } from './source.mjs';

export async function runHost(sourcePlan, output, respond, variants) {
  mkdirSync(output, { mode: 0o700 });
  const plan = structuredClone(sourcePlan), secret = randomUUID();
  const slots = plan.groups.flatMap(g => g.turns.flatMap(t => ['mentor', 'organizer'].map(role => ({ role, slot: t.slot }))));
  let next = 0, busy = false, stopped = false;
  const server = createServer(async (req, res) => {
    try {
      assert(!busy && !stopped && req.method === 'POST' && req.url === '/request' &&
        req.headers.authorization === secret, 'HOST_AUTH_SEQUENCE');
      busy = true;
      let raw = '';
      for await (const chunk of req) { raw += chunk; assert(Buffer.byteLength(raw) <= 262144, 'HOST_BODY_LIMIT'); }
      const input = JSON.parse(raw), expected = slots[next];
      assert(expected && input.ordinal === next + 1 && input.slot === expected.slot && input.role === expected.role, 'HOST_ROSTER');
      const result = await respond(input);
      next++;
      res.writeHead(200, { 'content-type': input.role === 'mentor' ? 'text/event-stream' : 'application/json' });
      res.end(result);
      busy = false;
    } catch (error) {
      stopped = true;
      console.error(error.message);
      res.writeHead(409); res.end('HOST_STOP');
    }
  });
  plan.output = output;
  if (respond) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    plan.bridge = { url: `http://127.0.0.1:${server.address().port}/request`, secret };
  }
  if (variants) {
    const path = join(output, 'variants.json');
    save(path, variants);
    plan.reasoningReplay = path;
  }
  const inputPath = join(output, 'input.json');
  save(inputPath, plan);
  const fd = openSync(join(output, 'local-run.log'), 'wx', 0o600);
  try {
    const child = spawn(process.execPath, ['packages/db/tests/v3/run-workbench.mjs', '--runtime-only',
      '--with-staging-schema', '--without-app', '--schema-from-files', '--cdc-b2-eval'], {
      cwd: repo, env: { PATH: process.env.PATH, HOME: process.env.HOME, V3_REAL_SKILL_INPUT: inputPath },
      stdio: ['ignore', fd, fd],
    });
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    assert(code === 0 && !stopped && (!respond || next === slots.length), 'HOST_FAILED_SEE_PRIVATE_LOG');
  } finally {
    closeSync(fd);
    if (respond) await new Promise(resolve => server.close(resolve));
    delete plan.bridge;
    writeFileSync(inputPath, JSON.stringify(plan), { mode: 0o600 });
  }
}
