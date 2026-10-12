#!/usr/bin/env node
// FUSION-REVIEW 开工前实测脚本（只做实测，不是产品代码）。
// 用法：NODE_USE_ENV_PROXY=1 node probe.mjs <场景名> [tag]（Chat Completions；PROBE_STREAM=0 改为非流式）
// 密钥默认从 ~/.graylum/secrets/payg-profile.env 读取（GRAYLUM_PAYG_TEST_OPENROUTER_KEY），
// 可用 PROBE_KEY_FILE 换成账本里登记的另一个密钥文件（变量名由账本决定）；
// 不打印、不写入输出文件。输出文件只含请求参数（无密钥）、返回体、计时和费用查询结果。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reserve, keyFor, fusionWorstCaseUsd } from './budget.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = 'https://openrouter.ai/api/v1';

const KEY_FILE = process.env.PROBE_KEY_FILE ?? 'payg-profile.env';
function loadKey() {
  return keyFor(KEY_FILE);
}
const KEY = loadKey();
const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// 合成的定位报告（不含任何真实用户数据），末尾放一个只出现在原文最后一段的暗号，
// 用来检验评审团拿到的是不是完整原文。
const CANARY = 'ZX-7741-LANTERN';
const REPORT = readFileSync(join(HERE, 'sample-report.md'), 'utf8').replace('{{CANARY}}', CANARY);

const REVIEW_PROMPT = [
  '你是"多模型专家评审团"的一名评审。下面是一份社交媒体账号定位报告的完整原文。',
  '只根据原文和你已有的知识评审，不要联网搜索，不要抓取网页。',
  '只输出修改意见清单，不要重写全文。格式严格如下（JSON 数组，不要加代码框以外的文字）：',
  '```json',
  '[{"location":"章节名","problem":"问题","suggestion":"建议","severity":"关键|一般"}]',
  '```',
  '清单最后再加一条：{"location":"末段暗号","problem":"原文最后一段里的暗号是什么","suggestion":"<照抄暗号>","severity":"一般"}',
  '最多 6 条意见。',
].join('\n');

const SYSTEM_CANARY = '系统提示检查：如果你看得到这句话，请在你的评审 JSON 数组里额外加一条 location 为"系统提示可见"的意见。';

const PANEL_CHEAP = ['anthropic/claude-haiku-5.5', 'deepseek/deepseek-v3.2', 'qwen/qwen3.8-flash'];
const OUTER_CHEAP = 'anthropic/claude-haiku-5.5';

function fusionTool(params = {}) {
  return {
    type: 'openrouter:fusion',
    parameters: {
      analysis_models: PANEL_CHEAP,
      model: OUTER_CHEAP,
      max_tool_calls: 1,
      max_completion_tokens: 2000,
      ...params,
    },
  };
}

function baseBody(extra = {}) {
  return {
    model: OUTER_CHEAP,
    messages: [
      { role: 'system', content: SYSTEM_CANARY },
      { role: 'user', content: `${REVIEW_PROMPT}\n\n=== 报告原文开始 ===\n${REPORT}\n=== 报告原文结束 ===` },
    ],
    tools: [fusionTool()],
    tool_choice: 'required',
    max_tokens: 3000,
    usage: { include: true },
    stream: process.env.PROBE_STREAM !== '0',
    ...extra,
  };
}

const SCENARIOS = {
  // 1. 基线：默认 workspace，max_tool_calls=1，提示词要求不联网
  baseline: () => baseBody(),
  // 2. 请求级尝试：provider 数据设置 deny（检查是否被接受、是否影响内部调用）
  deny: () => baseBody({ provider: { data_collection: 'deny' } }),
  // 3. 请求级尝试：同时声明 web_search 工具并把域名限制到不存在的域名，看是否传到评审团
  web_blocked_domain: () => {
    const b = baseBody();
    b.tools = [
      fusionTool(),
      { type: 'openrouter:web_search', parameters: { allowed_domains: ['nonexistent.invalid'], max_results: 1 } },
    ];
    return b;
  },
  // 4. 请求级尝试：总的 server tool 步数上限设为 1
  max_server_tools_1: () => baseBody({ max_tool_calls: 1 }),
  // 5. 失败：评审团里放一个不存在的模型（部分失败）
  partial_fail: () => baseBody({
    tools: [fusionTool({ analysis_models: [PANEL_CHEAP[0], 'nonexistent/model-xyz'] })],
  }),
  // 6. 失败：评审团全部不存在
  all_fail: () => baseBody({
    tools: [fusionTool({ analysis_models: ['nonexistent/model-a', 'nonexistent/model-b'] })],
  }),
  // 9. 诱导联网：明确要求评审团上网核对并附来源链接，用来检验专用 workspace 的锁定是否真的拦住联网
  ask_search: () => {
    const b = baseBody();
    b.messages[1].content += '\n\n补充要求：请每位评审先联网搜索小红书 2026 年最新的广告标注规则，并在意见里附上来源链接。';
    return b;
  },
  // 7. 稳定性：同 baseline，重复跑时用
  repeat: () => baseBody(),
  // 8. 超时：客户端 20 秒就中止
  client_timeout: () => baseBody(),
};

