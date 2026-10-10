/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CDC-WRITEBACK-V3 paid organizer re-run. freeze/verify: no network, no credentials. execute: one batch, explicit approval.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, request } from '../cdc-writeback-v2/source.mjs';
import { validateApproval, executeBatch, validateResponse } from '../cdc-writeback-v2/frozen.mjs';
import { paths, pins, batches, repo, hash, assert, readJson, validateV3Response } from './common.mjs';
import { sourceInputs, buildRoster, promptAt, carry, writeRoster, loadRoster, batchReserves } from './frozen.mjs';

// Production-shaped freeze (complete organizer system prompt, live max_tokens 4096) of the reviewed V3 prompt.
// Any prompt or source change needs a new freeze and review.
export const V3_MANIFEST_HASH = 'a0dcd288055a5bec96bc0221993515e7f1b914344499c290de48d5cdb5b48519';
const directory = join(paths.root, 'frozen');

export function frozenV3(manifestHash = V3_MANIFEST_HASH) {
  assert(/^[a-f0-9]{64}$/.test(manifestHash ?? ''), 'V3_NOT_FROZEN');
  const { rows } = loadRoster(directory, manifestHash, promptAt(repo));
  const ledger = carry(), newReserveNano = rows.reduce((n, r) => n + r.reserveNano, 0);
  assert(ledger.carry.settledNano + ledger.carry.heldNano + newReserveNano <= pins.capNano, 'V3_FROZEN_BUDGET');
  return { requests: rows, batches, directory, ledgerPath: ledger.path, casesPath: join(paths.baseline, 'cases.json'),
    carry: ledger.carry, expected: { manifestHash, newReserveNano, count: rows.length, heldNano: ledger.carry.heldNano,
      settledNano: ledger.carry.settledNano, specialHash: pins.specialHash, casesHash: pins.casesHash,
      oldLedgerHash: pins.sourceLedgerHash } };
}

function proxyGuard(env, execArgs) {
  assert(env.HTTP_PROXY === 'http://127.0.0.1:7897' && env.HTTPS_PROXY === env.HTTP_PROXY && env.http_proxy === env.HTTP_PROXY &&
    env.https_proxy === env.HTTP_PROXY && env.NO_PROXY === '' && env.no_proxy === '' && execArgs.includes('--use-env-proxy'),
  'V3_PROXY_REQUIRED');
}

async function preflight() {
  const r = await request('https://openrouter.ai/api/v1/models/openai/gpt-6-luna/endpoints');
  assert(r.status === 200, 'CATALOG_HTTP');
  const endpoints = JSON.parse(r.body).data.endpoints.filter(e =>
    (e.tag === 'openai' || e.tag.startsWith('openai/')) && !['openai/fast', 'openai/flex'].includes(e.tag));
  assert(endpoints.length > 0, 'CATALOG_ROUTE');
  for (const e of endpoints) {
    assert(e.model_id === 'openai/gpt-6-luna' && e.provider_name === 'OpenAI' && e.context_length >= 64000 + 8192 + 4096 &&
      e.max_completion_tokens >= 4096 && e.supported_parameters.includes('max_tokens'), 'CATALOG_PROFILE');
    for (const price of [e.pricing, ...(e.pricing.overrides ?? [])]) {
      assert([price.prompt, price.input_cache_write ?? price.prompt].every(v => Number.isFinite(Number(v)) && Number(v) >= 0 &&
        Number(v) <= 0.25 / 1e6) && Number(price.completion) >= 0 && Number(price.completion) <= 0.75 / 1e6 &&
        Number(price.request ?? 0) === 0, 'CATALOG_PRICE');
    }
  }
  assert(process.env.GRAYLUM_PAYG_TEST_OPENROUTER_KEY, 'TEST_KEY_MISSING');
}

export async function main(mode, batch) {
  assert(['freeze', 'verify', 'execute'].includes(mode), 'V3_USAGE_FREEZE_VERIFY_EXECUTE');
  if (mode === 'freeze') {
    const inputs = sourceInputs(), rows = buildRoster(inputs, promptAt(repo)), ledger = carry();
    const manifestHash = writeRoster(directory, rows, inputs.specialRaw), reserves = batchReserves(rows);
    const newReserveNano = Object.values(reserves).reduce((a, b) => a + b, 0);
    const proof = { manifestHash, sourceHead: git('rev-parse', 'HEAD'), promptHash: hash(promptAt(repo)),
      sourceManifestHash: pins.sourceManifestHash, casesHash: pins.casesHash, specialHash: pins.specialHash,
      ledgerHash: pins.sourceLedgerHash, ...ledger.carry, reserves, newReserveNano,
      worstCaseNano: ledger.carry.settledNano + ledger.carry.heldNano + newReserveNano, count: rows.length, paidCalls: 0 };
    writeFileSync(join(paths.root, 'freeze-proof.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return proof;
  }
  const frozen = frozenV3();
  if (mode === 'verify') return { requests: frozen.requests.length, manifestHash: frozen.expected.manifestHash,
    reserves: batchReserves(frozen.requests), newReserveNano: frozen.expected.newReserveNano, ...frozen.carry,
    worstCaseNano: frozen.carry.settledNano + frozen.carry.heldNano + frozen.expected.newReserveNano, paidCalls: 0 };
  // A human-approved, locally recorded scope is required; this tool never creates it.
  const approval = readJson(join(paths.root, 'execution-approval.json'));
  const executionHead = git('rev-parse', 'HEAD');
  validateApproval(approval, frozen, executionHead);
  assert(!git('status', '--porcelain'), 'EXECUTION_REQUIRES_CLEAN_CHECKOUT');
  proxyGuard(process.env, process.execArgv);
  let headers;
  return executeBatch(frozen, batch, approval, executionHead, {
    async preflight() {
      await preflight();
      headers = { authorization: `Bearer ${process.env.GRAYLUM_PAYG_TEST_OPENROUTER_KEY}`, 'content-type': 'application/json' };
    },
    send: raw => {
      proxyGuard(process.env, process.execArgv);
      return request('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers, body: raw });
    },
    validate: response => validateV3Response(response, validateResponse),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await main(...process.argv.slice(2)))); }
  catch (e) { console.error(/^[A-Z0-9_]+$/.test(e.message) ? e.message : 'V3_STOP_SEE_PRIVATE_EVIDENCE'); process.exitCode = 1; }
}
