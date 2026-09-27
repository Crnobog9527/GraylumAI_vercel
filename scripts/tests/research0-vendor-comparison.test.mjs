import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertOutsideRepository, main, parseArgs } from '../research0-vendor-comparison.mjs';
import { count, summarize, timestamp } from '../research0/metrics.mjs';
import { QUERIES } from '../research0/queries.mjs';
import { formatReport } from '../research0/report.mjs';
import { runComparison } from '../research0/runner.mjs';
import { TOTAL_CAP_USD, loadLedger, redactUrl, refusal } from '../research0/safety.mjs';
import { VENDORS } from '../research0/vendors.mjs';
import { displayCount, normalizeTikhub, tikhubFailed } from '../research0/vendors/tikhubShapes.mjs';
import { reanalyze } from '../research0/analyze.mjs';
import { formatMarkdown } from '../research0/markdown.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
// Synthetic placeholder assembled at runtime so secret scanners see no key-like literal.
const KEY = ['placeholder', 'research0', 'not', 'a', 'real', 'credential'].join('_');
const queries = [{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }];

function fakeVendor(overrides = {}) {
  return {
    id: 'fake', label: 'Fake', keyEnv: 'FAKE_KEY', maxCalls: 10, maxUsd: 1,
    steps: query => [{ method: 'GET', url: `https://api.example.test/search?q=${query.id}&api_key=${KEY}`, worstCaseUsd: 0.1 }],
    authorize: (spec, key) => ({ url: spec.url, init: { method: spec.method, headers: { Authorization: `Bearer ${key}`, 'x-api-key': key } } }),
    kind: () => 'posts',
    normalize: json => json.items,
    reportedCostUsd: json => json.cost ?? null,
    ...overrides,
  };
}

function recordingFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init, calls.length);
  };
  return { calls, fetchImpl };
}

const okBody = (extra = {}) => new Response(JSON.stringify({ items: [{ id: '1', likes: 0 }], ...extra }), { status: 200 });

async function withTemp(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'research0-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function run(dir, { vendor = fakeVendor(), fetchImpl, live = true, env = { FAKE_KEY: KEY }, qs = queries, ledger } = {}) {
  const book = ledger ?? (await loadLedger(path.join(dir, 'ledger.json')));
  const report = await runComparison({ vendors: [vendor], queries: qs, env, live, fetchImpl, ledger: book, outDir: dir, timeoutMs: 200 });
  return { report, ledger: book };
}

async function filesUnder(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(path.join(entry.parentPath, entry.name));
  }
  return out;
}

test('dry run sends nothing, books nothing and writes nothing', async () => withTemp(async dir => {
  const { calls, fetchImpl } = recordingFetch(() => okBody());
  const { report, ledger } = await run(dir, { fetchImpl, live: false });
  assert.equal(calls.length, 0);
  assert.equal(ledger.entries.length, 0);
  assert.deepEqual(await filesUnder(dir), []);
  assert.ok(report.vendors[0].queries.every(query => query.status === 'DRY_RUN'));
  assert.equal(report.vendors[0].plan.worstCaseUsd, 0.3);
}));

test('the CLI is a dry run unless --confirm-paid-calls is given', async () => withTemp(async dir => {
  assert.equal(parseArgs([]).live, false);
  assert.equal(parseArgs(['--confirm-paid-calls']).live, true);
  assert.throws(() => parseArgs(['--confirm-paid-calls', '--vendors']), /MISSING_VALUE_FOR_VENDORS/);
  assert.throws(() => parseArgs(['--queries', '', '--confirm-paid-calls']), /MISSING_VALUE_FOR_QUERIES/);
  assert.throws(() => parseArgs(['--vendors', '--confirm-paid-calls']), /MISSING_VALUE_FOR_VENDORS/);
  await assert.rejects(main(['--vendors', ',', '--out', dir], { env: {}, log: () => {} }), /EMPTY_VENDOR_SELECTOR/);
  let fetched = 0;
  const env = Object.fromEntries(VENDORS.map(vendor => [vendor.keyEnv, KEY]));
  const logs = [];
  await main(['--out', dir], { env, fetchImpl: async () => { fetched += 1; }, log: line => logs.push(line) });
  assert.equal(fetched, 0);
  assert.deepEqual(await filesUnder(dir), []);
  assert.ok(!logs.join('\n').includes(KEY));
}));

