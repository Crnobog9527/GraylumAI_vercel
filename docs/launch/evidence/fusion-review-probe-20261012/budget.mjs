// 所有付费调用共用的预算闸门（失败即拒绝）。
// - 入库的 budget-ledger.json 记着本任务上限，以及每个测试密钥在任务开始时的累计用量（基线）。
// - 已花费用 = 各密钥"当前累计用量 - 基线"之和，每次都从 OpenRouter /key 现查，不依赖本机文件，
//   所以换工作副本或删掉本机文件都不会忘记已花的钱。密钥上别的任务的花费也会算进来，只会更保守。
// - 必须显式设 PROBE_ALLOW_SPEND=1 才会发出任何付费请求。
// - 正在进行、还没反映到用量里的调用，按"最坏估算"登记预留额，15 分钟后过期（调用最长 10 分钟）。
// - 已花 + 未过期预留 + 本次估算超过上限就拒绝。读取、核对、写入都在跨进程锁内完成。
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER = join(HERE, 'budget-ledger.json');
const SESSION = join(HERE, 'runs', '.session.json');
const LOCK = join(HERE, 'runs', '.session.lock');
const API = 'https://openrouter.ai/api/v1';
const RESERVATION_TTL_MS = 15 * 60 * 1000;

function loadKey(file, varName) {
  const raw = readFileSync(join(homedir(), '.graylum/secrets', file), 'utf8');
  const line = raw.split('\n').find((l) => l.startsWith(`${varName}=`));
  if (!line) throw new Error(`budget: ${varName} missing in ${file}`);
  return line.slice(line.indexOf('=') + 1).trim().replace(/^"|"$/g, '');
}

async function keyUsage(key) {
  const r = await fetch(`${API}/key`, { headers: { Authorization: `Bearer ${key}` } });
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

// 预留一次调用的最坏费用；不够就抛错，调用方不能发请求。keyName 必须是账本里登记过的密钥文件。
export async function reserve(_headers, keyName, estUsd) {
  if (process.env.PROBE_ALLOW_SPEND !== '1') throw new Error('budget: set PROBE_ALLOW_SPEND=1 to run paid probes');
  if (!(estUsd > 0)) throw new Error('budget: estimate required');
  return withLock(() => reserveLocked(keyName, estUsd));
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

async function reserveLocked(keyName, estUsd) {
  const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
  if (!ledger.keys?.[keyName]) throw new Error(`budget: key file not registered in ledger: ${keyName}`);
  let spent = 0;
  for (const [file, k] of Object.entries(ledger.keys)) {
    spent += (await keyUsage(loadKey(file, k.var))) - k.usageBaseline;
  }
  const now = Date.now();
  const session = existsSync(SESSION) ? JSON.parse(readFileSync(SESSION, 'utf8')) : { reservations: [] };
  session.reservations = (session.reservations ?? []).filter((x) => now - x.at < RESERVATION_TTL_MS);
  const reserved = session.reservations.reduce((sum, x) => sum + x.usd, 0);
  if (spent + reserved + estUsd > ledger.taskLimitUsd) {
    const total = (spent + reserved).toFixed(3);
    throw new Error(`budget: refused (spent+reserved ~${total} + est ${estUsd.toFixed(3)} > limit ${ledger.taskLimitUsd})`);
  }
  session.reservations.push({ at: now, usd: estUsd, key: keyName });
  mkdirSync(dirname(SESSION), { recursive: true });
  writeFileSync(SESSION, `${JSON.stringify(session, null, 2)}\n`);
}
