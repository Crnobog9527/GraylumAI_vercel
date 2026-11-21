#!/usr/bin/env node
// 只读复核：按链路统计 staging 真实回执的缓存读 / 写 / 全价占比（PROMPT-CACHE-ALL，Owner 2026-10-27）。
// 不连接数据库，只读取保存好的查询结果：
//
//   node scripts/prompt-cache-audit.mjs --sql [天数]            # 打印查询
//   supabase db query --linked -o json "$(node scripts/prompt-cache-audit.mjs --sql 3)" > <快照.json>
//   node scripts/prompt-cache-audit.mjs <快照.json>
//
// 压测桩的合成回执（transport.generationId 以 gen-load- 开头）单独一行，不计入真实占比。
// 目标：定位导师（phase skill）和自由对话（phase ordinary）的缓存读占输入 ≥ 50%。
import { readFile } from 'node:fs/promises';

export const TARGET_READ_SHARE = 0.5;
export const TARGET_PHASES = ['skill', 'ordinary'];

export function auditSql(days = 3) {
  const window = Number.isSafeInteger(Number(days)) && Number(days) > 0 ? Number(days) : 3;
  return `select c.model, coalesce(r.payload->>'phase', '') as phase,
  (coalesce(r.payload->'transport'->>'generationId', '') like 'gen-load-%') as loadtest,
  count(*)::int as calls,
  sum((r.payload->'usage'->>'inputTokens')::bigint)::bigint as input_tokens,
  sum(coalesce((r.payload->'usage'->>'cachedTokens')::bigint, 0))::bigint as cached_tokens,
  sum(coalesce((r.payload->'usage'->>'cacheCreationTokens')::bigint, 0))::bigint as cache_write_tokens,
  sum((r.payload->>'cost')::numeric) as cost_usd,
  count(*) filter (where coalesce((r.payload->'usage'->>'cachedTokens')::bigint, 0) = 0
    and coalesce((r.payload->'usage'->>'cacheCreationTokens')::bigint, 0) = 0)::int as calls_without_cache
from bill2_receipts r join bill2_calls c on c.id = r.call_id
where r.created_at > now() - interval '${window} days' and r.payload->>'final' = 'true'
  and r.payload->'usage'->>'inputTokens' is not null
group by 1, 2, 3 order by cost_usd desc`;
}

export function parseSnapshot(text) {
  const arrayStart = text.indexOf('[');
  const objectStart = text.indexOf('{');
  const data = arrayStart !== -1 && (objectStart === -1 || arrayStart < objectStart)
    ? JSON.parse(text.slice(arrayStart, text.lastIndexOf(']') + 1))
    : JSON.parse(text.slice(objectStart, text.lastIndexOf('}') + 1));
  const rows = Array.isArray(data) ? data : data.rows;
  if (!Array.isArray(rows)) throw new Error('快照里没有 rows 列表');
  return rows.map((row) => ({
    model: String(row.model ?? ''), phase: String(row.phase ?? ''),
    loadtest: row.loadtest === true || row.loadtest === 'true' || row.loadtest === 't',
    calls: Number(row.calls ?? 0), inputTokens: Number(row.input_tokens ?? 0),
    cachedTokens: Number(row.cached_tokens ?? 0), cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
    costUsd: Number(row.cost_usd ?? 0), callsWithoutCache: Number(row.calls_without_cache ?? 0),
  }));
}

const share = (part, whole) => (whole > 0 ? part / whole : 0);

/** One line per real (non-load-test) model × phase, plus the load-test total, plus the verdict per target phase. */
export function summarize(rows) {
  const real = rows.filter((row) => !row.loadtest);
  const loadtest = rows.filter((row) => row.loadtest);
  const lines = real.map((row) => ({
    model: row.model, phase: row.phase, calls: row.calls, inputTokens: row.inputTokens, costUsd: row.costUsd,
    readShare: share(row.cachedTokens, row.inputTokens), writeShare: share(row.cacheWriteTokens, row.inputTokens),
    fullPriceShare: share(row.inputTokens - row.cachedTokens - row.cacheWriteTokens, row.inputTokens),
    callsWithoutCache: row.callsWithoutCache,
  }));
  const verdicts = TARGET_PHASES.map((phase) => {
    const anthropic = real.filter((row) => row.phase === phase && row.model.startsWith('anthropic/'));
    const input = anthropic.reduce((sum, row) => sum + row.inputTokens, 0);
    const cached = anthropic.reduce((sum, row) => sum + row.cachedTokens, 0);
    return { phase, calls: anthropic.reduce((sum, row) => sum + row.calls, 0), readShare: share(cached, input),
      pass: input > 0 && share(cached, input) >= TARGET_READ_SHARE };
  });
  const excluded = { calls: loadtest.reduce((sum, row) => sum + row.calls, 0),
    costUsd: loadtest.reduce((sum, row) => sum + row.costUsd, 0) };
  return { lines, verdicts, excluded };
}

export function render(summary) {
  const pct = (value) => `${(value * 100).toFixed(1)}%`;
  const out = ['模型 | 阶段 | 次数 | 输入 token | 读占比 | 写占比 | 全价占比 | 无缓存次数 | 花费 USD'];
  for (const line of summary.lines) {
    out.push([line.model, line.phase || '(空)', line.calls, line.inputTokens, pct(line.readShare), pct(line.writeShare),
      pct(line.fullPriceShare), line.callsWithoutCache, line.costUsd.toFixed(2)].join(' | '));
  }
  out.push('');
  for (const verdict of summary.verdicts) {
    out.push(`${verdict.phase}（Anthropic，${verdict.calls} 次）：缓存读占输入 ${pct(verdict.readShare)}，目标 ≥ ${pct(TARGET_READ_SHARE)}：${verdict.pass ? '达标' : '未达标'}`);
  }
  out.push(`已排除压测桩合成回执：${summary.excluded.calls} 次，标称 ${summary.excluded.costUsd.toFixed(2)} USD（不是真实花费）`);
  return out.join('\n');
}

async function main(argv) {
  if (argv[0] === '--sql') { console.log(auditSql(argv[1])); return 0; }
  if (!argv[0]) { console.error('用法：node scripts/prompt-cache-audit.mjs --sql [天数] | <快照.json>'); return 2; }
  const summary = summarize(parseSnapshot(await readFile(argv[0], 'utf8')));
  console.log(render(summary));
  return summary.verdicts.every((verdict) => verdict.pass) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = await main(process.argv.slice(2));
}
