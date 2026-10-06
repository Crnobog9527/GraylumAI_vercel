/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './budget.mjs';
import { assert, hash, read, save } from '../cdc-b2-eval/reasoningSource.mjs';
export { assert, hash, read, save, root };
export const repo = fileURLToPath(new URL('../..', import.meta.url));
export const skillPath = join(root, '../cdc-writeback-v2/skill-388fa8cc');
export const profiles = {
  mentor: { model: 'anthropic/claude-sonnet-5.5', tag: 'anthropic', provider: 'Anthropic',
    prompt: 2.5, completion: 10, output: 8192, input: 90000 },
  organizer: { model: 'openai/gpt-6-luna', tag: 'openai', provider: 'OpenAI',
    prompt: 0.25, completion: 0.75, output: 2048, input: 64000 },
};
export const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
export function codeHash() {
  const paths = git('ls-files').split('\n').filter(p => /^(packages\/|scripts\/|package.json$|pnpm-lock.yaml$)/.test(p));
  return hash(paths.map(p => p + ':' + hash(readFileSync(join(repo, p)))).join('\n'));
}
export function skillFiles() {
  const paths = readdirSync(skillPath, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
    .map(e => join(e.parentPath, e.name).slice(skillPath.length + 1)).sort();
  assert(paths.length === 22, 'SKILL_FILE_COUNT');
  return paths.map(path => ({ path, base64: readFileSync(join(skillPath, path)).toString('base64') }));
}
export function checkCases(cases, workflow) {
  assert(cases.length === 100 && new Set(cases.map(c => c.id)).size === 100, 'CASES_COUNT');
  const fields = new Set(workflow.steps.flatMap((s, i) => s.information.map(f => `step-${i + 1}/${f.id}`)));
  for (const c of cases) {
    assert(/^C\d{3}$/.test(c.id) && typeof c.input === 'string' && c.input.trim(), 'CASE_ID_INPUT');
    assert(fields.has(`${c.stepId}/${c.questionId}`), 'CASE_CURRENT_FIELD');
    assert(Array.isArray(c.gold) && Array.isArray(c.initial) && Array.isArray(c.forbiddenEverywhere), 'CASE_GOLD');
    assert(c.gold.length || c.expectNoUserFactChange, 'CASE_NO_EXPECTATION');
    for (const field of [...c.initial, ...c.gold]) assert(fields.has(`${field.stepId}/${field.fieldId}`), 'CASE_FIELD');
    for (const field of c.gold) {
      assert(['value', 'suggestion'].includes(field.target), 'GOLD_TARGET');
      assert(Array.isArray(field.required) && Array.isArray(field.forbidden), 'GOLD_ATOMS');
      for (const atom of field.required) assert(atom.id && atom.meaning && atom.anyOf?.length &&
        atom.anyOf.every(s => typeof s === 'string' && s.trim()), 'GOLD_ATOM');
    }
  }
}
export function measure(raw, role) {
  const p = profiles[role], body = JSON.parse(raw);
  assert(p && body.model === p.model && body.max_tokens === p.output && body.store === false &&
    Buffer.byteLength(raw) <= p.input, 'REQUEST_PROFILE');
  assert(JSON.stringify(body.provider) === JSON.stringify({ allow_fallbacks: false, require_parameters: true,
    only: [p.tag], max_price: { prompt: p.prompt, completion: p.completion, request: 0 } }), 'REQUEST_ROUTE');
  assert(body.stream === (role === 'mentor') && body.reasoning === undefined &&
    body.reasoning_effort === (role === 'mentor' ? 'low' : undefined), 'REQUEST_REASONING');
  assert(!raw.includes('"ttl":"1h"'), 'CACHE_TTL');
  return { requestHash: hash(raw), reserveNano: Math.ceil((Buffer.byteLength(raw) + 8192) * p.prompt * 1000 + p.output * p.completion * 1000) };
}
export async function request(url, options = {}) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(240000), ...options });
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    assert(size <= 8 * 1024 * 1024, 'RESPONSE_LIMIT');
    chunks.push(chunk);
  }
  return { status: response.status, body: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) };
}
export async function catalog() {
  const out = {};
  for (const [role, p] of Object.entries(profiles)) {
    const result = await request(`https://openrouter.ai/api/v1/models/${p.model}/endpoints`);
    assert(result.status === 200, 'CATALOG_HTTP');
    const endpoint = JSON.parse(result.body).data.endpoints.find(e => e.tag === p.tag);
    assert(endpoint?.model_id === p.model && endpoint.provider_name === p.provider &&
      endpoint.max_completion_tokens >= p.output && endpoint.context_length >= p.input + 8192 + p.output &&
      endpoint.supported_parameters.includes('max_tokens'), 'CATALOG_PROFILE');
    for (const price of [endpoint.pricing, ...(endpoint.pricing.overrides ?? [])]) {
      assert([price.prompt, price.input_cache_write ?? price.prompt].every(v =>
        Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= p.prompt / 1e6) &&
        Number(price.completion) >= 0 && Number(price.completion) <= p.completion / 1e6 &&
        Number(price.request ?? 0) === 0, 'CATALOG_PRICE');
    }
    out[role] = { checkedAt: new Date().toISOString(), endpoint };
  }
  return out;
}
