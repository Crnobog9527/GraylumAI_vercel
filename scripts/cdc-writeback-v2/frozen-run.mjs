/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { assert, git, profiles, request } from './source.mjs';
import { pin, loadFrozen, validateApproval, executeBatch } from './frozen.mjs';

const homeDirectory = userInfo().homedir;
const directory = join(homeDirectory, '.graylum/cdc-writeback-v2-approval-20261007');
const ledger = join(homeDirectory, '.graylum/cdc-writeback-v2-20261006/continuation-20261007/budget.jsonl');
const [mode, batch] = process.argv.slice(2);
assert(mode === 'verify' || mode === 'execute', 'USAGE_VERIFY_OR_EXECUTE');
const frozen = loadFrozen(directory, ledger);
if (mode === 'verify') {
  console.log(JSON.stringify({ requests: frozen.requests.length, newReserveNano: pin.newReserveNano,
    historicalExposureNano: pin.settledNano + pin.heldNano, externalCalls: 0 }));
} else {
  // A human-approved, locally recorded scope is required; this tool never creates it.
  // The operator must verify the linked approval is current before creating this file.
  const approval = JSON.parse(readFileSync(join(directory, 'execution-approval.json'), 'utf8'));
  const executionHead = git('rev-parse', 'HEAD');
  validateApproval(approval, frozen, executionHead);
  assert(!git('status', '--porcelain'), 'EXECUTION_REQUIRES_CLEAN_CHECKOUT');
  let headers;
  const result = await executeBatch(frozen, batch, approval, executionHead, {
    async preflight() {
      const p = profiles.organizer;
      const result = await request(`https://openrouter.ai/api/v1/models/${p.model}/endpoints`);
      assert(result.status === 200, 'CATALOG_HTTP');
      const endpoints = JSON.parse(result.body).data.endpoints.filter(e =>
        (e.tag === 'openai' || e.tag.startsWith('openai/')) && !['openai/fast', 'openai/flex'].includes(e.tag));
      assert(endpoints.length > 0, 'CATALOG_ROUTE');
      for (const e of endpoints) {
        assert(e.model_id === p.model && e.provider_name === 'OpenAI' && e.context_length >= p.input + 8192 + p.output &&
          e.max_completion_tokens >= p.output && e.supported_parameters.includes('max_tokens'), 'CATALOG_PROFILE');
        for (const price of [e.pricing, ...(e.pricing.overrides ?? [])]) {
          assert([price.prompt, price.input_cache_write ?? price.prompt].every(v =>
            Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= p.prompt / 1e6) &&
            Number(price.completion) >= 0 && Number(price.completion) <= p.completion / 1e6 &&
            Number(price.request ?? 0) === 0, 'CATALOG_PRICE');
        }
      }
      const key = process.env.GRAYLUM_PAYG_TEST_OPENROUTER_KEY;
      assert(key, 'TEST_KEY_MISSING');
      headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
    },
    send: raw => request('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers, body: raw }),
  });
  console.log(JSON.stringify(result));
}
