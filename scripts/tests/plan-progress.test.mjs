import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parsePlan } from '../plan-progress/parse-plan.mjs';
import { derive, isPlanTitle, namesInBody, namesInTitle } from '../plan-progress/derive.mjs';
import { renderMarkdown } from '../plan-progress/render.mjs';
import { renderHtml } from '../plan-progress/render-html.mjs';
import { buildStations } from '../plan-progress/stations.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(repoRoot, 'scripts/plan-progress.mjs');
const template = join(repoRoot, 'scripts/plan-progress/page.html');

const PLAN = `# 测试规划

> 整理日期：2026-09-27

### 7.1 阶段和任务

| 阶段 | 任务 | 内容 | 依赖 | 风险 | 规模 / 预计 PR | 标注 |
| --- | --- | --- | --- | --- | --- | --- |
| **0 马上** | CORE-A | 第一个任务 | — | 高 | 小 | 完成：不含正式环境部分 |
| | CORE-A-UI | 前端 | CORE-A | 普通 | 小 | — |
| **1 下一步** | PAY-BASE → PAY-WAFFO | 钱路线 | CORE-A；#12 | 高 | 大 | — |
| | MOD | 暂缓 | — | 高 | 待定 | 阻塞：Owner 决定暂缓 |
| | OLD-TRY | 放弃 | — | 高 | — | 关闭：Owner 决定不做 |
| | LIB-EXT（资料库扩展） | 以后 | CORE-A-UI | 高 | 大 | — |

### 7.7 历史 PR 对照

| 任务 | PR |
| --- | --- |
| CORE-A | #10 |
| PAY-BASE | #11（方案） |
`;

const STATIONS = {
  stations: [
    { id: 'base', name: '地基', plain: '先打地基。', tasks: [{ name: 'CORE-A', plain: '第一件事。', doneNote: '还差美国实测。' }, { name: 'OLD-TRY', plain: '放弃的事。' }] },
    { id: 'ui', name: '界面', plain: '界面好用。', tasks: [{ name: 'CORE-A-UI', plain: '卡片。' }] },
    {
      id: 'pay',
      name: '付费',
      plain: '能付钱。',
      tasks: [{ name: 'PAY-BASE', plain: '公共部分。' }, { name: 'PAY-WAFFO', plain: '接 Waffo。' }],
      waitingForOwner: [{ task: 'PAY-WAFFO', text: '等你：开通 Waffo 商户。' }],
    },
    { id: 'end', name: '正式上线', plain: '上线。', terminal: true, tasks: [{ name: 'MOD', plain: '审核。' }] },
    { id: 'later', name: '更多格式', plain: '以后再说。', afterLaunch: true, tasks: [{ name: 'LIB-EXT', plain: '更多格式。' }] },
  ],
};

const pr = (number, title, extra = {}) => ({
  number,
  title,
  body: '',
  state: 'MERGED',
  isDraft: false,
  mergedAt: '2026-10-01T00:00:00Z',
  url: `https://example.test/pull/${number}`,
  baseRefName: 'staging',
  ...extra,
});

const PRS = [
  pr(10, 'fix: 第一个'),
  pr(11, 'docs: 钱路线设计'),
  pr(12, 'chore: 前置'),
  pr(13, 'feat(core-a-ui): 卡片（ordinary）', { state: 'OPEN', mergedAt: null, isDraft: true }),
  pr(14, 'fix(web): 顺手修的 bug'),
  pr(15, 'docs(plan): 同步规划'),
  pr(16, 'feat(api): 支付</script><b>x</b>', { body: '说明\n任务：PAY-BASE\n' }),
  pr(17, 'fix: 很早以前', { mergedAt: '2026-09-01T00:00:00Z' }),
  pr(19, 'fix(OLD-TRY): 同步到 main', { baseRefName: 'main' }),
];

test('parsePlan 读出任务名、阶段、依赖和标注', () => {
  const plan = parsePlan(PLAN);
  assert.deepEqual(plan.phases, ['0 马上', '1 下一步']);
  assert.deepEqual(plan.tasks.map((task) => task.name), ['CORE-A', 'CORE-A-UI', 'PAY-BASE', 'PAY-WAFFO', 'MOD', 'OLD-TRY', 'LIB-EXT']);
  const byName = Object.fromEntries(plan.tasks.map((task) => [task.name, task]));
  assert.deepEqual(byName['CORE-A-UI'].deps, ['CORE-A']);
  assert.deepEqual(byName['PAY-WAFFO'].deps, ['PAY-BASE', 'CORE-A']);
  assert.deepEqual(byName['PAY-BASE'].depPrs, [12]);
  assert.equal(byName.MOD.annotation.kind, '阻塞');
  assert.equal(plan.planSince, '2026-09-27');
  assert.deepEqual(plan.history.get('PAY-BASE'), [{ number: 11, plan: true }]);
});

