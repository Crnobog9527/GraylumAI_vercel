#!/usr/bin/env node
// 用 Responses API 调 Fusion：看能否拿到工具结果原文（各评审回答、analysis、failed_models、status），
// 以及联网用量是否单独列出。用法：node responses.mjs <场景 ok|partial_fail> [tag]
// 密钥读取方式同 probe.mjs，不打印、不落盘。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reserve, keyFor, fusionWorstCaseUsd, REQUEST_TIMEOUT_MS } from './budget.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 密钥只能按账本登记的变量名取；PROBE_KEY_FILE 只能选账本里登记过的密钥文件
const KEY_FILE = process.env.PROBE_KEY_FILE ?? 'payg-profile.env';
const KEY = keyFor(KEY_FILE);
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

// default_panel：不指定评审团，用官方默认评审团（Opus / GPT / Gemini Pro 最新版），分析模型用 Sonnet，估算真实费用。
// 评审团是动态的、价格无法预先确定，预算闸门会拒绝这个场景；2026-10-12 的结果已保存在 runs/responses-default_panel-2.json。
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

// 按请求体里的模型和长度上限，用模型目录单价算最坏费用后预留；动态默认评审团会被拒绝
await reserve(KEY_FILE, await fusionWorstCaseUsd(body));
const t0 = Date.now();
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), scenario === 'client_timeout' ? 20000 : REQUEST_TIMEOUT_MS);
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
