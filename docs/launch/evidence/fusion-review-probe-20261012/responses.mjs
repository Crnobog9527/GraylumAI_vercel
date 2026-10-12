#!/usr/bin/env node
// 用 Responses API 调 Fusion：看能否拿到工具结果原文（各评审回答、analysis、failed_models、status），
// 以及联网用量是否单独列出。用法：node responses.mjs <场景 ok|partial_fail> [tag]
// 密钥读取方式同 probe.mjs，不打印、不落盘。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reserve } from './budget.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(homedir(), '.graylum/secrets', process.env.PROBE_KEY_FILE ?? 'payg-profile.env'), 'utf8');
const KEY = raw.split('\n').find((l) => l.startsWith(`${process.env.PROBE_KEY_VAR ?? 'GRAYLUM_PAYG_TEST_OPENROUTER_KEY'}=`))
  .split('=').slice(1).join('=').trim().replace(/^"|"$/g, '');
const REPORT = readFileSync(join(HERE, 'sample-report.md'), 'utf8').replace('{{CANARY}}', 'ZX-7741-LANTERN');

const PROMPT = [
  '请调用 openrouter:fusion 工具让评审团评审下面这份报告。评审团只根据原文评审，不要联网。',
  '评审团每个模型只输出修改意见清单（JSON 数组：location/problem/suggestion/severity，最多 6 条），',
  '最后一条照抄原文最后一段里的暗号。工具返回后，你输出合并后的修改意见 JSON 数组。',
  '', '=== 报告原文开始 ===', REPORT, '=== 报告原文结束 ===',
].join('\n');

const scenario = process.argv[2] ?? 'ok';
const tag = process.argv[3] ?? '1';
const panel = scenario === 'partial_fail'
  ? ['anthropic/claude-haiku-5.5', 'nonexistent/model-xyz']
  : ['anthropic/claude-haiku-5.5', 'deepseek/deepseek-v3.2', 'qwen/qwen3.8-flash'];

// default_panel：不指定评审团，用官方默认评审团（Opus / GPT / Gemini Pro 最新版），分析模型用 Sonnet，估算真实费用
const defaultPanel = scenario === 'default_panel';
const fusionParams = defaultPanel
  ? { model: 'anthropic/claude-sonnet-5.5', max_tool_calls: 1, max_completion_tokens: 4000 }
  : { analysis_models: panel, model: 'anthropic/claude-haiku-5.5', max_tool_calls: 1, max_completion_tokens: 2000 };
const body = {
  // 外层用 Sonnet 5.5 时请求返回 400（runs/responses-default_panel-sonnet-outer-400.json），外层统一用 Haiku
  model: 'anthropic/claude-haiku-5.5',
  input: PROMPT,
  tools: [{ type: 'openrouter:fusion', parameters: fusionParams }],
  tool_choice: 'required',
  max_output_tokens: 3000,
};

// 强模型默认评审团一次约 0.14 美元（样例报告），按 0.5 美元预留；便宜评审团按 0.15 美元预留
const authHeaders = { Authorization: `Bearer ${KEY}` };
await reserve(authHeaders, process.env.PROBE_KEY_FILE ?? 'payg-profile.env', defaultPanel ? 0.5 : 0.15);
const t0 = Date.now();
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), scenario === 'client_timeout' ? 20000 : 600000);
let status = null; let json = null; let error = null;
try {
  const r = await fetch('https://openrouter.ai/api/v1/responses', {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: ctrl.signal,
  });
  status = r.status;
  const text = await r.text();
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 4000) }; }
} catch (e) { error = String(e?.name ?? e); } finally { clearTimeout(timer); }
const elapsedMs = Date.now() - t0;
mkdirSync(join(HERE, 'runs'), { recursive: true });
const file = join(HERE, 'runs', `responses-${scenario}-${tag}.json`);
const echo = { ...body, input: `<${PROMPT.length} chars>` };
writeFileSync(file, `${JSON.stringify({ scenario, tag, elapsedMs, status, error, request: echo, response: json }, null, 2)}\n`);
const types = Array.isArray(json?.output) ? json.output.map((o) => o.type) : null;
console.log(JSON.stringify({ scenario, status, error, elapsedMs, outputTypes: types, usage: json?.usage ?? null }));
