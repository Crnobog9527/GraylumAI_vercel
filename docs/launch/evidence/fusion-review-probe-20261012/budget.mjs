// 所有付费调用共用的预算闸门（失败即拒绝）。
// - 已花费用记在入库的 budget-ledger.json（本任务上限 2 美元，已花费用见该文件）。
// - 必须显式设 PROBE_ALLOW_SPEND=1 才会发出任何付费请求。
// - 每次调用前先按"最坏估算"登记预留额，并用 OpenRouter /key 的实际用量核对；
//   本次会话的实际花费和预留额取较大值，加上已记录的花费，超过上限就拒绝。
// - 会话状态写在 runs/.session.json（不入库）；跑完后把实际花费手动加进 budget-ledger.json。
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER = join(HERE, 'budget-ledger.json');
const SESSION = join(HERE, 'runs', '.session.json');
const LOCK = join(HERE, 'runs', '.session.lock');
const API = 'https://openrouter.ai/api/v1';

async function keyUsage(headers) {
  const r = await fetch(`${API}/key`, { headers });
  if (!r.ok) throw new Error(`budget: cannot read key usage (${r.status})`);
  const usage = (await r.json())?.data?.usage;
  if (typeof usage !== 'number') throw new Error('budget: key usage missing');
  return usage;
}

// 跨进程互斥：mkdir 是原子操作，拿不到锁就等，最多 2 分钟，超时拒绝。
async function withLock(fn) {
  mkdirSync(dirname(LOCK), { recursive: true });
  const deadline = Date.now() + 120000;
  for (;;) {
    try { mkdirSync(LOCK); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() > deadline) throw new Error(`budget: lock busy (${LOCK}); remove it if no probe is running`);
      await new Promise((res) => setTimeout(res, 500));
    }
  }
  try { return await fn(); } finally { rmdirSync(LOCK); }
}

// 预留一次调用的最坏费用；不够就抛错，调用方不能发请求。读取、核对、写入都在锁内完成。
export async function reserve(headers, keyName, estUsd) {
  if (process.env.PROBE_ALLOW_SPEND !== '1') throw new Error('budget: set PROBE_ALLOW_SPEND=1 to run paid probes');
  if (!(estUsd > 0)) throw new Error('budget: estimate required');
  return withLock(() => reserveLocked(headers, keyName, estUsd));
}

// 按模型目录里的单价算一次调用的最坏费用：输入按字符数当 token 数（中文 1 字不超过约 1 个 token，偏保守），
// 输出按 max_tokens 全部用满。模型不在目录里就拒绝。
export async function worstCaseUsd(model, inputChars, maxOutputTokens) {
  const r = await fetch(`${API}/models`);
  if (!r.ok) throw new Error(`budget: cannot read model catalog (${r.status})`);
  const m = (await r.json()).data.find((x) => x.id === model);
  if (!m) throw new Error(`budget: model not in catalog: ${model}`);
  const inPrice = Number(m.pricing?.prompt);
  const outPrice = Number(m.pricing?.completion);
  if (!(inPrice >= 0) || !(outPrice >= 0)) throw new Error(`budget: price missing for ${model}`);
  return inputChars * inPrice + maxOutputTokens * outPrice;
}

async function reserveLocked(headers, keyName, estUsd) {
  const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
  mkdirSync(dirname(SESSION), { recursive: true });
  const session = existsSync(SESSION) ? JSON.parse(readFileSync(SESSION, 'utf8')) : {};
  const now = await keyUsage(headers);
  session[keyName] ??= { usageAtStart: now, reservedUsd: 0 };
  const actual = Object.entries(session).reduce((sum, [name, s]) => sum + (name === keyName ? now - s.usageAtStart : s.lastDelta ?? 0), 0);
  const reserved = Object.values(session).reduce((sum, s) => sum + s.reservedUsd, 0);
  const spent = ledger.recordedSpendUsd + Math.max(actual, reserved);
  if (spent + estUsd > ledger.taskLimitUsd) {
    throw new Error(`budget: refused (spent ~${spent.toFixed(3)} + est ${estUsd} > limit ${ledger.taskLimitUsd})`);
  }
  session[keyName].reservedUsd += estUsd;
  session[keyName].lastDelta = now - session[keyName].usageAtStart;
  writeFileSync(SESSION, `${JSON.stringify(session, null, 2)}\n`);
}
