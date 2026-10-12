// 所有付费调用共用的预算闸门（失败即拒绝）。
// - 已花费用记在入库的 budget-ledger.json（本任务上限 2 美元，已花 0.63 美元）。
// - 必须显式设 PROBE_ALLOW_SPEND=1 才会发出任何付费请求。
// - 每次调用前先按"最坏估算"登记预留额，并用 OpenRouter /key 的实际用量核对；
//   本次会话的实际花费和预留额取较大值，加上已记录的花费，超过上限就拒绝。
// - 会话状态写在 runs/.session.json（不入库）；跑完后把实际花费手动加进 budget-ledger.json。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER = join(HERE, 'budget-ledger.json');
const SESSION = join(HERE, 'runs', '.session.json');
const API = 'https://openrouter.ai/api/v1';

async function keyUsage(headers) {
  const r = await fetch(`${API}/key`, { headers });
  if (!r.ok) throw new Error(`budget: cannot read key usage (${r.status})`);
  const usage = (await r.json())?.data?.usage;
  if (typeof usage !== 'number') throw new Error('budget: key usage missing');
  return usage;
}

// 预留一次调用的最坏费用；不够就抛错，调用方不能发请求。
export async function reserve(headers, keyName, estUsd) {
  if (process.env.PROBE_ALLOW_SPEND !== '1') throw new Error('budget: set PROBE_ALLOW_SPEND=1 to run paid probes');
  if (!(estUsd > 0)) throw new Error('budget: estimate required');
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