test('call cap stops the vendor and keeps the refusal for the remaining queries', async () => withTemp(async dir => {
  const { calls, fetchImpl } = recordingFetch(() => okBody());
  const { report } = await run(dir, { vendor: fakeVendor({ maxCalls: 1 }), fetchImpl });
  assert.equal(calls.length, 1);
  assert.deepEqual(report.vendors[0].queries.map(query => query.status), ['OK', 'BUDGET_REFUSED', 'BUDGET_REFUSED']);
  assert.equal(report.vendors[0].queries[1].reason, 'CALL_LIMIT_REACHED');
}));

test('USD cap counts worst case when no cost is reported and survives reruns', async () => withTemp(async dir => {
  const vendor = fakeVendor({ steps: query => [{ method: 'GET', url: `https://api.example.test/${query.id}`, worstCaseUsd: 0.4 }] });
  const first = recordingFetch(() => okBody());
  const { report } = await run(dir, { vendor, fetchImpl: first.fetchImpl });
  assert.equal(first.calls.length, 2);
  assert.equal(report.vendors[0].queries[2].reason, 'VENDOR_USD_LIMIT_REACHED');
  assert.equal(report.vendors[0].usage.usd, 0.8);
  const second = recordingFetch(() => okBody());
  const rerun = await run(dir, { vendor, fetchImpl: second.fetchImpl });
  assert.equal(second.calls.length, 0, 'a new process must read the persisted ledger');
  assert.equal(rerun.report.vendors[0].queries[0].status, 'BUDGET_REFUSED');
}));

test('vendor-reported cost replaces the worst-case reserve', async () => withTemp(async dir => {
  const { fetchImpl } = recordingFetch(() => okBody({ cost: 0.002 }));
  const { report, ledger } = await run(dir, { fetchImpl, qs: [queries[0]] });
  assert.equal(ledger.entries[0].chargedUsd, 0.002);
  assert.equal(ledger.entries[0].basis, 'vendor-reported');
  assert.equal(report.vendors[0].queries[0].calls[0].reportedCostUsd, 0.002);
}));

test('refusal rules: unknown price, undocumented zero price, total cap', () => {
  const ledger = { entries: [{ vendor: 'other', chargedUsd: TOTAL_CAP_USD - 0.05 }] };
  const limits = { vendorId: 'fake', maxCalls: 10, maxUsd: 1 };
  assert.equal(refusal(ledger, limits, undefined), 'PRICE_UNKNOWN');
  assert.equal(refusal(ledger, limits, 0), 'PRICE_UNKNOWN');
  assert.equal(refusal(ledger, limits, 0, { documentedFree: true }), null);
  assert.equal(refusal(ledger, limits, 0.1), 'TOTAL_USD_LIMIT_REACHED');
  assert.equal(refusal({ entries: [] }, { ...limits, maxUsd: 5 }, 1.01), 'VENDOR_USD_LIMIT_REACHED');
});

test('network errors are not retried and are booked as possibly charged', async () => withTemp(async dir => {
  const { calls, fetchImpl } = recordingFetch(() => { throw new TypeError(`fetch failed for https://x.test/?api_key=${KEY}`); });
  const { report, ledger } = await run(dir, { fetchImpl, qs: [queries[0]] });
  assert.equal(calls.length, 1);
  const query = report.vendors[0].queries[0];
  assert.equal(query.status, 'UNKNOWN');
  assert.equal(query.reason, 'NETWORK_OR_READ_ERROR');
  assert.equal(ledger.entries[0].chargedUsd, 0.1);
  assert.equal(ledger.entries[0].basis, 'estimate-worst-case');
  assert.ok(!JSON.stringify(report).includes(KEY));
}));