test('parsePlan 拒绝不规范的任务名和标注', () => {
  assert.throws(() => parsePlan(PLAN.replace('| MOD |', '| 内容审核 |')), /不是规范任务名/);
  assert.throws(() => parsePlan(PLAN.replace('阻塞：Owner 决定暂缓', '进行中')), /无法识别/);
  assert.throws(() => parsePlan(PLAN.replace('| CORE-A | #10 |', '| NOPE | #10 |')), /不在任务表里/);
  assert.throws(() => parsePlan(PLAN.replace('| MOD |', '| CORE-A |')), /不止一次/);
});

test('标题匹配：大写任务名或约定式范围，前缀相同的名字不会误配', () => {
  const names = ['CORE-A-UI', 'CORE-A', 'PAY-BASE'];
  assert.deepEqual(namesInTitle('feat(core-a-ui): 卡片', names), ['CORE-A-UI']);
  assert.deepEqual(namesInTitle('fix: CORE-A-UI 修复', names), ['CORE-A-UI']);
  assert.deepEqual(namesInTitle('fix: CORE-A2 不是任务', names), []);
  assert.deepEqual(namesInTitle('fix: core-a 小写正文不算', names), []);
  assert.deepEqual(namesInBody('背景提到 PAY-BASE\n任务：CORE-A、PAY-BASE', names), ['CORE-A', 'PAY-BASE']);
  assert.equal(isPlanTitle('docs(x): 实施方案（high，仅方案）'), true);
  assert.equal(isPlanTitle('feat(runtime): 预算（方案待审）'), false);
});

test('derive 推导阶段、阻塞原因和计划外工作', () => {
  const report = derive({ plan: parsePlan(PLAN), prs: PRS, since: '2026-09-27', generatedAt: 'T', sourceRef: 'test' });
  const status = Object.fromEntries(report.tasks.map((task) => [task.name, task]));
  assert.equal(status['CORE-A'].status, '已完成');
  assert.equal(status['CORE-A'].reason, '不含正式环境部分');
  assert.deepEqual(status['OLD-TRY'].prs, []);
  assert.equal(status['CORE-A-UI'].status, '实施中');
  assert.equal(status['PAY-BASE'].status, '实施中');
  assert.deepEqual(status['PAY-BASE'].prs.map((item) => [item.number, item.plan]), [[11, true], [16, false]]);
  assert.equal(status['PAY-WAFFO'].status, '被阻塞');
  assert.match(status['PAY-WAFFO'].reason, /PAY-BASE（实施中）/);
  assert.equal(status['PAY-WAFFO'].blockedBy, 'deps');
  assert.equal(status.MOD.blockedBy, 'owner');
  assert.match(status['LIB-EXT'].reason, /CORE-A-UI（实施中）/);
  assert.equal(status.MOD.status, '被阻塞');
  assert.equal(status['OLD-TRY'].status, '已关闭');
  assert.equal(status['LIB-EXT'].status, '被阻塞');
  assert.deepEqual(report.unplanned.map((item) => [item.number, item.planDoc]), [[15, true], [14, false], [12, false]]);
  assert.equal(report.total, 6);
  assert.equal(report.percent, 17);
});

test('derive 报告历史对照里读不到的 PR 和完成后仍在途的 PR', () => {
  const plan = parsePlan(PLAN.replace('| CORE-A | #10 |', '| CORE-A | #10、#99 |'));
  const prs = [...PRS, pr(18, 'fix(CORE-A): 追加', { state: 'OPEN', mergedAt: null })];
  const report = derive({ plan, prs, since: null, generatedAt: 'T', sourceRef: 'test' });
  assert.ok(report.warnings.some((warning) => warning.includes('#99')));
  assert.ok(report.warnings.some((warning) => warning.includes('CORE-A 标为完成')));
});

