#!/usr/bin/env node
// 只读生成 Master Plan 进度：读 MASTER_PLAN.md 第 7.1 节任务表，再用 gh 只读取 PR，推导每个任务的阶段。
// 输出：终端 Markdown；JSON 和静态页面写到系统临时目录（不能写进仓库）。不提交、不推送、不改任何文件。
//
//   node scripts/plan-progress.mjs                      # 用工作区里的 MASTER_PLAN.md
//   node scripts/plan-progress.mjs --ref origin/staging # 用某个提交里的 MASTER_PLAN.md
//   node scripts/plan-progress.mjs --out-dir <目录>     # 换输出目录（必须在仓库外）
//   node scripts/plan-progress.mjs --prs-file <json>    # 不访问网络，用保存好的 PR 列表（测试用）
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlan } from './plan-progress/parse-plan.mjs';
import { derive } from './plan-progress/derive.mjs';
import { renderMarkdown } from './plan-progress/render.mjs';
import { renderDetailHtml, renderHtml } from './plan-progress/render-html.mjs';
import { buildStations } from './plan-progress/stations.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const PLAN_PATH = 'docs/launch/MASTER_PLAN.md';
const REPO = 'Crnobog9527/GraylumAI_vercel';
const PR_FIELDS = 'number,title,body,state,isDraft,mergedAt,url,baseRefName';

function parseArgs(argv) {
  const args = { ref: null, outDir: join(tmpdir(), 'graylum-plan-progress'), prsFile: null, limit: 1000 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error(`${flag} 需要一个值`);
      i += 1;
      return next;
    };
    if (flag === '--ref') args.ref = value();
    else if (flag === '--out-dir') args.outDir = resolve(value());
    else if (flag === '--prs-file') args.prsFile = resolve(value());
    else if (flag === '--limit') args.limit = Number(value());
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new Error(`不认识的参数：${flag}`);
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error('--limit 要是正整数');
  return args;
}

// 任务表和路线图站点从同一个来源读取：不给 --ref 时都用工作区，给了 --ref 时都用那个提交。
function readSources(ref) {
  const stationsPath = 'scripts/plan-progress/stations.json';
  if (!ref) {
    return {
      markdown: readFileSync(join(repoRoot, PLAN_PATH), 'utf8'),
      stations: readFileSync(join(repoRoot, stationsPath), 'utf8'),
      sourceRef: `工作区 ${PLAN_PATH}`,
    };
  }
  const git = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const sha = git(['rev-parse', '--short=8', `${ref}^{commit}`]).trim();
  let stations;
  try {
    stations = git(['show', `${ref}:${stationsPath}`]);
  } catch {
    throw new Error(`${ref} 里没有 ${stationsPath}；路线图站点必须和任务表来自同一个提交`);
  }
  return { markdown: git(['show', `${ref}:${PLAN_PATH}`]), stations, sourceRef: `${ref} ${sha}` };
}

function fetchPrs(limit) {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'list', '--repo', REPO, '--state', 'all', '--limit', String(limit), '--json', PR_FIELDS],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return JSON.parse(out);
  } catch (error) {
    const detail = String(error.stderr || error.message).trim().split('\n').slice(-3).join(' / ');
    const reason = error.code === 'ENOENT' ? '找不到 gh 命令' : detail;
    throw new Error(`无法从 GitHub 只读取 PR 列表（${reason}）。请检查网络和 gh auth status；没有写任何文件。`);
  }
}

// 先找到最近的已存在上级目录再判断，避免被拒绝的仓库内目录先被创建出来。
function assertOutsideRepo(dir) {
  let existing = dir;
  while (!existsSync(existing)) existing = dirname(existing);
  const target = join(realpathSync(existing), relative(existing, dir));
  const rel = relative(realpathSync(repoRoot), target);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(`输出目录 ${dir} 在仓库里面；生成结果不能写进仓库，请换到仓库外`);
  }
  mkdirSync(dir, { recursive: true });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).join('\n') + '\n');
    return;
  }
  const { markdown, stations, sourceRef } = readSources(args.ref);
  const plan = parsePlan(markdown);
  const prs = args.prsFile ? JSON.parse(readFileSync(args.prsFile, 'utf8')) : fetchPrs(args.limit);
  if (!args.prsFile && prs.length >= args.limit) {
    throw new Error(`PR 数量达到 --limit ${args.limit}，结果可能不完整；请调大 --limit。没有写任何文件。`);
  }
  const report = derive({
    plan,
    prs,
    since: plan.planSince,
    generatedAt: new Date().toISOString(),
    sourceRef,
  });
  const stationData = JSON.parse(stations);
  const roadmap = buildStations(stationData, report);
  report.warnings.push(...roadmap.warnings);
  report.roadmap = roadmap;
  const template = join(here, 'plan-progress', 'page.html');
  const html = renderHtml(report, template, roadmap);
  const detailHtml = renderDetailHtml(report, template);
  assertOutsideRepo(args.outDir);
  const jsonPath = join(args.outDir, 'plan-progress.json');
  const htmlPath = join(args.outDir, 'plan-progress.html');
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  const detailPath = join(args.outDir, 'plan-progress-detail.html');
  writeFileSync(htmlPath, html);
  writeFileSync(detailPath, detailHtml);
  process.stdout.write(renderMarkdown(report));
  process.stdout.write(`\nJSON：${jsonPath}\n路线图（给 Owner）：${htmlPath}\n明细（给主窗口）：${detailPath}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`plan-progress：${error.message}\n`);
  process.exit(1);
}