test('timeouts are unknown, not retried, and stop the dependent chain', async () => withTemp(async dir => {
  let dependentBuilt = false;
  const vendor = fakeVendor({
    steps: () => [{ method: 'GET', url: 'https://api.example.test/a', worstCaseUsd: 0.1 }, () => { dependentBuilt = true; return {}; }],
  });
  const { calls, fetchImpl } = recordingFetch((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const { report } = await run(dir, { vendor, fetchImpl, qs: [queries[0]] });
  assert.equal(calls.length, 1);
  assert.equal(report.vendors[0].queries[0].status, 'UNKNOWN');
  assert.equal(report.vendors[0].queries[0].reason, 'TIMEOUT');
  assert.equal(dependentBuilt, false);
}));

test('HTTP failures and in-body vendor errors are FAILED after one attempt', async () => withTemp(async dir => {
  const http = recordingFetch(() => new Response('{"error":"bad"}', { status: 500 }));
  const one = await run(dir, { fetchImpl: http.fetchImpl, qs: [queries[0]] });
  assert.equal(http.calls.length, 1);
  assert.equal(one.report.vendors[0].queries[0].status, 'FAILED');
  const vendor = fakeVendor({ id: 'fake2', isFailure: json => json.code !== 200 });
  const body = recordingFetch(() => new Response('{"code":400}', { status: 200 }));
  const two = await run(dir, { vendor, fetchImpl: body.fetchImpl, qs: [queries[0]] });
  assert.equal(body.calls.length, 1);
  assert.equal(two.report.vendors[0].queries[0].status, 'FAILED');
}));

test('keys and auth headers never reach saved files, the summary or the console', async () => withTemp(async dir => {
  const { fetchImpl } = recordingFetch(url => new Response(
    JSON.stringify({ items: [{ id: '1' }], echo: { url, token: KEY } }),
    { status: 200, headers: { 'set-cookie': `session=${KEY}`, 'x-echo': KEY } },
  ));
  const { report } = await run(dir, { fetchImpl });
  const files = await filesUnder(dir);
  assert.ok(files.some(file => file.includes(`${path.sep}raw${path.sep}`)));
  assert.ok(files.some(file => path.basename(file).startsWith('summary-')));
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    assert.ok(!content.includes(KEY), `${file} leaked the key`);
    assert.ok(!/Bearer /.test(content), `${file} kept an auth header`);
    assert.equal((await stat(file)).mode & 0o077, 0, `${file} must be owner-only`);
  }
  assert.ok(!formatReport(report).includes(KEY));
  assert.ok(!redactUrl(`https://a.test/?api_key=${KEY}&q=1`, []).includes(KEY));
}));

test('missing key means NOT_RUN without any request', async () => withTemp(async dir => {
  const { calls, fetchImpl } = recordingFetch(() => okBody());
  const { report } = await run(dir, { fetchImpl, env: {} });
  assert.equal(calls.length, 0);
  assert.ok(report.vendors[0].queries.every(query => query.status === 'NOT_RUN' && query.reason === 'MISSING_KEY'));
}));

test('missing fields are reported as not provided, never as zero', () => {
  assert.equal(count({ stats: {} }, ['stats.views']), undefined);
  assert.equal(count({ stats: { views: 0 } }, ['stats.views']), 0);
  assert.equal(count({ stats: { views: 'n/a' } }, ['stats.views']), undefined);
  assert.equal(timestamp({}, ['time']), undefined);
  assert.equal(timestamp({ time: 1_700_000_000 }, ['time']), '2023-11-14T22:13:20.000Z');
  const metrics = summarize('posts', [{ id: 'a', likes: 0 }, { id: 'b' }]);
  assert.ok(metrics.provided.includes('likes'));
  assert.ok(metrics.missing.includes('views'));
  assert.deepEqual(metrics.byField.likes, { present: 1, total: 2 });
  assert.equal(metrics.newestPublishedAt, '未提供');
});

test('raw results must stay outside the repository', () => {
  assert.throws(() => assertOutsideRepository(path.join(repositoryRoot, 'tmp')), /INSIDE_REPOSITORY/);
  assert.throws(() => assertOutsideRepository(repositoryRoot), /INSIDE_REPOSITORY/);
  assertOutsideRepository(path.join(os.homedir(), '.graylum', 'research0'));
});

test('the query set covers both regions and all three query types', () => {
  assert.equal(QUERIES.length, 10);
  assert.deepEqual(new Set(QUERIES.map(query => query.region)), new Set(['cn', 'global']));
  for (const type of ['profile', 'posts', 'keyword']) assert.ok(QUERIES.some(query => query.type === type), type);
  for (const vendor of VENDORS) {
    assert.ok((vendor.blockedReason || vendor.maxCalls > 0) && (vendor.maxUsd ?? 1) <= 1, vendor.id);
    const plan = QUERIES.flatMap(query => {
      const steps = vendor.steps(query);
      return Array.isArray(steps) ? steps.filter(step => typeof step !== 'function') : [];
    });
    const worst = plan.reduce((total, step) => total + step.worstCaseUsd, 0);
    assert.ok(worst <= (vendor.maxUsd ?? 1), `${vendor.id} planned worst case ${worst} exceeds its cap`);
    assert.ok(plan.length <= vendor.maxCalls, `${vendor.id} plans more calls than its cap`);
  }
});

test('a blocked vendor is never called even with a key and confirmation', async () => withTemp(async dir => {
  const { calls, fetchImpl } = recordingFetch(() => okBody());
  const vendor = fakeVendor({ blockedReason: 'PRICE_NOT_BOUNDABLE' });
  const { report } = await run(dir, { vendor, fetchImpl });
  assert.equal(calls.length, 0);
  assert.ok(report.vendors[0].queries.every(query => query.status === 'NOT_RUN' && query.reason === 'PRICE_NOT_BOUNDABLE'));
}));

test('free balance reads bracket the run and give the vendor-side spend', async () => withTemp(async dir => {
  let balance = 5;
  const vendor = fakeVendor({
    balance: {
      spec: () => ({ method: 'GET', url: 'https://api.example.test/balance', worstCaseUsd: 0, documentedFree: true }),
      read: json => json.balance,
    },
  });
  const { calls, fetchImpl } = recordingFetch(url => {
    if (url.endsWith('/balance')) return new Response(JSON.stringify({ balance }), { status: 200 });
    balance -= 0.25;
    return okBody();
  });
  const { report, ledger } = await run(dir, { vendor, fetchImpl, qs: [queries[0], queries[1]] });
  assert.equal(calls.length, 4);
  assert.deepEqual(report.vendors[0].balance, { beforeUsd: 5, afterUsd: 4.5, spentThisRunUsd: 0.5 });
  assert.equal(ledger.entries.filter(entry => entry.queryId.startsWith('BALANCE')).every(entry => entry.chargedUsd === 0), true);
}));

test('reanalyze recomputes metrics from saved responses without any request', async () => withTemp(async dir => {
  const live = recordingFetch(() => okBody());
  await run(dir, { fetchImpl: live.fetchImpl, qs: [queries[0]] });
  const vendor = fakeVendor({ normalize: json => json.items.map(item => ({ ...item, views: 7 })) });
  const report = await reanalyze({ vendors: [vendor], queries: [queries[0], queries[1]], outDir: dir });
  assert.equal(live.calls.length, 1);
  assert.equal(report.vendors[0].queries[0].status, 'OK');
  assert.ok(report.vendors[0].queries[0].metrics.provided.includes('views'));
  assert.equal(report.vendors[0].queries[1].status, 'NO_SAVED_RESPONSE');
  await assert.rejects(main(['--reanalyze', '--confirm-paid-calls', '--out', dir], { log: () => {} }), /OFFLINE_ONLY/);
}));

test('TikHub-shaped items keep missing counts missing and vendor zeros as zero', () => {
  const json = { code: 200, data: { aweme_list: [
    { aweme_id: '1', create_time: 1_700_000_000, desc: 'a', statistics: { digg_count: 3, play_count: 0 }, author: { unique_id: 'x' } },
    { aweme_id: '2', create_time: 1_700_000_100, statistics: { digg_count: 1 } },
  ] } };
  const items = normalizeTikhub(json, { type: 'keyword', platform: 'tiktok' });
  assert.equal(items.length, 2);
  assert.equal(items[0].views, 0);
  assert.equal(items[1].views, undefined);
  assert.equal(items[0].url, 'https://www.tiktok.com/@x/video/1');
  assert.equal(summarize('keyword', items).byField.comments.present, 0);
  assert.equal(tikhubFailed({ detail: { code: 400 } }), true);
  assert.equal(tikhubFailed(json), false);
  assert.equal(displayCount({ view_count: '343,369 views' }, ['view_count']), 343369);
  assert.equal(displayCount({ view_count: '1.2M views' }, ['view_count']), undefined);
});

test('markdown tables show missing data as not provided and never contain the key', async () => withTemp(async dir => {
  const { fetchImpl } = recordingFetch((url, init, n) => (n === 1 ? okBody({ cost: 0.002 }) : new Response('{}', { status: 502 })));
  const qs = [{ id: 'T1', platform: 'tiktok', type: 'posts' }, { id: 'T2', platform: 'tiktok', type: 'posts' }];
  const { report } = await run(dir, { fetchImpl, qs });
  const markdown = formatMarkdown(report, qs);
  assert.ok(!markdown.includes(KEY));
  assert.match(markdown, /发布时间未提供/);
  assert.match(markdown, /未提供：[^|]*views/);
  assert.match(markdown, /FAILED/);
  assert.match(markdown, /\| Fake \| OK 1, FAILED 1 \| 2 \| 1\/2 \|/);
  assert.match(markdown, /部分（1\/2）/);
}));

test('application code never imports the comparison script', () => {
  const result = spawnSync('git', ['grep', '-l', '-i', '-e', 'research0', '--', 'apps', 'packages'], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(result.status, 1, `unexpected references:\n${result.stdout}`);
});
