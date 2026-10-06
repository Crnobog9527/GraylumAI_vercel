/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { root as reasoningRoot, save, read, lines, loadSource, assert, expectedManifest } from './cdc-b2-eval/reasoningSource.mjs';

const [mode, profile] = process.argv.slice(2);
assert(profile === undefined || profile === 'capability', 'PROFILE');
const root = profile === 'capability' ? join(reasoningRoot, '../cdc-capability-20261006') : reasoningRoot;
assert(['baseline', 'results'].includes(mode), 'REPLAY_USAGE');
const source = loadSource(), secret = randomUUID();
const slots = new Set(source.organizers.map(q => q.slot));
const replayRequests = source.requests.filter(q => slots.has(q.slot));
const output = join(root, `host-replay-${mode}`);
mkdirSync(output, { mode: 0o700 });
const variants = source.responses.filter(r => r.role === 'organizer').map(r => {
  const body = JSON.parse(r.body);
  return { slot: r.slot, effort: 'baseline', summary: body.choices[0].message.content, finish: body.choices[0].finish_reason };
});
if (mode === 'results') for (const r of lines(join(root, 'responses.jsonl'))) {
  const body = JSON.parse(r.body);
  variants.push({ slot: r.slot, effort: r.effort, summary: body.choices?.[0]?.message?.content ?? '',
    finish: body.choices?.[0]?.finish_reason ?? 'error' });
}
const variantPath = join(output, 'variants.json');
save(variantPath, variants);
let next = 0;
const server = createServer(async (req, res) => {
  try {
    assert(req.method === 'POST' && req.url === '/request' && req.headers.authorization === secret, 'REPLAY_AUTH');
    let raw = '';
    for await (const chunk of req) { raw += chunk; assert(Buffer.byteLength(raw) < 262144, 'REPLAY_SIZE'); }
    const input = JSON.parse(raw), original = replayRequests[next];
    assert(original && input.ordinal === next + 1 && input.slot === original.slot && input.role === original.role, 'REPLAY_ORDER');
    // Organizer model input must match the frozen real second-round request byte for byte.
    if (original.role === 'organizer') assert(input.raw === original.raw, 'REPLAY_ORGANIZER_INPUT_CHANGED');
    const response = source.responses.find(r => r.ordinal === original.ordinal);
    next++;
    res.writeHead(200, { 'content-type': original.role === 'mentor' ? 'text/event-stream' : 'application/json' });
    res.end(response.body);
  } catch (error) {
    console.error(error.message);
    res.writeHead(409); res.end('REPLAY_STOP');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const plan = structuredClone(source.plan);
plan.groups = plan.groups.filter(g => g.turns.some(t => t.organize));
plan.output = output;
plan.reasoningReplay = variantPath;
// TTL was tested in round two. Offline replay has no provider cache or paid requests.
for (const group of plan.groups) for (const turn of group.turns) delete turn.pauseBefore;
plan.bridge = { url: `http://127.0.0.1:${server.address().port}/request`, secret };
const inputPath = join(output, 'input.json');
save(inputPath, plan);
const fd = openSync(join(output, 'local-run.log'), 'wx', 0o600);
try {
  const child = spawn(process.execPath, ['packages/db/tests/v3/run-workbench.mjs', '--runtime-only',
    '--with-staging-schema', '--without-app', '--schema-from-files', '--cdc-b2-eval'], {
    cwd: new URL('..', import.meta.url),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, V3_REAL_SKILL_INPUT: inputPath }, stdio: ['ignore', fd, fd],
  });
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert(code === 0 && next === 60, 'OFFLINE_REPLAY_FAILED_SEE_PRIVATE_LOG');
  const replay = read(join(output, 'reasoning-results.json'));
  const values = after => Object.fromEntries(Object.entries(after.information).map(([id, step]) => [id, step.values]));
  const equalValues = (left, right) => JSON.stringify(values(left)) === JSON.stringify(values(right));
  const baselineRows = replay.filter(r => r.effort === 'baseline');
  assert(baselineRows.length === 30 && baselineRows.every(r =>
    equalValues(r.after, source.full.results.find(old => old.slot === r.slot).after)), 'ORIGINAL_BASELINE_WRITES_CHANGED');
  save(join(output, 'proof.json'), { baselineManifest: expectedManifest, organizerInputsMatch: 30,
    baselineWritesMatch: 30, externalDispatches: 0 });
  console.log(JSON.stringify({ mode, replayed: next, variants: variants.length, externalDispatches: 0 }));
} finally {
  closeSync(fd);
  await new Promise(resolve => server.close(resolve));
}