test('路线图：站点状态、现在在哪一站、等你、排在之后', () => {
  const report = derive({ plan: parsePlan(PLAN), prs: PRS, since: '2026-09-27', generatedAt: 'T', sourceRef: 'test' });
  const roadmap = buildStations(STATIONS, report);
  const byId = Object.fromEntries(roadmap.stations.map((station) => [station.id, station]));
  assert.deepEqual(roadmap.warnings, []);
  assert.equal(byId.base.status, 'done');
  assert.deepEqual(byId.base.shortOf, ['还差美国实测。']);
  assert.equal(byId.ui.status, 'doing');
  assert.equal(byId.pay.status, 'doing');
  assert.deepEqual(byId.pay.waits, ['等你：开通 Waffo 商户。']);
  assert.equal(byId.pay.tasks.find((task) => task.name === 'PAY-WAFFO').word, '等你');
  assert.equal(byId.later.status, 'todo');
  assert.deepEqual(byId.later.after, ['界面']);
  assert.equal(roadmap.currentId, 'ui');
  assert.equal(roadmap.mainCount, 4);
  assert.equal(roadmap.doneCount, 1);
  const missing = buildStations({ stations: STATIONS.stations.slice(1) }, report);
  assert.ok(missing.warnings.some((warning) => warning.includes('CORE-A 没有放进路线图')));
});

test('页面在生成时渲染完整内容，不执行脚本也能看到；PR 标题被转义', () => {
  const report = derive({ plan: parsePlan(PLAN), prs: PRS, since: '2026-09-27', generatedAt: 'T', sourceRef: 'test' });
  const html = renderHtml(report, template, buildStations(STATIONS, report));
  const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/g, '');
  assert.match(withoutScripts, /现在走到第 2 站：<strong>界面<\/strong>/);
  assert.match(withoutScripts, /<b>等你<\/b>开通 Waffo 商户。/);
  assert.match(withoutScripts, /终点站 · 正式上线/);
  assert.match(withoutScripts, /正式上线以后再做/);
  assert.match(withoutScripts, /<span class="big">17%<\/span>/);
  assert.equal((withoutScripts.match(/<article class="card /g) ?? []).length, 7);
  assert.ok(!html.includes('</script><b>'));
  assert.match(html, /&lt;\/script&gt;&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(renderMarkdown(report), /\| PAY-WAFFO \| 被阻塞 \|/);
});

test('仓库里的路线图站点覆盖任务表里的每个任务', () => {
  const plan = parsePlan(readFileSync(join(repoRoot, 'docs/launch/MASTER_PLAN.md'), 'utf8'));
  const stations = JSON.parse(readFileSync(join(repoRoot, 'scripts/plan-progress/stations.json'), 'utf8'));
  const report = derive({ plan, prs: [], since: null, generatedAt: 'T', sourceRef: 'test' });
  assert.deepEqual(buildStations(stations, report).warnings, []);
});

test('仓库里的 MASTER_PLAN 能被解析，任务名唯一', () => {
  const plan = parsePlan(readFileSync(join(repoRoot, 'docs/launch/MASTER_PLAN.md'), 'utf8'));
  assert.ok(plan.tasks.length > 40);
  assert.ok(plan.tasks.some((task) => task.name === 'BILL-PAYG'));
});

test('命令行离线运行，结果只写到仓库外；输出目录在仓库里时拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-progress-test-'));
  const prsFile = join(dir, 'prs.json');
  writeFileSync(prsFile, JSON.stringify(PRS));
  const out = execFileSync(process.execPath, [script, '--prs-file', prsFile, '--out-dir', join(dir, 'out')], { encoding: 'utf8' });
  assert.match(out, /# Master Plan 进度/);
  const report = JSON.parse(readFileSync(join(dir, 'out', 'plan-progress.json'), 'utf8'));
  assert.ok(report.tasks.length > 40);
  const page = readFileSync(join(dir, 'out', 'plan-progress.html'), 'utf8');
  assert.match(page, /<title>Graylum 上线路线图<\/title>/);
  assert.match(page, /<article class="card s-已完成" data-status="已完成">/);

  const insideDir = join(repoRoot, 'scripts', `plan-progress-should-not-exist-${process.pid}`, 'out');
  const inside = spawnSync(process.execPath, [script, '--prs-file', prsFile, '--out-dir', insideDir], { encoding: 'utf8' });
  assert.equal(inside.status, 1);
  assert.match(inside.stderr, /在仓库里面/);
  assert.equal(existsSync(dirname(insideDir)), false);
});