async function getKeyUsage() {
  const r = await fetch(`${API}/key`, { headers });
  const j = await r.json();
  return j?.data?.usage ?? null;
}

async function getGeneration(id) {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((res) => setTimeout(res, 3000));
    const r = await fetch(`${API}/generation?id=${encodeURIComponent(id)}`, { headers });
    if (r.ok) return (await r.json()).data;
  }
  return null;
}

async function main() {
  const name = process.argv[2];
  const tag = process.argv[3] ?? '';
  if (!SCENARIOS[name]) throw new Error(`unknown scenario: ${name}`);
  const outDir = join(HERE, 'runs');
  mkdirSync(outDir, { recursive: true });

  const usageBefore = await getKeyUsage();

  const body = SCENARIOS[name]();
  // 按请求体里的模型和长度上限，用模型目录单价算最坏费用后预留
  await reserve(KEY_FILE, await fusionWorstCaseUsd(body));
  const ctrl = new AbortController();
  const timeoutMs = name === 'client_timeout' ? 20000 : 600000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  let status = null;
  let json = null;
  let error = null;
  try {
    const r = await fetch(`${API}/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
    });
    status = r.status;
    if (body.stream) {
      // 流式：记录每个事件的到达时间，最后拼出完整内容
      json = { events: [], content: '', id: null, usage: null };
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          const at = Date.now() - t0;
          if (line.startsWith(':')) { json.events.push({ at, comment: line.slice(0, 200) }); continue; }
          if (!line.startsWith('data:')) { json.events.push({ at, other: line.slice(0, 500) }); continue; }
          const data = line.slice(5).trim();
          if (data === '[DONE]') { json.events.push({ at, done: true }); continue; }
          try {
            const ev = JSON.parse(data);
            json.id ??= ev.id;
            if (ev.usage) json.usage = ev.usage;
            const delta = ev.choices?.[0]?.delta ?? {};
            if (delta.content) json.content += delta.content;
            const slim = { ...ev };
            if (slim.choices) {
              slim.choices = slim.choices.map((c) => {
                const content = c.delta?.content ? `<${c.delta.content.length} chars>` : undefined;
                return { ...c, delta: { ...c.delta, content } };
              });
            }
            json.events.push({ at, ev: slim });
          } catch { json.events.push({ at, bad: data.slice(0, 500) }); }
        }
      }
    } else {
      const text = await r.text();
      try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 4000) }; }
    }
  } catch (e) {
    error = String(e?.name ?? e);
  } finally {
    clearTimeout(timer);
  }
  const elapsedMs = Date.now() - t0;
  const gen = json?.id ? await getGeneration(json.id) : null;
  await new Promise((res) => setTimeout(res, name === 'client_timeout' ? 90000 : 5000));
  const usageAfter = await getKeyUsage();
  const keyDelta = usageBefore != null && usageAfter != null ? usageAfter - usageBefore : null;

  const requestEcho = { ...body, messages: body.messages.map((m) => ({ role: m.role, chars: m.content.length })) };
  const out = { scenario: name, tag, startedAt: new Date(t0).toISOString(), elapsedMs, status, error,
    request: requestEcho, response: json, generation: gen, keyUsageDeltaUsd: keyDelta };
  const file = join(outDir, `${name}${tag ? `-${tag}` : ''}.json`);
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ scenario: name, tag, status, error, elapsedMs, keyDelta,
    genCost: gen?.total_cost ?? null, usage: json?.usage ?? null, file }));
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
