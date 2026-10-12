#!/usr/bin/env node
// 汇总修订调用的输出格式实测："修订后全文 + 各步骤建议字段值"能否稳定拿到。
// 用法：node summarize.mjs <模式 schema|text> <模型> <次数>
// 密钥读取方式同 probe.mjs，不打印、不落盘。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reserve, keyFor, worstCaseUsd, REQUEST_TIMEOUT_MS } from './budget.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 密钥只能按账本登记的变量名取；PROBE_KEY_FILE 只能选账本里登记过的密钥文件
const KEY_FILE = process.env.PROBE_KEY_FILE ?? 'payg-profile.env';
const KEY = keyFor(KEY_FILE);

const REPORT = readFileSync(join(HERE, 'sample-report.md'), 'utf8').replace('{{CANARY}}', 'ZX-7741-LANTERN');
// 评审意见取自 baseline 实测的合并清单（runs/baseline-1.json 外层回答末尾）
const base = JSON.parse(readFileSync(join(HERE, 'runs', 'baseline-1.json'), 'utf8'));
const merged = base.response.content.slice(base.response.content.lastIndexOf('```json'));

// 合成的步骤字段（模仿定位 Skill 的分步字段，不是正式 Skill 的定义）
const MAX_TOKENS = 8000;

const STEPS = [
  { id: 'audience', fields: ['primary_audience', 'secondary_audience', 'pain_points'] },
  { id: 'positioning', fields: ['one_liner', 'content_pillars'] },
  { id: 'differentiation', fields: ['differentiator', 'benchmarks_needed'] },
  { id: 'monetization', fields: ['stages'] },
  { id: 'cadence', fields: ['weekly_plan'] },
  { id: 'goals', fields: ['day90_targets'] },
];

const SCHEMA = {
  name: 'revision_with_fields',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['revised_report', 'steps'],
    properties: {
      revised_report: { type: 'string', description: '修订后的报告全文（Markdown）' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['step_id', 'changed', 'fields'],
          properties: {
            step_id: { type: 'string', enum: STEPS.map((s) => s.id) },
            changed: { type: 'boolean' },
            fields: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['field', 'value'],
                properties: { field: { type: 'string' }, value: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
};

const INSTR = [
  '你是评审团的汇总模型。根据评审意见修订报告，要求：',
  '1. 写出修订后的报告全文（保留原有章节结构）。',
  '2. 同时按步骤给出建议的字段值。步骤和字段如下（每个步骤都要出现，字段名必须完全一致）：',
  ...STEPS.map((s) => `- ${s.id}: ${s.fields.join(', ')}`),
  '字段值是写入该步骤的最终文字；列表类字段用"；"分隔写成一个字符串。没有改动的步骤 changed=false，字段仍填当前值。',
].join('\n');

const TEXT_FORMAT = [
  '输出格式严格如下，不要输出其他内容：',
  '<<<REPORT>>>',
  '（修订后全文）',
  '<<<FIELDS>>>',
  '```json',
  '{"steps":[{"step_id":"audience","changed":true,"fields":[{"field":"primary_audience","value":"..."}]}]}',
  '```',
].join('\n');

function validate(obj) {
  const errs = [];
  if (typeof obj?.revised_report !== 'string' || obj.revised_report.length < 500) errs.push('report_missing_or_short');
  if (!obj?.revised_report?.includes('ZX-7741-LANTERN')) errs.push('canary_dropped');
  for (const s of STEPS) {
    const got = obj?.steps?.find((x) => x.step_id === s.id);
    if (!got) { errs.push(`step_missing:${s.id}`); continue; }
    for (const f of s.fields) {
      const v = got.fields?.find((x) => x.field === f);
      if (!v || typeof v.value !== 'string' || !v.value.trim()) errs.push(`field_missing:${s.id}.${f}`);
    }
  }
  return errs;
}

function parseText(content) {
  const a = content.indexOf('<<<REPORT>>>');
  const b = content.indexOf('<<<FIELDS>>>');
  if (a < 0 || b < 0) return null;
  const report = content.slice(a + 12, b).trim();
  const m = content.slice(b).match(/```json\s*([\s\S]*?)```/) ?? [null, content.slice(b + 12)];
  try { return { revised_report: report, ...JSON.parse(m[1]) }; } catch { return null; }
}

async function once(mode, model, i) {
  const user = `${INSTR}\n\n${mode === 'text' ? TEXT_FORMAT : ''}\n\n=== 原报告 ===\n${REPORT}\n\n=== 评审意见（合并清单） ===\n${merged}`;
  const body = { model, messages: [{ role: 'user', content: user }], max_tokens: MAX_TOKENS, usage: { include: true } };
  if (mode === 'schema') body.response_format = { type: 'json_schema', json_schema: SCHEMA };
  const t0 = Date.now();
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const j = await r.json();
  const content = j?.choices?.[0]?.message?.content ?? '';
  let obj = null;
  if (mode === 'schema') { try { obj = JSON.parse(content); } catch { obj = null; } } else obj = parseText(content);
  const errs = obj ? validate(obj) : ['parse_failed'];
  return { i, status: r.status, ms: Date.now() - t0, cost: j?.usage?.cost ?? null,
    finish: j?.choices?.[0]?.finish_reason ?? null, provider: j?.provider ?? null,
    out_tokens: j?.usage?.completion_tokens ?? null, ok: errs.length === 0, errs, error: j?.error?.message ?? null,
    report_chars: obj?.revised_report?.length ?? null };
}

const [mode, model, nStr] = process.argv.slice(2);
if (mode !== 'schema' && mode !== 'text') throw new Error('mode must be schema or text');
const n = Number(nStr ?? 3);
if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error('count must be 1–5');
// 按所选模型的目录单价算最坏费用（输入字符数 + max_tokens 用满），逐次预留；全部预留成功后才并发发出
const promptChars = INSTR.length + TEXT_FORMAT.length + REPORT.length + merged.length + 200;
const est = await worstCaseUsd(model, promptChars, MAX_TOKENS);
for (let i = 0; i < n; i += 1) await reserve(KEY_FILE, est);
const results = await Promise.all(Array.from({ length: n }, (_, i) => once(mode, model, i)));
mkdirSync(join(HERE, 'runs'), { recursive: true });
const file = join(HERE, 'runs', `summarize-${mode}-${model.replace(/\W+/g, '_')}.json`);
writeFileSync(file, `${JSON.stringify({ mode, model, at: new Date().toISOString(), results }, null, 2)}\n`);
console.log(JSON.stringify(results.map(({ i, status, ms, cost, ok, errs, finish }) => ({ i, status, ms, cost, ok, errs, finish }))));
